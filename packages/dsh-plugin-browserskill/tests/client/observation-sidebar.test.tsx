// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservationOverlay } from "../../src/client/ObservationOverlay";
import {
  type NativeSidebarHost,
  type NativeTabDefinition,
  type NativeTabProps,
  OBSERVATION_TAB_ID,
  OBSERVATION_TAB_KIND,
  ObservationSidebarTab,
  registerObservationSidebar,
} from "../../src/client/observation-sidebar";
import { type EventSourceLike, ObservationClientStore } from "../../src/client/observation-store";
import type { SessionObservation } from "../../src/observation";

const BODY = "sidebar.right.pane.tab";
const TITLE = "sidebar.right.pane.tab.title";
const BUSY: SessionObservation = {
  sessionId: "s1",
  action: "clicking",
  since: Date.now(),
  dshSessionIds: ["conv-1"],
};
const FOREIGN: SessionObservation = { ...BUSY, sessionId: "s9", dshSessionIds: ["conv-2"] };
const disposers: (() => void)[] = [];

function observation(initial: SessionObservation[] = []) {
  let current = initial;
  let connection: EventSourceLike | undefined;
  const urls: string[] = [];
  const store = new ObservationClientStore({
    fetchFn: async () => ({ ok: true, json: async () => ({}) }),
    eventSourceFactory: (url) => {
      urls.push(url);
      const es = { onmessage: null, close: vi.fn() } as EventSourceLike;
      connection = es;
      queueMicrotask(() =>
        es.onmessage?.({
          data: JSON.stringify({ type: "snapshot", sessions: current, available: true }),
        }),
      );
      return es;
    },
    loadImage: async (id) => `blob:${id}`,
  });
  return {
    store,
    urls,
    connection: () => connection,
    push(sessions: SessionObservation[]) {
      current = sessions;
      connection?.onmessage?.({
        data: JSON.stringify({ type: "snapshot", sessions, available: true }),
      });
    },
  };
}

