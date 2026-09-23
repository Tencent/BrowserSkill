import { afterEach, expect, it, vi } from "vitest";
import { INPUT_PASSTHROUGH, INPUT_PASSTHROUGH_ATTR } from "@/lib/input-passthrough-bridge";
import {
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  type OverlayMode,
} from "@/lib/overlay-bridge";
import { RECORD_START, RECORD_STOP } from "@/lib/record-bridge";

vi.hoisted(() => {
  Object.assign(globalThis, { defineContentScript: (definition: unknown) => definition });
});
// Exercise the real content entrypoint/controller wiring without mounting React components.
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render() {}, unmount() {} }) },
}));
vi.mock("@/lib/instance-id", () => ({
  getControlHintsHidden: async () => false,
  STORAGE_KEYS: { CONTROL_HINTS_HIDDEN: "control_hints_hidden" },
}));

import content from "../content";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.querySelectorAll("browser-skill-overlay").forEach((host) => host.remove());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture() {
  vi.useFakeTimers();
  let receive: (message: unknown, sender: object, ack: () => void) => void;
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async () => {
        throw new Error("Background unavailable");
      }),
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
        removeListener: vi.fn(),
      },
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  let host: HTMLElement;
  let mount: () => void;
  vi.stubGlobal(
    "createShadowRootUi",
    async (
      _ctx: unknown,
      options: {
        onMount(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): unknown;
        onRemove(root: unknown): void;
      },
    ) => {
      let root: unknown;
      mount = () => {
        if (host) {
          options.onRemove(root);
          host.remove();
        }
        host = document.createElement("browser-skill-overlay");
        const shadow = host.attachShadow({ mode: "closed" });
        const container = document.createElement("div");
        shadow.append(container);
        document.documentElement.append(host);
        root = options.onMount(container, shadow, host);
      };
      return { mount };
    },
  );
  await (content.main as (ctx: { onInvalidated(fn: () => void): void }) => Promise<void>)({
    onInvalidated: (fn) => {
      dispose = fn;
    },
  });
  const send = (message: unknown) => receive(message, {}, vi.fn());
  const state = (sessionId = "one", mode: OverlayMode = "control") =>
    send({ type: OVERLAY_AGENT_STATE, sessionId, mode, generation: 0 });
  const begin = (id = "click-one") => send({ type: INPUT_PASSTHROUGH, phase: "begin", id });
  const active = () => host.hasAttribute(INPUT_PASSTHROUGH_ATTR);
  state();
  return { send, state, begin, active, remount: () => mount() };
}

it.each([
  "paused",
  "hidden",
  "interrupting",
] as const)("clears leases when control becomes %s", async (mode) => {
  const f = await fixture();
  f.begin();
  expect(f.active()).toBe(true);
  f.state("one", mode);
  expect(f.active()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  f.state();
  f.remount();
  expect(f.active()).toBe(false);
});

it("preserves same-session control updates and remounts until the click ends", async () => {
  const f = await fixture();
  f.begin();
  f.state();
  f.remount();
  expect(f.active()).toBe(true);
  f.send({ type: INPUT_PASSTHROUGH, phase: "end", id: "click-one" });
  expect(f.active()).toBe(false);
});

it("clears old session leases without letting stale reset/end clear the new session", async () => {
  const f = await fixture();
  f.begin();
  f.state("two");
  expect(f.active()).toBe(false);
  f.begin("click-two");
  f.send({ type: OVERLAY_AGENT_OVERLAY_RESET, sessionId: "one" });
  f.send({ type: INPUT_PASSTHROUGH, phase: "end", id: "click-one" });
  expect(f.active()).toBe(true);
  f.send({ type: OVERLAY_AGENT_OVERLAY_RESET, sessionId: "two" });
  expect(f.active()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  f.remount();
  expect(f.active()).toBe(false);
});

it("clears leases when recording starts or finishes", async () => {
  const f = await fixture();
  f.begin();
  f.send({ type: RECORD_START, requestId: "record" });
  expect(f.active()).toBe(false);
  f.begin("late-click");
  f.send({ type: RECORD_STOP, requestId: "record" });
  expect(f.active()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("removes passthrough and timers when the content context is invalidated", async () => {
  const f = await fixture();
  f.begin();
  dispose?.();
  expect(f.active()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
