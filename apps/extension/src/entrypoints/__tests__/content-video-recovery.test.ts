import { afterEach, expect, it, vi } from "vitest";
import { HELP_REQUEST } from "@/lib/help-bridge";
import { INPUT_PASSTHROUGH, INPUT_PASSTHROUGH_ATTR } from "@/lib/input-passthrough-bridge";
import {
  OVERLAY_AGENT_STATE,
  OVERLAY_AUTOMATION_BYPASS,
  OVERLAY_MSG_INTERRUPT,
} from "@/lib/overlay-bridge";
import { RECORD_START, RECORD_STOP } from "@/lib/record-bridge";
import { VIDEO_OVERLAY } from "@/video/overlay";

const preference = vi.hoisted(() => {
  Object.assign(globalThis, { defineContentScript: (definition: unknown) => definition });
  return { hidden: false };
});
vi.mock("@/lib/instance-id", () => ({
  getControlHintsHidden: async () => preference.hidden,
  STORAGE_KEYS: { CONTROL_HINTS_HIDDEN: "control_hints_hidden" },
}));

import content from "../content";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.querySelectorAll("browser-skill-overlay").forEach((host) => host.remove());
  Reflect.deleteProperty(document, "prerendering");
  Reflect.deleteProperty(document, "visibilityState");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Mount real React overlays: recovery must restore the user-facing UI, not
// merely update the lease's internal flags.
async function fixture(failures: number, prerendering = false, hintsHidden = false) {
  preference.hidden = hintsHidden;
  vi.useFakeTimers();
  Object.defineProperty(document, "prerendering", {
    value: prerendering,
    writable: true,
    configurable: true,
  });
  const query = vi.fn(async () => {
    if (failures-- > 0) throw new Error("Transient video query failure");
    return { recording_id: null };
  });
  let receive!: (message: unknown, sender: object, respond: () => void) => void;
  let storageChange!: (changes: object, area: string) => void;
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message) =>
        message.type === VIDEO_OVERLAY ? query() : { active: false },
      ),
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
        removeListener: vi.fn(),
      },
    },
    storage: {
      onChanged: {
        addListener: (listener: typeof storageChange) => {
          storageChange = listener;
        },
        removeListener: vi.fn(),
      },
    },
  });
  let shadow!: ShadowRoot;
  let remove: (() => void) | undefined;
  let mount!: () => void;
  vi.stubGlobal(
    "createShadowRootUi",
    async (
      _ctx: unknown,
      options: {
        onMount(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): unknown;
        onRemove(root: unknown): void;
      },
    ) => {
      mount = () => {
        remove?.();
        const host = document.createElement("browser-skill-overlay");
        shadow = host.attachShadow({ mode: "open" });
        const container = document.createElement("div");
        shadow.append(container);
        document.documentElement.append(host);
        const root = options.onMount(container, shadow, host);
        remove = () => {
          options.onRemove(root);
          host.remove();
        };
      };
      return { mount };
    },
  );
  await (content.main as (ctx: { onInvalidated(fn: () => void): void }) => Promise<void>)({
    onInvalidated(fn) {
      dispose = () => {
        fn();
        remove?.();
      };
    },
  });
  return {
    query,
    remount: () => mount(),
    find: (selector: string) => shadow.querySelector(selector),
    preference(hidden: boolean) {
      preference.hidden = hidden;
      storageChange({ control_hints_hidden: { newValue: hidden } }, "local");
    },
    send: (message: unknown) => receive(message, {}, vi.fn()),
    visible: (slot: string) => shadow.querySelector(`[data-slot="${slot}"]`) !== null,
    activate() {
      Object.assign(document, { prerendering: false });
      document.dispatchEvent(new Event("prerenderingchange"));
    },
  };
}

const requests = [
  [
    {
      type: "borrow-request",
      requestId: "borrow",
      isActiveTab: true,
      tabTitle: "Test page",
      timeoutMs: 60_000,
    },
    "borrow-confirmation-modal",
  ],
  [
    {
      type: HELP_REQUEST,
      requestId: "help",
      prompt: "Confirm this step",
      selectors: [],
      timeoutMs: 60_000,
    },
    "help-request-banner",
  ],
  [{ type: RECORD_START, requestId: "record" }, "record-overlay-pill"],
  [
    {
      type: OVERLAY_AGENT_STATE,
      sessionId: "task",
      mode: "control",
      epoch: "worker",
      generation: 1,
    },
    "control-overlay-card",
  ],
] as const;

it.each(
  requests,
)("restores %j after one query failure without a video push", async (request, slot) => {
  const f = await fixture(1);
  f.send(request);
  expect(f.visible(slot)).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.visible(slot)).toBe(true);
});