/** Native contracts: keyed slots use implementation id, navigation uses kind and explicit session. */
function nativeHost(
  options: { ready?: boolean; declared?: boolean; betterSidebar?: boolean } = {},
) {
  let current: string | undefined = "conv-1";
  let ready = options.ready ?? true;
  const declared = new Set(options.declared === false ? [] : [BODY, TITLE]);
  const watchers = new Set<{ name: string; start: () => () => void; stop?: () => void }>();
  const components = new Map<string, (props: NativeTabProps) => ReactNode>();
  const listeners = new Set<() => void>();
  const roots = new Map<string, ReturnType<typeof render>>();
  let definition: NativeTabDefinition | undefined;
  const register = vi.fn((value: NativeTabDefinition) => {
    definition = value;
    return () => {
      definition = undefined;
    };
  });
  const useTabInfo = () => ({ tab: { visible: true } });
  const mountTitle = (sessionId: string) => {
    if (roots.has(sessionId)) return;
    const Title = components.get(TITLE);
    if (Title === undefined) throw new Error("missing title renderer");
    roots.set(sessionId, render(<Title sessionId={sessionId} useTabInfo={useTabInfo} />));
  };
  const openTabIn = vi.fn((sessionId: string, kind: string) => {
    if (definition?.kind !== kind) throw new Error("unknown native kind");
    if (ready) mountTitle(sessionId);
  });
  const betterSidebar = {
    registerTab: vi.fn(() => {
      throw new Error("legacy service must not be used");
    }),
  };
  const values: Record<string, unknown> = {
    sidebarRight: { openTabIn },
    sidebarRightTabs: { register },
    sessions: {
      list: {
        getSnapshot: () => ({ current }),
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    ...(options.betterSidebar ? { betterSidebar } : {}),
  };
  const host: NativeSidebarHost = {
    get: (name) => values[name],
    slots: {
      inject(name, start) {
        const watcher = { name, start, stop: undefined as (() => void) | undefined };
        watchers.add(watcher);
        if (declared.has(name)) watcher.stop = start();
        return () => {
          watchers.delete(watcher);
          watcher.stop?.();
        };
      },
      register({ name, key }, component) {
        if (!declared.has(name)) throw new Error("undeclared native slot");
        expect(key).toBe(OBSERVATION_TAB_ID);
        components.set(name, component);
        return () => components.delete(name);
      },
    },
  };
  return {
    host,
    openTabIn,
    register,
    values,
    components,
    listeners,
    betterSidebar,
    definition: () => definition,
    setReady(value: boolean) {
      ready = value;
    },
    switchSession(id: string | undefined) {
      current = id;
      for (const listener of [...listeners]) listener();
    },
    close(sessionId: string) {
      roots.get(sessionId)?.unmount();
      roots.delete(sessionId);
    },
    declare(name: string) {
      declared.add(name);
      for (const watcher of [...watchers])
        if (watcher.name === name && watcher.stop === undefined) watcher.stop = watcher.start();
    },
    undeclare(name: string) {
      declared.delete(name);
      for (const watcher of [...watchers])
        if (watcher.name === name) {
          watcher.stop?.();
          watcher.stop = undefined;
        }
    },
  };
}

function install(host: NativeSidebarHost, store: ObservationClientStore) {
  const dispose = registerObservationSidebar(host, store);
  disposers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native observation registration", () => {
  it.each([
    false,
    true,
  ])("uses the native sidebar with better-sidebar installed=%s", async (betterSidebar) => {
    const h = observation([BUSY]);
    const n = nativeHost({ betterSidebar });
    install(n.host, h.store);
    await waitFor(() =>
      expect(n.openTabIn).toHaveBeenCalledExactlyOnceWith("conv-1", OBSERVATION_TAB_KIND),
    );
    expect(n.definition()).toMatchObject({ id: OBSERVATION_TAB_ID, kind: OBSERVATION_TAB_KIND });
    expect(n.definition()?.guide[0].title()).toBe("Browser Skill");
    expect(n.betterSidebar.registerTab).not.toHaveBeenCalled();
    expect(h.store.presentation.getSnapshot()).toEqual({ sidebarAvailable: true, floating: false });
    expect(screen.getByText("Browser Skill (1)")).toBeTruthy();
  });

  it.each([
    "sidebarRight",
    "sidebarRightTabs",
    "sessions",
  ])("keeps the overlay without %s", async (missing) => {
    const h = observation([BUSY]);
    const n = nativeHost();
    delete n.values[missing];
    install(n.host, h.store);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByTestId("obs-card");
    expect(n.register).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Move to sidebar" })).toBeNull();
  });

  it("waits for native seats and restores the overlay when they disappear", async () => {
    const h = observation([BUSY]);
    const n = nativeHost({ declared: false });
    install(n.host, h.store);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByTestId("obs-card");
    act(() => n.declare(BODY));
    expect(n.register).not.toHaveBeenCalled();
    await act(async () => n.declare(TITLE));
    await waitFor(() => expect(screen.queryByTestId("obs-card")).toBeNull());
    act(() => n.undeclare(BODY));
    await screen.findByTestId("obs-card");
    expect(n.definition()).toBeUndefined();
    expect(n.listeners.size).toBe(0);
    await act(async () => n.declare(BODY));
    expect(h.store.presentation.getSnapshot().sidebarAvailable).toBe(true);
  });

  it("rolls back partial registration instead of hiding the fallback", () => {
    const h = observation();
    const n = nativeHost();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    n.register.mockImplementationOnce(() => {
      throw new Error("duplicate native kind");
    });
    install(n.host, h.store);
    expect(n.components.size).toBe(0);
    expect(n.listeners.size).toBe(0);
    expect(h.store.presentation.getSnapshot().floating).toBe(true);
    expect(h.connection()).toBeUndefined();
  });

  it("releases registrations, subscriptions and the observation feed on dispose", async () => {
    const h = observation([BUSY]);
    const n = nativeHost();
    const dispose = install(n.host, h.store);
    await waitFor(() => expect(n.openTabIn).toHaveBeenCalledTimes(1));
    dispose();
    dispose();
    expect(n.components.size).toBe(0);
    expect(n.definition()).toBeUndefined();
    expect(n.listeners.size).toBe(0);
    expect(h.connection()?.close).toHaveBeenCalledTimes(1);
    expect(h.store.presentation.getSnapshot().sidebarAvailable).toBe(false);
  });
});

describe("automatic presentation", () => {
  it("does not reopen on screenshots, repeated list notifications, tab close or switching back", async () => {
    const h = observation([BUSY, FOREIGN]);
    const n = nativeHost();
    install(n.host, h.store);
    await waitFor(() => expect(n.openTabIn).toHaveBeenCalledTimes(1));
    n.close("conv-1");
    await act(async () => {
      h.push([{ ...BUSY, thumbnailAttachmentId: "frame-2" }, FOREIGN]);
      n.switchSession("conv-1");
    });
    expect(n.openTabIn).toHaveBeenCalledTimes(1);
    await act(async () => n.switchSession("conv-2"));
    expect(n.openTabIn).toHaveBeenLastCalledWith("conv-2", OBSERVATION_TAB_KIND);
    await act(async () => n.switchSession("conv-1"));
    expect(n.openTabIn).toHaveBeenCalledTimes(2);
  });

  it("waits for a selected conversation with its own browser and opens again for a new task", async () => {
    const h = observation([FOREIGN]);
    const n = nativeHost();
    n.switchSession(undefined);
    install(n.host, h.store);
    await act(async () => {});
    expect(n.openTabIn).not.toHaveBeenCalled();
    await act(async () => n.switchSession("conv-1"));
    expect(n.openTabIn).not.toHaveBeenCalled();
    await act(async () => h.push([BUSY]));
    expect(n.openTabIn).toHaveBeenCalledTimes(1);
    await act(async () => h.push([]));
    n.close("conv-1");
    await act(async () => h.push([{ ...BUSY, sessionId: "s2" }]));
    expect(n.openTabIn).toHaveBeenCalledTimes(2);
  });

  it("waits for native session-store adoption without acting on a stale mounted conversation", async () => {
    vi.useFakeTimers();
    const h = observation([BUSY, FOREIGN]);
    const n = nativeHost({ ready: false });
    install(n.host, h.store);
    await act(async () => {});
    expect(n.openTabIn).toHaveBeenLastCalledWith("conv-1", OBSERVATION_TAB_KIND);
    await act(async () => n.switchSession("conv-2"));
    n.setReady(true);
    await act(async () => vi.advanceTimersByTime(250));
    expect(n.openTabIn).toHaveBeenLastCalledWith("conv-2", OBSERVATION_TAB_KIND);
    const calls = n.openTabIn.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(2000));
    expect(n.openTabIn).toHaveBeenCalledTimes(calls);
    expect(h.store.presentation.getSnapshot().floating).toBe(false);
  });

  it("falls back when a native seat never mounts and stops retrying", async () => {
    vi.useFakeTimers();
    const h = observation([BUSY]);
    const n = nativeHost({ ready: false });
    install(n.host, h.store);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(1500));
    expect(h.store.presentation.getSnapshot().floating).toBe(true);
    const calls = n.openTabIn.mock.calls.length;
    await act(async () => {
      h.push([BUSY]);
      vi.advanceTimersByTime(3000);
    });
    expect(n.openTabIn).toHaveBeenCalledTimes(calls);
  });

  it("falls back on native navigation errors without breaking the observation feed", async () => {
    const h = observation([BUSY]);
    const n = nativeHost();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    n.openTabIn.mockImplementationOnce(() => {
      throw new Error("native navigation unavailable");
    });
    install(n.host, h.store);
    render(<ObservationOverlay store={h.store} />);
    await screen.findByTestId("obs-card");
    await act(async () => h.push([{ ...BUSY, action: "idle" }]));
    await screen.findByText(/s1 · idle/);
    expect(n.openTabIn).toHaveBeenCalledTimes(1);
  });
});

