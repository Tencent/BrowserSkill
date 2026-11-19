import { i18n } from "@browser-skill/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAEMON_PORT } from "@/transport/daemon-endpoint";
import type { SnapshotInfo } from "../connection-controller";
import { watchDaemonPort } from "../daemon-port-preference";
import { attachDaemonUpgradeNotice } from "../daemon-upgrade-notice";
import { STORAGE_KEYS } from "../instance-id";
import {
  DEFAULT_INTERACTION_PREFERENCES,
  INTERACTION_STORAGE_KEY,
  InteractionPreferenceStore,
  interactionPolicy,
  normalizeInteractionPreferences,
} from "../interaction-preferences";

describe("watchDaemonPort", () => {
  function storage() {
    let read!: (items: Record<string, unknown>) => void;
    let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {},
      storage: {
        local: {
          get: (_: string, cb: typeof read) => {
            read = cb;
          },
        },
        onChanged: {
          addListener: (cb: typeof changed) => {
            changed = cb;
          },
          removeListener,
        },
      },
    });
    return {
      read: (value: unknown) => read({ [STORAGE_KEYS.DAEMON_PORT]: value }),
      change: (value: unknown, area = "local") =>
        changed({ [STORAGE_KEYS.DAEMON_PORT]: { newValue: value } }, area),
      removeListener,
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("uses the latest change instead of a late initial read", async () => {
    const store = storage();
    const onPort = vi.fn();
    const watch = watchDaemonPort(onPort);
    store.change(53200);
    store.change(53300);
    store.read(DEFAULT_DAEMON_PORT);
    await watch.ready;
    expect(onPort.mock.calls).toEqual([[53200], [53300]]);
    watch.dispose();
    expect(store.removeListener).toHaveBeenCalledOnce();
  });

  it("normalizes removed, malformed and numeric-string values consistently", async () => {
    const store = storage();
    const onPort = vi.fn();
    const watch = watchDaemonPort(onPort);
    store.read("53200");
    await watch.ready;
    store.change(53300, "sync");
    store.change(undefined);
    store.change("53200abc");
    store.change("53400");
    expect(onPort.mock.calls).toEqual([
      [53200],
      [DEFAULT_DAEMON_PORT],
      [DEFAULT_DAEMON_PORT],
      [53400],
    ]);
    watch.dispose();
  });

  it("does not deliver an initial read after disposal", async () => {
    const store = storage();
    const onPort = vi.fn();
    const watch = watchDaemonPort(onPort);
    watch.dispose();
    store.read(53200);
    await watch.ready;
    expect(onPort).not.toHaveBeenCalled();
  });
});

