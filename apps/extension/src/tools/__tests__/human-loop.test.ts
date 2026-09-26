import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionPreferenceStore } from "@/lib/interaction-preferences";
import { SessionManager } from "@/session-manager/manager";
import { RefStore } from "@/session-manager/ref-store";
import type { RequestHelpParams } from "@/transport/types";
import { handleRequestHelp, type RequestHelpDeps, resetHelpLifecycleForTests } from "../human-loop";

function chromeEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: T) => {
      listeners.delete(listener);
    }),
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function installHelpLifecycleChrome() {
  const runtimeOnMessage =
    chromeEvent<
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response: unknown) => void,
      ) => unknown
    >();
  const tabsOnActivated = chromeEvent<(activeInfo: chrome.tabs.TabActiveInfo) => unknown>();
  const tabsOnCreated = chromeEvent<(tab: chrome.tabs.Tab) => unknown>();
  const tabsOnUpdated =
    chromeEvent<(tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => unknown>();
  const webNavigationOnCompleted =
    chromeEvent<(details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => unknown>();

  vi.stubGlobal("chrome", {
    runtime: { onMessage: runtimeOnMessage },
    tabs: { onActivated: tabsOnActivated, onCreated: tabsOnCreated, onUpdated: tabsOnUpdated },
    webNavigation: { onCompleted: webNavigationOnCompleted },
  });

  return {
    runtimeOnMessage,
    tabsOnActivated,
    tabsOnCreated,
    tabsOnUpdated,
    webNavigationOnCompleted,
  };
}

function fakeManager(sessionId: string, agentWindowId: number, tabId: number, unattended = false) {
  const refStore = new RefStore();
  const mgr = {
    get: (id: string) =>
      id === sessionId
        ? { sessionId, agentWindowId, refStore, borrowedTabs: new Map(), unattended }
        : null,
    findByWindowId: (wid: number) => (wid === agentWindowId ? { sessionId } : null),
  } as unknown as SessionManager;
  return mgr;
}

function baseParams(over: Partial<RequestHelpParams> = {}): RequestHelpParams {
  return { session_id: "abcd", prompt: "log in", ...over };
}

function baseDeps(over: Partial<RequestHelpDeps> = {}): RequestHelpDeps {
  return {
    tabsApi: {
      get: vi.fn(async () => ({ id: 5, windowId: 99, active: true, title: "Login" }) as never),
      query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
    },
    windows: { update: vi.fn(async () => ({}) as never) },
    activateTab: vi.fn(async () => {}),
    sendToTab: vi.fn(async () => ({ type: "bsk-help-response", outcome: "continued", note: "ok" })),
    cdp: { send: vi.fn(async () => ({})) } as unknown as RequestHelpDeps["cdp"],
    notifications: null,
    autoAttachLifecycle: false,
    ...over,
  };
}

describe("handleRequestHelp", () => {
  afterEach(() => {
    resetHelpLifecycleForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    "continued",
    "cancelled",
  ])("read failure preserves the human wait and %s decision", async (outcome) => {
    const preferences = new InteractionPreferenceStore();
    vi.spyOn(preferences, "ready").mockRejectedValue(new Error("storage unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let respond!: (value: unknown) => void;
    const deps = baseDeps({
      preferences,
      sendToTab: vi.fn((_tab, message) =>
        message.type === "bsk-help-request"
          ? new Promise((resolve) => {
              respond = resolve;
            })
          : Promise.resolve(),
      ),
    });
    let settled = false;
    const pending = handleRequestHelp(fakeManager("abcd", 99, 5), baseParams(), deps).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    expect(settled).toBe(false);
    expect(deps.activateTab).toHaveBeenCalledWith(5);
    respond({ type: "bsk-help-response", outcome });
    expect(await pending).toMatchObject({ outcome, tab_id: 5 });
  });

  it("legacy session metadata cannot disable help on preference read failure", async () => {
    const preferences = new InteractionPreferenceStore();
    const ready = vi
      .spyOn(preferences, "ready")
      .mockRejectedValue(new Error("storage unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = baseDeps({ preferences });
    const result = await handleRequestHelp(fakeManager("abcd", 99, 5, true), baseParams(), deps);
    expect(result).toMatchObject({ outcome: "continued" });
    expect(ready).toHaveBeenCalledOnce();
    expect(deps.sendToTab).toHaveBeenCalled();
    expect(deps.activateTab).toHaveBeenCalledWith(5);
  });

  it.each([false, true])("legacy session metadata cannot disable help (%s)", async (unattended) => {
    const deps = baseDeps();
    expect(
      await handleRequestHelp(fakeManager("abcd", 99, 5, unattended), baseParams(), deps),
    ).toMatchObject({ outcome: "continued" });
    expect(deps.activateTab).toHaveBeenCalledWith(5);
  });

  it("the saved help preference prevents all browser UI work", async () => {
    const preferences = new InteractionPreferenceStore();
    vi.spyOn(preferences, "ready").mockResolvedValue();
    vi.spyOn(preferences, "get").mockReturnValue({
      confirmTabBorrow: true,
      requestHelpEnabled: false,
    });
    const deps = baseDeps({ preferences });
    expect(await handleRequestHelp(fakeManager("abcd", 99, 5), baseParams(), deps)).toMatchObject({
      outcome: "disabled",
    });
    expect(deps.tabsApi.get).not.toHaveBeenCalled();
    expect(deps.sendToTab).not.toHaveBeenCalled();
    expect(deps.windows.update).not.toHaveBeenCalled();
  });

  it.each([
    "continued",
    "cancelled",
  ])("re-enabling help restores the original wait and user %s outcome", async (outcome) => {
    const preferences = new InteractionPreferenceStore();
    let enabled = false;
    vi.spyOn(preferences, "ready").mockResolvedValue();
    vi.spyOn(preferences, "get").mockImplementation(() => ({
      confirmTabBorrow: true,
      requestHelpEnabled: enabled,
    }));
    let respond!: (value: unknown) => void;
    const deps = baseDeps({
      preferences,
      sendToTab: vi.fn((_tab, message) => {
        if (message.type === "bsk-help-request")
          return new Promise((resolve) => {
            respond = resolve;
          });
        return Promise.resolve();
      }),
    });
    const manager = fakeManager("abcd", 99, 5, true);
    const disabled = await handleRequestHelp(manager, baseParams(), deps);
    expect(disabled).toMatchObject({ outcome: "disabled" });
    expect(disabled).not.toHaveProperty("completed_by");
    expect(deps.sendToTab).not.toHaveBeenCalled();

    enabled = true;
    let settled = false;
    const pending = handleRequestHelp(manager, baseParams(), deps).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
    expect(settled).toBe(false);
    expect(deps.windows.update).toHaveBeenCalledWith(99, { focused: true });
    expect(deps.activateTab).toHaveBeenCalledWith(5);
    respond({ type: "bsk-help-response", outcome, note: "User decision" });
    expect(await pending).toMatchObject({ outcome, tab_id: 5, note: "User decision" });
  });

  it("disabling help finishes an already displayed request and removes its overlay", async () => {
    const preferences = new InteractionPreferenceStore();
    let enabled = true;
    let changed!: () => void;
    const unsubscribe = vi.fn();
    vi.spyOn(preferences, "ready").mockResolvedValue();
    vi.spyOn(preferences, "get").mockImplementation(() => ({
      confirmTabBorrow: true,
      requestHelpEnabled: enabled,
    }));
    vi.spyOn(preferences, "subscribe").mockImplementation((listener) => {
      changed = () => listener(preferences.get());
      return unsubscribe;
    });
    const deps = baseDeps({
      preferences,
      sendToTab: vi.fn().mockResolvedValue({ type: "bsk-help-ack", ok: true }),
    });
    const pending = handleRequestHelp(fakeManager("abcd", 99, 5), baseParams(), deps);
    await vi.waitFor(() =>
      expect(deps.sendToTab).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ type: "bsk-help-request" }),
      ),
    );
    enabled = false;
    changed();
    expect(await pending).toMatchObject({ outcome: "disabled" });
    expect(deps.sendToTab).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ type: "bsk-help-cancel" }),
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects unknown session", async () => {
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ session_id: "zzzz" }),
      baseDeps(),
    );
    expect("code" in res && res.code).toBe("not_found");
  });

  it("cleans up late notification and overlay delivery after help is disabled", async () => {
    const preferences = new InteractionPreferenceStore();
    let enabled = true;
    let changed!: () => void;
    vi.spyOn(preferences, "ready").mockResolvedValue();
    vi.spyOn(preferences, "get").mockImplementation(() => ({
      confirmTabBorrow: true,
      requestHelpEnabled: enabled,
    }));
    vi.spyOn(preferences, "subscribe").mockImplementation((listener) => {
      changed = () => listener(preferences.get());
      return () => {};
    });
    let deliverOverlay!: (response: unknown) => void;
    let deliverNotification!: (id: string) => void;
    const notifications = {
      create: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            deliverNotification = resolve;
          }),
      ),
      clear: vi.fn().mockResolvedValue(true),
    };
    const sendToTab = vi.fn().mockImplementation((_id, message) =>
      message.type === "bsk-help-request"
        ? new Promise((resolve) => {
            deliverOverlay = resolve;
          })
        : Promise.resolve(),
    );
    const pending = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams(),
      baseDeps({ preferences, notifications, sendToTab }),
    );
    await vi.waitFor(() => expect(deliverOverlay).toBeTypeOf("function"));
    enabled = false;
    changed();
    expect(await pending).toMatchObject({ outcome: "disabled" });
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledTimes(2));
    deliverOverlay({ type: "bsk-help-ack", ok: true });
    deliverNotification("late-notification");
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledTimes(3));
    expect(notifications.clear).toHaveBeenCalledTimes(2);
    expect(
      sendToTab.mock.calls.filter(([, message]) => message.type === "bsk-help-request"),
    ).toHaveLength(1);
    expect(sendToTab.mock.calls[2][1].type).toBe("bsk-help-cancel");
  });

  it("brings the tab to the foreground and returns the user outcome", async () => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      deps,
    );
    expect(deps.windows.update).toHaveBeenCalledWith(99, { focused: true });
    expect(deps.activateTab).toHaveBeenCalledWith(5);
    expect(res).toMatchObject({ outcome: "continued", note: "ok", tab_id: 5 });
  });

  it("does not refresh observations after the user returns control", async () => {
    const cdpSend = vi.fn(async () => ({}));
    const deps = baseDeps({
      cdp: { send: cdpSend } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5 }),
      deps,
    );

    expect(res).toMatchObject({ outcome: "continued", tab_id: 5 });
    expect(cdpSend).not.toHaveBeenCalledWith(
      expect.any(Number),
      "Accessibility.getFullAXTree",
      expect.anything(),
    );
    expect(cdpSend).not.toHaveBeenCalledWith(
      expect.any(Number),
      "DOMSnapshot.captureSnapshot",
      expect.anything(),
    );
  });

  it("forwards title into the help request message when provided", async () => {
    const deps = baseDeps();
    await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, title: "Complete verification" }),
      deps,
    );
    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg).toMatchObject({
      type: "bsk-help-request",
      prompt: "log in",
      title: "Complete verification",
    });
  });

  it("omits title from the help request message when not provided", async () => {
    const deps = baseDeps();
    await handleRequestHelp(fakeManager("abcd", 99, 5), baseParams({ tab_id: 5 }), deps);
    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg.title).toBeUndefined();
  });

  it("does not complete merely because the tab navigates during the wait", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({
      sendToTab: vi.fn(() => new Promise(() => {})),
    });
    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(5);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ outcome: "timed_out", tab_id: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns timed_out when the wait expires", async () => {
    vi.useFakeTimers();
    try {
      const deps = baseDeps({
        sendToTab: vi.fn(() => new Promise(() => {})), // never resolves
      });
      const p = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(20);
      const res = await p;
      expect(res).toMatchObject({ outcome: "timed_out", tab_id: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep the RPC pending when cleanup hangs after content finishes", async () => {
    vi.useFakeTimers();
    const chromeEvents = installHelpLifecycleChrome();
    const sendToTab = vi.fn(async (_tabId: number, message: { type?: string }) => {
      if (message.type === "bsk-help-request") return { type: "bsk-help-ack", ok: true };
      return new Promise<never>(() => {});
    });
    const deps = baseDeps({ autoAttachLifecycle: undefined, sendToTab });

    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 60_000 }),
        deps,
      );
      await vi.waitFor(() =>
        expect(sendToTab).toHaveBeenCalledWith(
          5,
          expect.objectContaining({ type: "bsk-help-request" }),
        ),
      );

      const request = sendToTab.mock.calls[0]?.[1] as { requestId: string };
      chromeEvents.runtimeOnMessage.emit(
        {
          type: "bsk-help-finish",
          requestId: request.requestId,
          outcome: "continued",
        },
        { tab: { id: 5 } as chrome.tabs.Tab } as chrome.runtime.MessageSender,
        vi.fn(),
      );
      await vi.waitFor(() =>
        expect(sendToTab).toHaveBeenCalledWith(
          5,
          expect.objectContaining({ type: "bsk-help-cancel" }),
        ),
      );

      await vi.advanceTimersByTimeAsync(1_100);
      await expect(pending).resolves.toMatchObject({ outcome: "continued", tab_id: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "content",
    "timeout",
    "abort",
  ] as const)("cancels all help overlays when notification cleanup hangs (%s)", async (finishPath) => {
    vi.useFakeTimers();
    const chromeEvents = installHelpLifecycleChrome();
    const abort = new AbortController();
    const sendToTab = vi.fn(async (_tabId: number, _message: { requestId: string }) => ({
      type: "bsk-help-ack",
      ok: true,
    }));
    const notifications = {
      create: vi.fn(async (id: string) => id),
      clear: vi.fn(() => new Promise<boolean>(() => {})),
    };
    const deps = baseDeps({
      autoAttachLifecycle: undefined,
      sendToTab,
      notifications,
      signal: abort.signal,
      tabsApi: {
        get: vi.fn(async (id: number) => ({ id, windowId: 99, active: id === 5 }) as never),
        query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
      },
    });

    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 60_000 }),
        deps,
      );
      await vi.waitFor(() =>
        expect(sendToTab).toHaveBeenCalledWith(
          5,
          expect.objectContaining({ type: "bsk-help-request" }),
        ),
      );
      const { requestId } = sendToTab.mock.calls[0][1];
      chromeEvents.tabsOnCreated.emit({ id: 6, windowId: 99 } as chrome.tabs.Tab);
      await vi.advanceTimersByTimeAsync(200);
      expect(sendToTab).toHaveBeenCalledWith(
        6,
        expect.objectContaining({ type: "bsk-help-request", requestId }),
      );

      if (finishPath === "content") {
        chromeEvents.runtimeOnMessage.emit(
          { type: "bsk-help-finish", requestId, outcome: "continued" },
          { tab: { id: 5 } as chrome.tabs.Tab } as chrome.runtime.MessageSender,
          vi.fn(),
        );
      } else if (finishPath === "abort") {
        abort.abort();
      } else {
        await vi.advanceTimersByTimeAsync(60_000);
      }

      await vi.advanceTimersByTimeAsync(1_100);
      const expected = {
        content: { outcome: "continued" },
        timeout: { outcome: "timed_out" },
        abort: { code: "cancelled" },
      }[finishPath];
      await expect(pending).resolves.toMatchObject(expected);
      expect(notifications.clear).toHaveBeenCalledWith(`bsk-help:${requestId}`);
      for (const tabId of [5, 6]) {
        expect(sendToTab).toHaveBeenCalledWith(tabId, { type: "bsk-help-cancel", requestId });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns completed when explicit completion criteria match", async () => {
    const deps = baseDeps({
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
      cdp: {
        send: vi.fn(async (_tabId: number, method: string) => {
          if (method === "Runtime.evaluate") return { result: { value: true } };
          return {};
        }),
      } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({
        tab_id: 5,
        completion_criteria: {
          any: [{ selector_exists: "#account-menu" }],
          stable_for_ms: 0,
        },
      }),
      deps,
    );
    expect(res).toMatchObject({ outcome: "completed", completed_by: "system", tab_id: 5 });
  });

  it.skipIf(process.env.BSK_URL_REGEX_CHILD === "1")(
    "bounds dangerous URL regex checks in a child process",
    () => {
      const require = createRequire(import.meta.url);
      const vitestCli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
      const child = spawnSync(
        process.execPath,
        [
          vitestCli,
          "run",
          fileURLToPath(import.meta.url),
          "-t",
          "isolated dangerous URL regex checks",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, BSK_URL_REGEX_CHILD: "1" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(child.error, `${child.stdout}\n${child.stderr}`).toBeUndefined();
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    },
  );

  it.skipIf(process.env.BSK_URL_REGEX_CHILD !== "1")(
    "isolated dangerous URL regex checks",
    async () => {
      const url = `https://app.example/${"a".repeat(28)}!`;
      const deps = baseDeps({
        sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
        tabsApi: {
          get: vi.fn(async () => ({ id: 5, windowId: 99, active: true, url })) as never,
          query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
        },
      });
      const started = performance.now();
      const res = await handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({
          completion_criteria: {
            any: [{ url_matches: "(a+)+$" }, { url_matches: "^https://app.example/a+!$" }],
            stable_for_ms: 0,
          },
        }),
        deps,
      );
      expect(res).toMatchObject({ outcome: "completed", completed_by: "system" });
      expect(performance.now() - started).toBeLessThan(1_000);

      const expanded = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({
          completion_criteria: { any: [{ url_matches: `(?:${"[ab]".repeat(20)}){1000}$` }] },
        }),
        deps,
      );
      await expect(expanded).resolves.toMatchObject({ code: "invalid_params" });

      const nearLimit = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({
          completion_criteria: { any: [{ url_matches: `(?:${"a".repeat(118)}){1000}` }] },
        }),
        deps,
      );
      await expect(nearLimit).resolves.toMatchObject({ code: "invalid_params" });
    },
  );

  it.each([
    { label: "unsupported lookahead", pattern: "(?=a)" },
    { label: "unsupported lookbehind", pattern: "(?<=a)b" },
    { label: "unsupported Unicode escape", pattern: "\\u0061" },
    { label: "unsupported large repetition", pattern: "a{1001}" },
    { label: "unsupported empty negated class", pattern: "[^]" },
    { label: "unsupported backreference", pattern: "(a)\\1" },
    { label: "oversized pattern", pattern: "a".repeat(129) },
  ])("rejects $label before starting help", async ({ pattern }) => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ completion_criteria: { any: [{ url_matches: pattern }] } }),
      deps,
    );
    expect(res).toMatchObject({ code: "invalid_params" });
    expect(deps.activateTab).not.toHaveBeenCalled();
    expect(deps.sendToTab).not.toHaveBeenCalled();
  });

  it("rejects too many conditions before starting help", async () => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({
        completion_criteria: {
          all: Array.from({ length: 5 }, () => ({ url_contains: "/done" })),
          any: Array.from({ length: 4 }, () => ({ selector_exists: "#done" })),
        },
      }),
      deps,
    );
    expect(res).toMatchObject({ code: "invalid_params" });
    expect(deps.tabsApi.get).not.toHaveBeenCalled();
    expect(deps.sendToTab).not.toHaveBeenCalled();
  });

  it("rejects patterns whose total compiled program is too large", async () => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({
        completion_criteria: {
          all: ["[ab]", "[ac]", "[ad]"].map((part) => ({
            url_matches: `(?:${part.repeat(3)}){1000}`,
          })),
        },
      }),
      deps,
    );
    expect(res).toMatchObject({ code: "invalid_params" });
    expect(deps.activateTab).not.toHaveBeenCalled();
  });

  it("charges repeated URL patterns once per condition", async () => {
    const deps = baseDeps();
    const pattern = "a.{1000}.{1000}.{1000}.{996}[#%]";
    const single = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ completion_criteria: { all: [{ url_matches: pattern }] } }),
      deps,
    );
    expect(single).toMatchObject({ outcome: "continued" });

    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({
        completion_criteria: {
          all: Array.from({ length: 8 }, () => ({ url_matches: pattern })),
        },
      }),
      deps,
    );
    expect(res).toMatchObject({ code: "invalid_params" });
    expect(deps.activateTab).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "null", urlMatches: null },
    { label: "empty", urlMatches: "" },
    { label: "omitted", urlMatches: undefined },
  ])("treats $label URL regex as absent", async ({ urlMatches }) => {
    const deps = baseDeps({
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
      tabsApi: {
        get: vi.fn(async () => ({
          id: 5,
          windowId: 99,
          active: true,
          url: "https://app.example/done",
        })) as never,
        query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
      },
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({
        completion_criteria: {
          any: [{ url_matches: urlMatches, url_contains: "/done" }],
          stable_for_ms: 0,
        },
      }),
      deps,
    );
    expect(res).toMatchObject({ outcome: "completed" });
  });

  it.each([
    { label: "unanchored substring", pattern: "/done" },
    { label: "start and end anchors", pattern: "^https://app\\.example/done$" },
  ])("matches a normal URL with $label", async ({ pattern }) => {
    const deps = baseDeps({
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
      tabsApi: {
        get: vi.fn(async () => ({
          id: 5,
          windowId: 99,
          active: true,
          url: "https://app.example/done",
        })) as never,
        query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
      },
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ completion_criteria: { any: [{ url_matches: pattern }], stable_for_ms: 0 } }),
      deps,
    );
    expect(res).toMatchObject({ outcome: "completed" });
  });

  it("does not match an anchored regex against a different URL", async () => {
    const abort = new AbortController();
    const tabsApi = {
      get: vi.fn(async () => ({
        id: 5,
        windowId: 99,
        active: true,
        url: "https://app.example/done/next",
      })) as never,
      query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
    };
    const deps = baseDeps({
      signal: abort.signal,
      tabsApi,
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
    });
    const pending = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ completion_criteria: { any: [{ url_matches: "/done$" }], stable_for_ms: 0 } }),
      deps,
    );
    await vi.waitFor(() => expect(tabsApi.get).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
  });

  it.each([
    { label: "url_contains", condition: { url_contains: "/done" } },
    { label: "url_matches", condition: { url_matches: "/done" } },
  ])("keeps waiting for manual control when a URL exceeds the $label limit", async ({
    condition,
  }) => {
    const abort = new AbortController();
    const tabsApi = {
      get: vi.fn(async () => ({
        id: 5,
        windowId: 99,
        active: true,
        url: `https://app.example/done?${"x".repeat(8_192)}`,
      })) as never,
      query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
    };
    const deps = baseDeps({
      signal: abort.signal,
      tabsApi,
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
    });
    const pending = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ completion_criteria: { any: [condition], stable_for_ms: 0 } }),
      deps,
    );
    await vi.waitFor(() => expect(tabsApi.get).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
  });

  it("handles cancellation after later URL completion polls", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const get = vi.fn(async () => ({
      id: 5,
      windowId: 99,
      active: true,
      url: "https://app.example/wait",
    }));
    const tabsApi = {
      get: get as never,
      query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
    };
    const deps = baseDeps({
      signal: abort.signal,
      tabsApi,
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
    });
    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ completion_criteria: { any: [{ url_matches: "/done$" }] } }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(1_100);
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(3);
      abort.abort();
      await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap completion checks while an earlier check is pending", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let releaseCheck!: (value: { result: { value: boolean } }) => void;
    const evaluation = new Promise<{ result: { value: boolean } }>((resolve) => {
      releaseCheck = resolve;
    });
    const send = vi.fn((_tabId: number, method: string) =>
      method === "Runtime.evaluate" ? evaluation : Promise.resolve({}),
    );
    const deps = baseDeps({
      signal: abort.signal,
      cdp: { send } as unknown as RequestHelpDeps["cdp"],
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
    });
    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ completion_criteria: { any: [{ selector_exists: "#done" }] } }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(send.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(send.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(1);
      abort.abort();
      releaseCheck({ result: { value: true } });
      await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps user control active on new tabs without moving completion off the primary tab", async () => {
    vi.useFakeTimers();
    const chromeEvents = installHelpLifecycleChrome();
    const sendToTab = vi.fn(async () => ({ type: "bsk-help-ack", ok: true }));
    const deps = baseDeps({
      autoAttachLifecycle: undefined,
      sendToTab,
      tabsApi: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 99,
          active: tabId === 6,
          url: tabId === 6 ? "https://app.example/reset/success" : "https://app.example/login",
        })) as never,
        query: vi.fn(async () => [{ id: 5, windowId: 99, active: true }] as never),
      },
    });

    try {
      const pending = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({
          tab_id: 5,
          timeout_ms: 1_000,
          completion_criteria: {
            any: [{ url_contains: "/reset/success" }],
            stable_for_ms: 0,
          },
        }),
        deps,
      );
      await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledWith(5, expect.anything()));

      chromeEvents.tabsOnActivated.emit({ tabId: 6, windowId: 99 });
      await vi.advanceTimersByTimeAsync(200);

      await vi.waitFor(() =>
        expect(sendToTab).toHaveBeenCalledWith(
          6,
          expect.objectContaining({
            type: "bsk-help-request",
            displayMode: "compact",
            selectors: [],
          }),
        ),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        outcome: "timed_out",
        tab_id: 5,
      });
      expect(sendToTab).toHaveBeenCalledWith(
        6,
        expect.objectContaining({ type: "bsk-help-cancel" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets same-window tabs query active help after content-script load", async () => {
    const chromeEvents = installHelpLifecycleChrome();
    const ac = new AbortController();
    const cdpSend = vi.fn(async () => ({ root: { nodeId: 1 }, nodeIds: [] }));
    const deps = baseDeps({
      autoAttachLifecycle: undefined,
      signal: ac.signal,
      sendToTab: vi.fn(async () => ({ type: "bsk-help-ack", ok: true })),
      cdp: {
        send: cdpSend,
      } as unknown as RequestHelpDeps["cdp"],
    });

    const pending = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, timeout_ms: 60_000 }),
      deps,
    );
    await vi.waitFor(() => expect(deps.sendToTab).toHaveBeenCalledWith(5, expect.anything()));

    const sameWindowResponse = vi.fn();
    chromeEvents.runtimeOnMessage.emit(
      { type: "bsk-help-query" },
      { tab: { id: 6 } as chrome.tabs.Tab },
      sameWindowResponse,
    );
    await vi.waitFor(() =>
      expect(sameWindowResponse).toHaveBeenCalledWith({
        active: true,
        request: expect.objectContaining({
          requestId: expect.any(String),
          prompt: "log in",
          displayMode: "compact",
          selectors: [],
        }),
      }),
    );

    const subjectResponse = vi.fn();
    chromeEvents.runtimeOnMessage.emit(
      { type: "bsk-help-query" },
      { tab: { id: 5 } as chrome.tabs.Tab },
      subjectResponse,
    );
    await vi.waitFor(() =>
      expect(subjectResponse).toHaveBeenCalledWith({
        active: true,
        request: expect.objectContaining({
          requestId: expect.any(String),
          prompt: "log in",
          displayMode: "full",
        }),
      }),
    );

    ac.abort();
    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    expect(cdpSend).not.toHaveBeenCalledWith(
      expect.anything(),
      "DOM.removeAttribute",
      expect.anything(),
    );
  });

  it("resolves ref targets to explicit viewport rectangles without mutating the page", async () => {
    const refStore = new RefStore();
    refStore.set("e1", 42, { tabId: 5 });
    const mgr = {
      get: (id: string) =>
        id === "abcd"
          ? {
              sessionId: "abcd",
              agentWindowId: 99,
              refStore,
              borrowedTabs: new Map(),
            }
          : null,
      findByWindowId: (wid: number) => (wid === 99 ? { sessionId: "abcd" } : null),
    } as unknown as SessionManager;
    const deps = baseDeps({
      cdp: {
        send: vi.fn(async (_tabId, method) => {
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
          if (method === "DOM.scrollIntoViewIfNeeded") return {};
          if (method === "DOM.getContentQuads") {
            return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
          }
          if (method === "Page.getLayoutMetrics") {
            return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
          }
          throw new Error(`unexpected ${method}`);
        }),
      } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      mgr,
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );
    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg.selectors).toEqual([]);
    expect(sentMsg.rects).toEqual([{ top: 20, left: 10, width: 100, height: 40 }]);
    expect(res).toMatchObject({
      outcome: "continued",
      tab_id: 5,
      resolved_targets: [
        {
          matched: true,
          ref: "@e1",
        },
      ],
    });
  });

  it("projects an OOPIF ref through its live content quad for the help overlay", async () => {
    const mgr = {
      get: (id: string) =>
        id === "abcd"
          ? {
              sessionId: "abcd",
              agentWindowId: 99,
              refStore: {
                resolveEntry: () => ({
                  kind: "dom",
                  backendNodeId: 42,
                  tabId: 5,
                  frameId: "child",
                  cdpSessionId: "child-session",
                  generation: 1,
                }),
              },
              borrowedTabs: new Map(),
            }
          : null,
      findByWindowId: (wid: number) => (wid === 99 ? { sessionId: "abcd" } : null),
    } as unknown as SessionManager;
    const send = vi.fn(async (_tabId, method) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.getBoxModel") {
        return { model: { content: [204, 306, 604, 306, 604, 506, 204, 506] } };
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      }
      throw new Error(`unexpected root ${method}`);
    });
    const sendToTarget = vi.fn(async (_target, method) => {
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.getContentQuads") {
        return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
      }
      if (method === "Runtime.evaluate") return { result: { value: { width: 200, height: 100 } } };
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 200, clientHeight: 100 } };
      }
      throw new Error(`unexpected child ${method}`);
    });
    const deps = baseDeps({
      cdp: {
        send,
        sendToTarget,
        getFrameGraph: vi.fn(async () => ({
          rootFrameId: "main",
          frames: [
            { frameId: "main", target: { tabId: 5 } },
            {
              frameId: "child",
              parentFrameId: "main",
              ownerBackendNodeId: 99,
              target: { tabId: 5, sessionId: "child-session" },
            },
          ],
        })),
      } as unknown as NonNullable<RequestHelpDeps["cdp"]>,
    });

    const res = await handleRequestHelp(
      mgr,
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );

    const sentMsg = (deps.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(sentMsg.rects).toEqual([{ top: 346, left: 224, width: 200, height: 80 }]);
    expect(res).toMatchObject({ resolved_targets: [{ matched: true, ref: "@e1" }] });
    expect(sendToTarget).toHaveBeenCalledWith(
      { tabId: 5, sessionId: "child-session" },
      "DOM.getContentQuads",
      { backendNodeId: 42 },
    );
  });

  it("reports ref target unmatched when ref does not resolve", async () => {
    const deps = baseDeps();
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );
    expect(res).toMatchObject({
      outcome: "continued",
      resolved_targets: [{ matched: false, ref: "@e1" }],
    });
    expect("code" in res).toBe(false);
  });

  it("reports ref target unmatched when ref is for another tab", async () => {
    const refStore = new RefStore();
    refStore.set("e1", 42, { tabId: 4 });
    const mgr = {
      get: (id: string) =>
        id === "abcd"
          ? {
              sessionId: "abcd",
              agentWindowId: 99,
              refStore,
              borrowedTabs: new Map(),
            }
          : null,
      findByWindowId: (wid: number) => (wid === 99 ? { sessionId: "abcd" } : null),
    } as unknown as SessionManager;
    const deps = baseDeps();
    const res = await handleRequestHelp(
      mgr,
      baseParams({ tab_id: 5, targets: [{ ref: "@e1" }] }),
      deps,
    );
    expect(res).toMatchObject({
      outcome: "continued",
      resolved_targets: [{ matched: false, ref: "@e1" }],
    });
    expect("code" in res).toBe(false);
  });

  it("keeps waiting when the initial overlay delivery rejects", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({
      sendToTab: vi.fn(async () => {
        throw new Error("no receiver");
      }),
    });
    try {
      const res = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(20);
      await expect(res).resolves.toMatchObject({ outcome: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting for explicit completion after a malformed help response", async () => {
    vi.useFakeTimers();
    const deps = baseDeps({ sendToTab: vi.fn(async () => undefined) });
    try {
      const res = handleRequestHelp(
        fakeManager("abcd", 99, 5),
        baseParams({ tab_id: 5, timeout_ms: 10 }),
        deps,
      );
      await vi.advanceTimersByTimeAsync(20);
      await expect(res).resolves.toMatchObject({ outcome: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports selector match status from CDP", async () => {
    const cdpFor = (querySelectorNodeId: number) =>
      ({
        send: vi.fn(async (_tabId: number, method: string) => {
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
          if (method === "DOM.querySelector") return { nodeId: querySelectorNodeId };
          return {};
        }),
      }) as unknown as RequestHelpDeps["cdp"];

    const miss = baseDeps({ cdp: cdpFor(0) });
    const resMiss = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ selector: "#x" }] }),
      miss,
    );
    expect(resMiss).toMatchObject({
      resolved_targets: [{ matched: false, selector: "#x" }],
    });

    const hit = baseDeps({ cdp: cdpFor(42) });
    const resHit = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ selector: "#x" }] }),
      hit,
    );
    expect(resHit).toMatchObject({
      resolved_targets: [{ matched: true, selector: "#x" }],
    });
  });

  it("marks selector unmatched when CDP cannot resolve the document root", async () => {
    const deps = baseDeps({
      cdp: {
        send: vi.fn(async (_tabId: number, method: string) => {
          if (method === "DOM.getDocument") throw new Error("no document");
          return {};
        }),
      } as unknown as RequestHelpDeps["cdp"],
    });
    const res = await handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, targets: [{ selector: "#x" }] }),
      deps,
    );
    expect(res).toMatchObject({
      resolved_targets: [{ matched: false, selector: "#x" }],
    });
  });

  it("returns cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    const deps = baseDeps({ signal: ac.signal, sendToTab: vi.fn(() => new Promise(() => {})) });
    const p = handleRequestHelp(
      fakeManager("abcd", 99, 5),
      baseParams({ tab_id: 5, timeout_ms: 60_000 }),
      deps,
    );
    ac.abort();
    const res = await p;
    expect("code" in res ? res.code : (res as { outcome: string }).outcome).toMatch(/cancelled/);
  });
});