describe("view switching and content", () => {
  it("switches both ways without remembering a choice in a new client", async () => {
    const h = observation([BUSY]);
    const n = nativeHost();
    install(n.host, h.store);
    render(<ObservationOverlay store={h.store} />);
    await waitFor(() => expect(n.openTabIn).toHaveBeenCalledTimes(1));
    const Body = n.components.get(BODY)!;
    render(<Body sessionId="conv-1" useTabInfo={() => ({ tab: { visible: true } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Use floating view" }));
    await screen.findByTestId("obs-card");
    expect(screen.getByText("The browser view is in a floating window.")).toBeTruthy();
    await act(async () => h.push([BUSY]));
    expect(n.openTabIn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Move to sidebar" }));
    await waitFor(() => expect(screen.queryByTestId("obs-card")).toBeNull());
    expect(n.openTabIn).toHaveBeenCalledTimes(2);
    act(() => h.store.presentation.showFloating());
    fireEvent.click(screen.getByRole("button", { name: "Show here" }));
    await waitFor(() => expect(screen.queryByTestId("obs-card")).toBeNull());

    const fresh = observation();
    install(nativeHost().host, fresh.store);
    expect(fresh.store.presentation.getSnapshot().floating).toBe(false);
  });

  it("scopes native content and its controls to the slot's conversation", async () => {
    const h = observation([BUSY, FOREIGN]);
    render(<ObservationSidebarTab store={h.store} scopeId="conv-1" />);
    await screen.findByText(/s1 · clicking/);
    expect(screen.queryByText(/s9/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop session s1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
    expect(screen.getByTestId("obs-header").dataset.draggable).toBeUndefined();
  });

  it("does not request screenshots for a native tab the host hides", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const h = observation([BUSY]);
    const tab = render(<ObservationSidebarTab store={h.store} scopeId="conv-1" visible={false} />);
    await screen.findByText(/s1 · clicking/);
    expect(h.urls.every((url) => url.endsWith("thumbnails=0"))).toBe(true);
    tab.rerender(<ObservationSidebarTab store={h.store} scopeId="conv-1" visible />);
    await waitFor(() => expect(h.urls.at(-1)).toMatch(/thumbnails=1$/));
    tab.rerender(<ObservationSidebarTab store={h.store} scopeId="conv-1" visible={false} />);
    await waitFor(() => expect(h.urls.at(-1)).toMatch(/thumbnails=0$/));
  });

  it("contains native hook failures and restores a usable floating view", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = observation([BUSY]);
    const n = nativeHost();
    install(n.host, h.store);
    await waitFor(() => expect(n.openTabIn).toHaveBeenCalledTimes(1));
    const Body = n.components.get(BODY)!;
    render(
      <>
        <p>Host conversation still works</p>
        <ObservationOverlay store={h.store} />
        <Body
          sessionId="conv-1"
          useTabInfo={() => {
            throw new Error("native tab hook failed");
          }}
        />
      </>,
    );
    await screen.findByTestId("obs-card");
    expect(screen.getByText("Host conversation still works")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop session s1" })).toBeTruthy();
    await act(async () => h.push([BUSY]));
    expect(n.openTabIn).toHaveBeenCalledTimes(1);
  });

  it("keeps a return to an already mounted sidebar from falling back after a timer", async () => {
    vi.useFakeTimers();
    const h = observation([BUSY]);
    const n = nativeHost();
    install(n.host, h.store);
    await act(async () => {});
    await act(async () => h.store.presentation.showFloating());
    await act(async () => h.store.presentation.showSidebar());
    await act(async () => vi.advanceTimersByTime(2000));
    expect(n.openTabIn).toHaveBeenCalledTimes(2);
    expect(h.store.presentation.getSnapshot().floating).toBe(false);
  });
});
