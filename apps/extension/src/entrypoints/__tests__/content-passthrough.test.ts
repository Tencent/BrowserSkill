import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP_QUERY, HELP_REQUEST } from "@/lib/help-bridge";
import { INPUT_PASSTHROUGH, INPUT_PASSTHROUGH_ATTR } from "@/lib/input-passthrough-bridge";
import {
  OVERLAY_AGENT_OVERLAY_RESET,
  OVERLAY_AGENT_STATE,
  type OverlayMode,
  type OverlayVersion,
} from "@/lib/overlay-bridge";
import { RECORD_CANCEL, RECORD_QUERY, RECORD_START, RECORD_STOP } from "@/lib/record-bridge";

const renderedRef = vi.hoisted(() => ({ current: null as unknown }));

vi.hoisted(() => {
  Object.assign(globalThis, { defineContentScript: (definition: unknown) => definition });
});
// Exercise the real content entrypoint/controller wiring without mounting React components.
vi.mock("react-dom/client", () => ({
  default: {
    createRoot: () => ({
      render(element: unknown) {
        renderedRef.current = element;
      },
      unmount() {},
    }),
  },
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

async function fixture(pendingVideoQuery = false) {
  vi.useFakeTimers();
  let receive: (message: unknown, sender: object, ack: () => void) => void;
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message) => {
        if (message.type === "bsk/video-overlay")
          return pendingVideoQuery ? new Promise(() => {}) : { recording_id: null };
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
  await vi.advanceTimersByTimeAsync(1000);
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

it("mounts and registers listeners without showing controls before video discovery", async () => {
  const f = await fixture(true);
  expect(f.blocking()).toBe(false);
  f.send({ type: "bsk/video-overlay", recording_id: "video" });
  expect(f.blocking()).toBe(false);
  f.send({ type: "bsk/video-overlay", recording_id: null });
  expect(f.blocking()).toBe(true);
  f.begin();
  expect(f.active()).toBe(true);
}, 1000);

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

function renderedRecordRequest(): { id: string } | null {
  const root = renderedRef.current as {
    props?: {
      children?: { props?: { children?: Array<{ props?: { request?: { id: string } | null } }> } };
    };
  } | null;
  const children = root?.props?.children?.props?.children;
  return children?.[2]?.props?.request ?? null;
}

function renderedHelpRequest(): { id: string } | null {
  const root = renderedRef.current as {
    props?: {
      children?: { props?: { children?: Array<{ props?: { request?: { id: string } | null } }> } };
    };
  } | null;
  const children = root?.props?.children?.props?.children;
  return children?.[1]?.props?.request ?? null;
}

describe("record overlay recovery and stop races", () => {
  it.each([
    RECORD_STOP,
    RECORD_CANCEL,
  ] as const)("clears RecordOverlay recovered via RECORD_QUERY when %s arrives", async (teardownType) => {
    vi.useFakeTimers();
    let receive!: (message: unknown, sender: object, ack: (res?: unknown) => void) => void;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async (message: { type?: string; kind?: string }) => {
          if (message.type === "bsk/video-overlay") return { recording_id: null };
          if (message.type === RECORD_QUERY) {
            return { active: true, requestId: "rec-recovered", startedAtMs: 1234 };
          }
          return undefined;
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
    vi.stubGlobal(
      "createShadowRootUi",
      async (
        _ctx: unknown,
        options: {
          onMount(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): unknown;
          onRemove(root: unknown): void;
        },
      ) => ({
        mount() {
          const host = document.createElement("browser-skill-overlay");
          const shadow = host.attachShadow({ mode: "closed" });
          const container = document.createElement("div");
          shadow.append(container);
          document.documentElement.append(host);
          options.onMount(container, shadow, host);
        },
      }),
    );

    await (content.main as (ctx: { onInvalidated(fn: () => void): void }) => Promise<void>)({
      onInvalidated: (fn) => {
        dispose = fn;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderedRecordRequest()).toMatchObject({ id: "rec-recovered" });

    const ack = vi.fn();
    receive({ type: teardownType, requestId: "rec-recovered" }, {}, ack);
    expect(renderedRecordRequest()).toBeNull();
    if (teardownType === RECORD_STOP) {
      expect(ack).toHaveBeenCalledWith({ ok: true });
    }
  });

  it("does not resurrect RecordOverlay if RECORD_STOP lands while RECORD_QUERY is in flight", async () => {
    vi.useFakeTimers();
    let receive!: (message: unknown, sender: object, ack: (res?: unknown) => void) => void;
    const pendingQueries: Array<(value: unknown) => void> = [];
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { type?: string }) => {
          if (message.type === "bsk/video-overlay") return Promise.resolve({ recording_id: null });
          if (message.type === RECORD_QUERY) {
            return new Promise((resolve) => {
              pendingQueries.push(resolve);
            });
          }
          return Promise.resolve(undefined);
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
    vi.stubGlobal(
      "createShadowRootUi",
      async (
        _ctx: unknown,
        options: {
          onMount(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): unknown;
          onRemove(root: unknown): void;
        },
      ) => ({
        mount() {
          const host = document.createElement("browser-skill-overlay");
          const shadow = host.attachShadow({ mode: "closed" });
          const container = document.createElement("div");
          shadow.append(container);
          document.documentElement.append(host);
          options.onMount(container, shadow, host);
        },
      }),
    );

    await (content.main as (ctx: { onInvalidated(fn: () => void): void }) => Promise<void>)({
      onInvalidated: (fn) => {
        dispose = fn;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pendingQueries.length).toBeGreaterThan(0);

    const ack = vi.fn();
    receive({ type: RECORD_STOP, requestId: "rec-race" }, {}, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });

    for (const resolve of pendingQueries) {
      resolve({ active: true, requestId: "rec-race", startedAtMs: 5678 });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(renderedRecordRequest()).toBeNull();
  });

  it("clears a stale RecordOverlay on BFCache pageshow when RECORD_QUERY reports inactive without clobbering a concurrent new start", async () => {
    vi.useFakeTimers();
    let receive!: (message: unknown, sender: object, ack: (res?: unknown) => void) => void;
    let queryMode: "active" | "inactive" | "deferred" = "active";
    let resolveDeferredQuery!: (value: unknown) => void;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { type?: string }) => {
          if (message.type === "bsk/video-overlay") return Promise.resolve({ recording_id: null });
          if (message.type === RECORD_QUERY) {
            if (queryMode === "active") {
              return Promise.resolve({ active: true, requestId: "rec-bfcache", startedAtMs: 111 });
            }
            if (queryMode === "inactive") {
              return Promise.resolve({ active: false });
            }
            return new Promise((resolve) => {
              resolveDeferredQuery = resolve;
            });
          }
          return Promise.resolve(undefined);
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
    vi.stubGlobal(
      "createShadowRootUi",
      async (
        _ctx: unknown,
        options: {
          onMount(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): unknown;
          onRemove(root: unknown): void;
        },
      ) => ({
        mount() {
          const host = document.createElement("browser-skill-overlay");
          const shadow = host.attachShadow({ mode: "closed" });
          const container = document.createElement("div");
          shadow.append(container);
          document.documentElement.append(host);
          options.onMount(container, shadow, host);
        },
      }),
    );

    await (content.main as (ctx: { onInvalidated(fn: () => void): void }) => Promise<void>)({
      onInvalidated: (fn) => {
        dispose = fn;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderedRecordRequest()).toMatchObject({ id: "rec-bfcache" });

    const dispatchPersistedPageshow = () => {
      const event = new Event("pageshow");
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    };

    // Page returns from BFCache after recording stopped elsewhere -> RECORD_QUERY returns inactive.
    queryMode = "inactive";
    dispatchPersistedPageshow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderedRecordRequest()).toBeNull();

    // Start a fresh recording, then trigger BFCache pageshow while a newer RECORD_START races the query.
    receive({ type: RECORD_START, requestId: "rec-old", startedAtMs: 222 }, {}, vi.fn());
    expect(renderedRecordRequest()).toMatchObject({ id: "rec-old" });
    queryMode = "deferred";
    dispatchPersistedPageshow();
    await vi.advanceTimersByTimeAsync(1000);

    receive({ type: RECORD_START, requestId: "rec-new", startedAtMs: 333 }, {}, vi.fn());
    expect(renderedRecordRequest()).toMatchObject({ id: "rec-new" });

    resolveDeferredQuery({ active: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderedRecordRequest()).toMatchObject({ id: "rec-new" });

    // A transient { active: false } on RECORD_QUERY must not permanently blacklist a still-live requestId.
    receive({ type: RECORD_START, requestId: "rec-bfcache", startedAtMs: 111 }, {}, vi.fn());
    expect(renderedRecordRequest()).toMatchObject({ id: "rec-bfcache" });
  });

  it("clears a stale HelpRequestOverlay on BFCache pageshow when HELP_QUERY reports inactive or detached without clobbering a concurrent help request", async () => {
    vi.useFakeTimers();
    let receive!: (message: unknown, sender: object, ack: (res?: unknown) => void) => void;
    let helpQueryMode: "inactive" | "detached" | "deferred" = "inactive";
    let helpQueryCount = 0;
    let resolveDeferredHelp!: (value: unknown) => void;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((message: { type?: string }) => {
          if (message.type === "bsk/video-overlay") return Promise.resolve({ recording_id: null });
          if (message.type === HELP_QUERY) {
            helpQueryCount += 1;
            if (helpQueryMode === "inactive") return Promise.resolve({ active: false });
            if (helpQueryMode === "detached") return Promise.resolve(undefined);
            return new Promise((resolve) => {
              resolveDeferredHelp = resolve;
            });
          }
          return Promise.resolve(undefined);
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
    vi.stubGlobal(
      "createShadowRootUi",
      async (
        _ctx: unknown,
        options: {
          onMount(container: HTMLElement, shadow: ShadowRoot, host: HTMLElement): unknown;
          onRemove(root: unknown): void;
        },
      ) => ({
        mount() {
          const host = document.createElement("browser-skill-overlay");
          const shadow = host.attachShadow({ mode: "closed" });
          const container = document.createElement("div");
          shadow.append(container);
          document.documentElement.append(host);
          options.onMount(container, shadow, host);
        },
      }),
    );

    const dispatchPersistedPageshow = () => {
      const event = new Event("pageshow");
      Object.defineProperty(event, "persisted", { value: true });
      window.dispatchEvent(event);
    };

    await (content.main as (ctx: { onInvalidated(fn: () => void): void }) => Promise<void>)({
      onInvalidated: (fn) => {
        dispose = fn;
      },
    });
    await vi.advanceTimersByTimeAsync(1500);

    // Mount compact help banner, then return from BFCache with explicit { active: false }.
    receive(
      {
        type: HELP_REQUEST,
        requestId: "help-bfcache-1",
        prompt: "Finish login",
        displayMode: "compact",
        selectors: [],
        timeoutMs: 60_000,
      },
      {},
      vi.fn(),
    );
    expect(renderedHelpRequest()).toMatchObject({ id: "help-bfcache-1" });

    helpQueryCount = 0;
    helpQueryMode = "inactive";
    dispatchPersistedPageshow();
    await vi.advanceTimersByTimeAsync(50);
    expect(renderedHelpRequest()).toBeNull();
    // Explicit { active: false } clears immediately without retrying 6x.
    expect(helpQueryCount).toBe(1);

    // Mount another compact banner and return from BFCache after the background detached HELP_QUERY (returns undefined).
    receive(
      {
        type: HELP_REQUEST,
        requestId: "help-bfcache-2",
        prompt: "Solve captcha",
        displayMode: "compact",
        selectors: [],
        timeoutMs: 60_000,
      },
      {},
      vi.fn(),
    );
    expect(renderedHelpRequest()).toMatchObject({ id: "help-bfcache-2" });

    helpQueryMode = "detached";
    dispatchPersistedPageshow();
    await vi.advanceTimersByTimeAsync(1500);
    expect(renderedHelpRequest()).toBeNull();

    // Concurrent new HELP_REQUEST arriving while HELP_QUERY is in flight is never clobbered.
    receive(
      {
        type: HELP_REQUEST,
        requestId: "help-old",
        prompt: "Old help",
        displayMode: "compact",
        selectors: [],
        timeoutMs: 60_000,
      },
      {},
      vi.fn(),
    );
    helpQueryMode = "deferred";
    dispatchPersistedPageshow();
    await vi.advanceTimersByTimeAsync(100);

    receive(
      {
        type: HELP_REQUEST,
        requestId: "help-new",
        prompt: "New help",
        displayMode: "full",
        selectors: [],
        timeoutMs: 60_000,
      },
      {},
      vi.fn(),
    );
    expect(renderedHelpRequest()).toMatchObject({ id: "help-new" });

    resolveDeferredHelp({ active: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderedHelpRequest()).toMatchObject({ id: "help-new" });
  });
});