it.each(requests)("restarts exhausted discovery when %j arrives", async (request, slot) => {
  const f = await fixture(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.query).toHaveBeenCalledTimes(3);
  f.send(request);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.query).toHaveBeenCalledTimes(4);
  expect(f.visible(slot)).toBe(true);
});

it("discovers on prerender activation without requiring pageshow.persisted", async () => {
  const f = await fixture(0, true);
  f.send(requests[0][0]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.visible(requests[0][1])).toBe(false);
  f.activate();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.query).toHaveBeenCalledOnce();
  expect(f.visible(requests[0][1])).toBe(true);
});

it("retries on becoming visible and removes lifecycle listeners on invalidation", async () => {
  const f = await fixture(3);
  f.send(requests[1][0]);
  await vi.advanceTimersByTimeAsync(2000);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.visible(requests[1][1])).toBe(true);
  dispose?.();
  dispose = undefined;
  f.activate();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.query).toHaveBeenCalledTimes(4);
});

function cooperationState(generation = 1) {
  return {
    type: OVERLAY_AGENT_STATE,
    sessionId: "task",
    mode: "control",
    epoch: "worker",
    generation,
    cooperation: {
      mode: "ready",
      revision: generation,
      editing: false,
      target: { x: 30, y: 40, expires: Date.now() + 60_000 },
    },
  };
}