describe("attachDaemonUpgradeNotice", () => {
  const upgrade = {
    daemonVersion: "0.3.3",
    daemonProtocolVersion: "1.3",
    requiredProtocolVersion: "1.5",
  };
  const clean: SnapshotInfo = {
    state: "disconnected",
    instanceId: "test-browser",
    label: "Test",
    extensionVersion: "0.4.0",
    handshake: null,
    lastError: null,
    connectionEnabled: true,
  };
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.unstubAllGlobals();
  });

  function event<T extends unknown[]>() {
    const listeners = new Set<(...args: T) => void>();
    return {
      addListener: (listener: (...args: T) => void) => listeners.add(listener),
      removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
      emit: (...args: T) => {
        for (const listener of listeners) listener(...args);
      },
    };
  }

  function fixture(saved: Record<string, unknown> = {}) {
    let snapshot = { ...clean };
    let listener: (next: SnapshotInfo) => void = () => {};
    let recording = false;
    let endpoint = `local:${DEFAULT_DAEMON_PORT}`;
    const action = {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      openPopup: vi.fn(async () => {}),
    };
    const notifications = {
      create: vi.fn(async () => "bsk-daemon-upgrade-required"),
      clear: vi.fn(async () => true),
      onClicked: event<[string]>(),
      onButtonClicked: event<[string, number]>(),
    };
    const storage = {
      session: {
        get: vi.fn(async (_key: string) => ({ ...saved })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(saved, values);
        }),
      },
    };
    const tabs = { create: vi.fn(async () => ({})) };
    vi.stubGlobal("chrome", {
      action,
      notifications,
      storage,
      tabs,
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    });
    const notice = attachDaemonUpgradeNotice({
      controller: {
        snapshot: () => snapshot,
        subscribe: (next) => {
          listener = next;
          listener(snapshot);
          return () => {};
        },
      },
      connectionKey: () => endpoint,
      isRecording: () => recording,
    });
    disposers.push(notice.dispose);
    return {
      action,
      notifications,
      storage,
      tabs,
      notice,
      update: async (patch: Partial<SnapshotInfo>) => {
        snapshot = { ...snapshot, ...patch };
        listener(snapshot);
        await notice.refresh();
      },
      setRecording: async (value: boolean) => {
        recording = value;
        await notice.refresh();
      },
      setEndpoint: async (value: string) => {
        endpoint = value;
        await notice.refresh();
      },
    };
  }

  it("keeps the upgrade badge above REC, notifies once during retries, and recovers", async () => {
    const f = fixture();
    await f.update({ daemonUpgradeRequired: upgrade });
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
    expect(f.action.setTitle).toHaveBeenLastCalledWith({
      title: i18n.t("popup.daemonUpgrade.toolbarTitle", { ns: "extension" }),
    });
    await f.setRecording(true);
    await f.update({ state: "connecting" });
    await f.update({ state: "disconnected" });
    await f.setRecording(false);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
    expect(f.notifications.create).toHaveBeenCalledTimes(1);
    await f.setRecording(true);
    await f.update({ state: "connected", daemonUpgradeRequired: null });
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "REC" });
    expect(f.action.setTitle).toHaveBeenLastCalledWith({ title: "BrowserSkill" });
    expect(f.notifications.clear).toHaveBeenCalledWith("bsk-daemon-upgrade-required");
    await f.setRecording(false);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("retains deduplication across worker restarts without hiding another daemon's problem", async () => {
    const saved: Record<string, unknown> = {};
    const first = fixture(saved);
    await first.update({ daemonUpgradeRequired: upgrade });
    expect(first.notifications.create).toHaveBeenCalledTimes(1);
    first.notice.dispose();
    const second = fixture(saved);
    await second.notice.refresh();
    expect(second.notifications.clear).not.toHaveBeenCalled();
    await second.update({ daemonUpgradeRequired: upgrade });
    expect(second.notifications.create).not.toHaveBeenCalled();
    expect(second.notifications.clear).not.toHaveBeenCalled();
    expect(second.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
    await second.setEndpoint("remote:server:device");
    expect(second.notifications.create).toHaveBeenCalledTimes(1);
  });

  it("does not label ordinary disconnection as an upgrade or notify after disabling", async () => {
    const f = fixture();
    await f.update({ lastError: "Connection refused" });
    expect(f.notifications.create).not.toHaveBeenCalled();
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    await f.update({ daemonUpgradeRequired: upgrade, connectionEnabled: false });
    expect(f.notifications.create).not.toHaveBeenCalled();
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("keeps the badge and avoids notification storms when notifications fail", async () => {
    const f = fixture();
    f.notifications.create.mockRejectedValueOnce(new Error("Notifications disabled"));
    await f.update({ daemonUpgradeRequired: upgrade });
    await f.update({ state: "connecting" });
    expect(f.notifications.create).toHaveBeenCalledTimes(1);
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  });

  it("does not publish an outdated notice after a pending storage read", async () => {
    const f = fixture();
    let resolve!: (value: Record<string, unknown>) => void;
    f.storage.session.get.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const failed = f.update({ daemonUpgradeRequired: upgrade });
    await vi.waitFor(() => expect(f.storage.session.get).toHaveBeenCalledTimes(1));
    const recovered = f.update({ state: "connected", daemonUpgradeRequired: null });
    resolve({});
    await Promise.all([failed, recovered]);
    expect(f.notifications.create).not.toHaveBeenCalled();
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("clears an outdated notification if recovery occurs while Chrome creates it", async () => {
    const f = fixture();
    let resolve!: (value: string) => void;
    f.notifications.create.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const failed = f.update({ daemonUpgradeRequired: upgrade });
    await vi.waitFor(() => expect(f.notifications.create).toHaveBeenCalledTimes(1));
    const recovered = f.update({ state: "connected", daemonUpgradeRequired: null });
    resolve("bsk-daemon-upgrade-required");
    await Promise.all([failed, recovered]);
    expect(f.notifications.clear).toHaveBeenCalledWith("bsk-daemon-upgrade-required");
    expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("opens upgrade instructions on click, with a tab fallback on older Chromium", async () => {
    const f = fixture();
    await f.update({ daemonUpgradeRequired: upgrade });
    f.notifications.onClicked.emit("unrelated");
    expect(f.action.openPopup).not.toHaveBeenCalled();
    f.notifications.onClicked.emit("bsk-daemon-upgrade-required");
    await vi.waitFor(() => expect(f.action.openPopup).toHaveBeenCalledTimes(1));
    f.action.openPopup.mockRejectedValueOnce(new Error("Not available"));
    f.notifications.onButtonClicked.emit("bsk-daemon-upgrade-required", 0);
    await vi.waitFor(() =>
      expect(f.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test/popup.html" }),
    );
  });
});

describe("interaction preferences", () => {
  let listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  let addListener: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    addListener = vi.fn((callback: typeof listener) => {
      listener = callback;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("chrome", {
      storage: {
        onChanged: {
          addListener,
        },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to enabled prompts at runtime but keeps reads and writes strict", async () => {
    const storage = {
      get: vi.fn().mockRejectedValue(new Error("read failed")),
      set: vi.fn(),
    };
    const store = new InteractionPreferenceStore(storage);
    await store.readyOrFallback();
    expect(store.get()).toEqual(DEFAULT_INTERACTION_PREFERENCES);
    await expect(store.ready()).rejects.toThrow("read failed");
    await expect(store.set({ confirmTabBorrow: false, requestHelpEnabled: false })).rejects.toThrow(
      "read failed",
    );
    expect(storage.set).not.toHaveBeenCalled();
    expect(addListener).toHaveBeenCalledOnce();
  });

  it("retries a failed read and shares the retry between concurrent callers", async () => {
    const storage = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({
          [INTERACTION_STORAGE_KEY]: { confirmTabBorrow: false, requestHelpEnabled: false },
        }),
      set: vi.fn(),
    };
    const store = new InteractionPreferenceStore(storage);
    await store.readyOrFallback();
    await Promise.all([store.ready(), store.ready(), store.readyOrFallback()]);
    expect(store.get()).toEqual({ confirmTabBorrow: false, requestHelpEnabled: false });
    expect(storage.get).toHaveBeenCalledTimes(2);
    expect(addListener).toHaveBeenCalledOnce();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("a later storage event restores readiness (enabled=%s)", async (enabled) => {
    const storage = { get: vi.fn().mockRejectedValue(new Error("failed")), set: vi.fn() };
    const store = new InteractionPreferenceStore(storage);
    await expect(store.ready()).rejects.toThrow("failed");
    const preferences = { confirmTabBorrow: enabled, requestHelpEnabled: enabled };
    listener({ [INTERACTION_STORAGE_KEY]: { newValue: preferences } }, "local");
    await store.ready();
    expect(store.get()).toEqual(preferences);
    expect(storage.get).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledOnce();
  });

  it("keeps a valid storage event when the pending read rejects", async () => {
    let reject!: (error: Error) => void;
    const store = new InteractionPreferenceStore({
      get: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
      set: vi.fn(),
    });
    const pending = store.ready();
    listener({ [INTERACTION_STORAGE_KEY]: { newValue: { requestHelpEnabled: false } } }, "local");
    reject(new Error("late failure"));
    await pending;
    expect(store.get()).toEqual({ confirmTabBorrow: true, requestHelpEnabled: false });
  });

  it("does not replace a newer storage event with a stale retry result", async () => {
    let read!: (items: Record<string, unknown>) => void;
    const storage = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error("failed"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              read = resolve;
            }),
        ),
      set: vi.fn(),
    };
    const store = new InteractionPreferenceStore(storage);
    await store.readyOrFallback();
    const retry = store.ready();
    listener({ [INTERACTION_STORAGE_KEY]: { newValue: { confirmTabBorrow: false } } }, "local");
    read({ [INTERACTION_STORAGE_KEY]: DEFAULT_INTERACTION_PREFERENCES });
    await retry;
    expect(store.get()).toEqual({ confirmTabBorrow: false, requestHelpEnabled: true });
    expect(addListener).toHaveBeenCalledOnce();
  });

  it("keeps both prompts enabled unless explicitly disabled", () => {
    for (const value of [
      null,
      undefined,
      {},
      { confirmTabBorrow: 0, requestHelpEnabled: "false" },
    ]) {
      expect(normalizeInteractionPreferences(value)).toEqual(DEFAULT_INTERACTION_PREFERENCES);
    }
    expect(normalizeInteractionPreferences({ confirmTabBorrow: false })).toEqual({
      confirmTabBorrow: false,
      requestHelpEnabled: true,
    });
  });

  it("a storage change wins over a stale initial read", async () => {
    let read!: (items: Record<string, unknown>) => void;
    const store = new InteractionPreferenceStore({
      get: () =>
        new Promise((resolve) => {
          read = resolve;
        }),
      set: vi.fn(),
    });
    const ready = store.ready();
    listener({ [INTERACTION_STORAGE_KEY]: { newValue: { confirmTabBorrow: false } } }, "local");
    read({ [INTERACTION_STORAGE_KEY]: DEFAULT_INTERACTION_PREFERENCES });
    await ready;
    expect(store.get().confirmTabBorrow).toBe(false);
  });

  it("a failed save preserves the previous policy", async () => {
    const store = new InteractionPreferenceStore({
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockRejectedValue(new Error("disk full")),
    });
    await expect(store.set({ confirmTabBorrow: false, requestHelpEnabled: false })).rejects.toThrow(
      "disk full",
    );
    expect(store.get()).toEqual(DEFAULT_INTERACTION_PREFERENCES);
  });

  it("does not overwrite a newer storage event when a write finishes late", async () => {
    let written!: () => void;
    const store = new InteractionPreferenceStore({
      get: vi.fn().mockResolvedValue({}),
      set: () =>
        new Promise((resolve) => {
          written = resolve;
        }),
    });
    await store.ready();
    const pending = store.set({ confirmTabBorrow: false, requestHelpEnabled: true });
    await vi.waitFor(() => expect(written).toBeDefined());
    listener(
      {
        [INTERACTION_STORAGE_KEY]: {
          newValue: { confirmTabBorrow: true, requestHelpEnabled: false },
        },
      },
      "local",
    );
    written();
    await pending;
    expect(store.get()).toEqual({ confirmTabBorrow: true, requestHelpEnabled: false });
  });

  it.each([
    [true, true, "always", "enabled"],
    [true, false, "always", "disabled"],
    [false, true, "never", "enabled"],
    [false, false, "never", "disabled"],
  ] as const)("browser settings independently decide both prompts (%s, %s)", (confirmTabBorrow, requestHelpEnabled, borrow_confirmation, request_help) => {
    expect(interactionPolicy({ confirmTabBorrow, requestHelpEnabled })).toEqual({
      borrow_confirmation,
      request_help,
    });
  });
});
