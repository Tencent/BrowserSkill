import { afterEach, describe, expect, it, vi } from "vitest";
import { INPUT_PASSTHROUGH, INPUT_PASSTHROUGH_ATTR } from "@/lib/input-passthrough-bridge";
import {
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  type OverlayMode,
  type OverlayVersion,
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
  // Versions in the order one background worker hands them out.
  let generation = 0;
  const version = (): OverlayVersion => ({ epoch: "worker", generation: ++generation });
  const state = (
    sessionId: string | null = "one",
    mode: OverlayMode = "control",
    v: OverlayVersion = version(),
  ) => send({ type: OVERLAY_AGENT_STATE, sessionId, mode, ...v });
  const reset = (sessionId: string, v: OverlayVersion = version()) =>
    send({ type: OVERLAY_AGENT_OVERLAY_RESET, sessionId, ...v });
  const begin = (id = "click-one") => send({ type: INPUT_PASSTHROUGH, phase: "begin", id });
  const active = () => host.hasAttribute(INPUT_PASSTHROUGH_ATTR);
  const blocking = () => host.hasAttribute("data-bsk-overlay-blocking");
  state();
  return { send, version, state, reset, begin, active, blocking, remount: () => mount() };
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
  f.reset("one");
  f.send({ type: INPUT_PASSTHROUGH, phase: "end", id: "click-one" });
  expect(f.active()).toBe(true);
  f.reset("two");
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

describe("overlay state ordering", () => {
  it("drops a control state that arrives after a newer hidden state", async () => {
    const f = await fixture();
    const late = f.version();
    f.state(null, "hidden");
    f.state("one", "control", late);
    expect(f.blocking()).toBe(false);
  });

  it("drops a control state sent before a reset", async () => {
    const f = await fixture();
    expect(f.blocking()).toBe(true);
    const late = f.version();
    f.reset("one");
    expect(f.blocking()).toBe(false);
    f.state("one", "control", late);
    expect(f.blocking()).toBe(false);
  });

  it("drops a reset sent before a newer control state", async () => {
    const f = await fixture();
    const late = f.version();
    f.state("one", "control");
    f.reset("one", late);
    expect(f.blocking()).toBe(true);
  });

  it("follows a restarted worker although its generation starts over", async () => {
    const f = await fixture();
    f.state("one", "control", { epoch: "worker", generation: 20 });
    f.state(null, "hidden", { epoch: "restarted", generation: 1 });
    expect(f.blocking()).toBe(false);
    f.state("one", "control", { epoch: "restarted", generation: 2 });
    expect(f.blocking()).toBe(true);
  });

  it("lets a restarted worker claim a page it had hidden", async () => {
    const f = await fixture();
    f.state(null, "hidden", { epoch: "worker", generation: 20 });
    f.state("one", "control", { epoch: "restarted", generation: 1 });
    expect(f.blocking()).toBe(true);
  });

  it("keeps dropping the replaced worker's messages", async () => {
    const f = await fixture();
    f.state(null, "hidden", { epoch: "restarted", generation: 1 });
    f.state("one", "control", { epoch: "worker", generation: 30 });
    expect(f.blocking()).toBe(false);
  });
});