it.each([
  "fallback",
  "cooperation",
])("honors saved hidden hints before the first %s render and remount", async (mode) => {
  const f = await fixture(0, false, true);
  f.send(mode === "cooperation" ? cooperationState() : requests[3][0]);
  await vi.advanceTimersByTimeAsync(1100);
  for (const remount of [false, true]) {
    if (remount) f.remount();
    expect(f.visible("cooperation-toolbar")).toBe(false);
    expect(f.visible("control-overlay-card")).toBe(false);
    expect(f.visible("control-overlay-blocker")).toBe(false);
    expect(f.visible("control-overlay")).toBe(false);
    expect(f.find(".bsk-cooperation-target")).toBeNull();
    expect(document.querySelector("browser-skill-overlay")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  }
});

it("keeps fallback hints, input bypass and remounts on their existing lifecycle", async () => {
  const f = await fixture(0);
  f.send(requests[3][0]);
  await vi.advanceTimersByTimeAsync(1100);
  const host = () => document.querySelector("browser-skill-overlay")!;
  const blocker = () => f.find('[data-slot="control-overlay-blocker"]') as HTMLElement | null;
  expect(f.visible("control-overlay-card")).toBe(true);
  expect(f.visible("control-overlay")).toBe(true);
  expect(host().hasAttribute("aria-hidden")).toBe(false);
  expect(host().hasAttribute("data-bsk-overlay-blocking")).toBe(true);
  expect(blocker()?.style.pointerEvents).toBe("auto");

  f.send({ type: OVERLAY_AUTOMATION_BYPASS, enabled: true });
  expect(host().hasAttribute("data-bsk-overlay-surface")).toBe(true);
  expect(host().hasAttribute("data-bsk-overlay-blocking")).toBe(false);
  expect(blocker()?.style.pointerEvents).toBe("none");
  f.send({ type: INPUT_PASSTHROUGH, phase: "begin", id: "click" });
  f.remount();
  expect(host().hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true);
  expect(blocker()?.style.pointerEvents).toBe("none");

  f.preference(true);
  expect(f.visible("control-overlay-card")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
  expect(blocker()).toBeNull();
  expect(host().hasAttribute("data-bsk-overlay-surface")).toBe(false);
  expect(host().hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
  f.remount();
  f.preference(false);
  expect(f.visible("control-overlay-card")).toBe(true);
  expect(f.visible("control-overlay")).toBe(true);
  expect(blocker()?.style.pointerEvents).toBe("none");
  f.send({ type: OVERLAY_AUTOMATION_BYPASS, enabled: false });
  expect(host().hasAttribute("data-bsk-overlay-blocking")).toBe(true);
  expect(blocker()?.style.pointerEvents).toBe("auto");
});

it("adds cooperation controls to the same card only after receiving real cooperation state", async () => {
  const f = await fixture(0);
  f.send(requests[3][0]);
  await vi.advanceTimersByTimeAsync(1100);
  const card = f.find('[data-slot="control-overlay-card"]')!;
  const glow = f.find('[data-slot="control-overlay"]');
  expect(card.querySelectorAll("button")).toHaveLength(1);
  expect(card.getAttribute("data-mode")).toBeNull();
  f.send({ type: INPUT_PASSTHROUGH, phase: "begin", id: "claim-click" });
  vi.mocked(chrome.runtime.sendMessage).mockClear();

  const state = cooperationState(2);
  f.send({ ...state, cooperation: { ...state.cooperation, mode: "held", revision: 23 } });
  expect(f.find('[data-slot="cooperation-toolbar"]')).toBe(card);
  expect(f.find('[data-slot="control-overlay"]')).toBe(glow);
  expect(card.getAttribute("data-mode")).toBe("held");
  expect(card.querySelectorAll("button")).toHaveLength(2);
  expect(f.visible("control-overlay-blocker")).toBe(false);
  const host = document.querySelector("browser-skill-overlay")!;
  expect(host.hasAttribute("data-bsk-overlay-surface")).toBe(false);
  expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it.each([
  "fallback",
  "cooperation",
])("stops the same session and clears the %s card and glow", async (mode) => {
  const f = await fixture(0);
  f.send(mode === "cooperation" ? cooperationState() : requests[3][0]);
  await vi.advanceTimersByTimeAsync(1100);
  const send = vi.mocked(chrome.runtime.sendMessage);
  send.mockClear();
  let acknowledge!: (reply: { ok: boolean }) => void;
  send.mockReturnValueOnce(
    new Promise((resolve) => {
      acknowledge = resolve;
    }),
  );
  const stop = f.find('[data-slot="control-overlay-stop-all"]') as HTMLButtonElement;
  stop.click();
  stop.click();
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: OVERLAY_MSG_INTERRUPT, sessionId: "task" });
  if (mode === "fallback") expect(stop.disabled).toBe(true);
  acknowledge({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.visible("control-overlay-card")).toBe(false);
  expect(f.visible("cooperation-toolbar")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
  expect(f.visible("control-overlay-blocker")).toBe(false);
  expect(
    document.querySelector("browser-skill-overlay")?.hasAttribute("data-bsk-overlay-surface"),
  ).toBe(false);
});

it("hides only control UI and restores the latest cooperation state when hints return", async () => {
  const f = await fixture(0);
  f.send(cooperationState());
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.visible("cooperation-toolbar")).toBe(true);
  expect(f.visible("control-overlay")).toBe(true);
  expect(f.visible("control-overlay-blocker")).toBe(false);
  expect(f.find(".bsk-cooperation-target")).not.toBeNull();
  f.preference(true);
  expect(f.visible("cooperation-toolbar")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
  expect(f.find(".bsk-cooperation-target")).toBeNull();
  const state = cooperationState(2);
  f.send({ ...state, cooperation: { ...state.cooperation, mode: "human", editing: true } });
  f.remount();
  expect(f.visible("cooperation-toolbar")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
  f.preference(false);
  expect(f.find('[data-slot="cooperation-toolbar"]')?.getAttribute("data-mode")).toBe("human");
  expect(f.visible("control-overlay")).toBe(true);
  expect(f.find(".bsk-cooperation-target")).not.toBeNull();
  expect(
    vi.mocked(chrome.runtime.sendMessage).mock.calls.some((args) => {
      const message = args[0] as unknown as { kind?: string };
      return message?.kind === "cooperation.control" || message?.kind === "overlay.interrupt";
    }),
  ).toBe(false);
});

it.each(
  requests.slice(0, 3),
)("hidden control hints preserve required interactive UI: %j", async (request, slot) => {
  const f = await fixture(0, false, true);
  f.send(cooperationState());
  f.send(request);
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.visible(slot)).toBe(true);
  expect(f.visible("cooperation-toolbar")).toBe(false);
  expect(f.visible("control-overlay-card")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
});

it.each(
  requests.slice(0, 3),
)("does not render fallback UI when %j hides the cooperative card", async (request, slot) => {
  const f = await fixture(0);
  f.send(cooperationState());
  await vi.advanceTimersByTimeAsync(1100);
  f.send(request);
  expect(f.visible(slot)).toBe(true);
  expect(f.visible("cooperation-toolbar")).toBe(false);
  expect(f.visible("control-overlay-card")).toBe(false);
  expect(f.visible("control-overlay-blocker")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
});

it("retains post-record control suppression across preference changes and remount", async () => {
  const f = await fixture(0);
  f.send(cooperationState());
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.visible("cooperation-toolbar")).toBe(true);
  expect(f.visible("control-overlay")).toBe(true);
  f.send({ type: RECORD_START, requestId: "record" });
  expect(f.visible("record-overlay-pill")).toBe(true);
  expect(f.visible("control-overlay")).toBe(false);
  f.send({ type: RECORD_STOP, requestId: "record" });
  expect(f.visible("record-overlay-pill")).toBe(false);
  f.preference(true);
  f.preference(false);
  f.remount();
  expect(f.visible("cooperation-toolbar")).toBe(false);
  expect(f.visible("control-overlay")).toBe(false);
  expect(f.find(".bsk-cooperation-target")).toBeNull();
});
