// @vitest-environment happy-dom
// better-sidebar carrier: tab registration + auto-open, the sidebar-mode
// flag hiding the floating overlay, PiP pop-out from the tab, and the
// store's refcounted acquire/release across overlapping carriers.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationOverlay } from "../../src/client/ObservationOverlay";
import {
  type BetterSidebarLike,
  OBSERVATION_TAB_PATH,
  OBSERVATION_TAB_TYPE,
  ObservationSidebarTab,
  observationTabOpen,
  registerObservationSidebar,
  type SidebarNodeLike,
  type SidebarStateLike,
  type TabDescriptorLike,
} from "../../src/client/observation-sidebar";
import { type EventSourceLike, ObservationClientStore } from "../../src/client/observation-store";
import { getSidebarMode, setSidebarMode } from "../../src/client/sidebar-mode";
import type { SessionObservation } from "../../src/observation";

// Owned by the sidebar mock's active conversation ("conv-1") so the scoped
// visibility logic lets it through; FOREIGN belongs to another conversation.
const BUSY: SessionObservation = {
  sessionId: "s1",
  action: "clicking",
  since: Date.now() - 7000,
  dshSessionIds: ["conv-1"],
};
const FOREIGN: SessionObservation = {
  sessionId: "s9",
  action: "clicking",
  since: Date.now() - 5000,
  dshSessionIds: ["other-conv"],
};

interface Harness {
  store: ObservationClientStore;
  es: () => EventSourceLike | undefined;
  push: (sessions: SessionObservation[]) => void;
}

function makeHarness(initial: SessionObservation[]): Harness {
  let es: EventSourceLike | undefined;
  let current = initial;
  const store = new ObservationClientStore({
    fetchFn: async (url: string) => {
      if (url === "/bsk-observation/state") {
        return { ok: true, json: async () => ({ sessions: current }) };
      }
      return { ok: true, json: async () => ({ interrupted: true }) };
    },
    eventSourceFactory: () => {
      es = { onmessage: null, close: vi.fn() };
      return es;
    },
    loadImage: async (id: string) => `blob:${id}`,
  });
  return {
    store,
    es: () => es,
    push: (sessions) => {
      current = sessions;
      for (const s of sessions) {
        es?.onmessage?.({ data: JSON.stringify({ type: "upsert", session: s }) });
      }
      if (sessions.length === 0) es?.onmessage?.({ data: JSON.stringify({ type: "reset" }) });
    },
  };
}

function leafWith(type: string, panelOpen = true): SidebarStateLike {
  return {
    panelOpen,
    splits: {
      kind: "split",
      id: "root",
      dir: "row",
      sizes: [1],
      children: [
        {
          kind: "leaf",
          id: "pane-1",
          active: type,
          tabs: [{ id: type, type, title: type }],
        },
      ],
    },
    bottomSplits: { kind: "leaf", id: "pane-2", active: null, tabs: [] },
  };
}

interface SidebarMock {
  service: BetterSidebarLike;
  descriptor: () => TabDescriptorLike;
  openTab: ReturnType<typeof vi.fn>;
  disposeTab: ReturnType<typeof vi.fn>;
  setState: (state: SidebarStateLike | undefined) => void;
}

/** Insert a tab into the first leaf of the main tree (mirrors a real open). */
function withTabOpened(state: SidebarStateLike, type: string): SidebarStateLike {
  let done = false;
  const walk = (node: SidebarNodeLike): SidebarNodeLike => {
    if (done) return node;
    if (node.kind === "leaf") {
      done = true;
      return { ...node, active: type, tabs: [...node.tabs, { id: type, type, title: type }] };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return { ...state, splits: walk(state.splits) };
}

function makeSidebar(
  initialState: SidebarStateLike | undefined = leafWith("explorer"),
): SidebarMock {
  let descriptor: TabDescriptorLike | undefined;
  let state: SidebarStateLike | undefined = initialState;
  const openTab = vi.fn((seed: { type: string }) => {
    // Mirror the real feedback loop: a created tab lands in the state, so
    // later evaluations see it open (single-instance dedupe re-focuses).
    if (state !== undefined && !observationTabOpen(state)) {
      state = withTabOpened(state, seed.type);
    }
  });
  const disposeTab = vi.fn();
  const service: BetterSidebarLike = {
    registerTab: (next) => {
      descriptor = next;
      return disposeTab;
    },
    openTab,
    getSnapshot: () => ({ sessionId: "conv-1", state }),
    isTabEnabled: () => true,
  };
  return {
    service,
    descriptor: () => {
      if (descriptor === undefined) throw new Error("no tab registered");
      return descriptor;
    },
    openTab,
    disposeTab,
    setState: (next) => {
      state = next;
    },
  };
}

afterEach(() => {
  cleanup();
  setSidebarMode(false);
});

describe("registerObservationSidebar", () => {
  it("registers a single-instance tab and flips the carrier flag", () => {
    const h = makeHarness([]);
    const sidebar = makeSidebar();
    expect(getSidebarMode()).toBe(false);
    const dispose = registerObservationSidebar(sidebar.service, h.store);
    expect(getSidebarMode()).toBe(true);
    const descriptor = sidebar.descriptor();
    expect(descriptor.id).toBe(OBSERVATION_TAB_TYPE);
    expect(descriptor.single).toBe(true);
    expect(descriptor.title).toBe("Browser Skill");
    dispose();
    expect(getSidebarMode()).toBe(false);
    expect(sidebar.disposeTab).toHaveBeenCalledTimes(1);
  });

  it("holds the observation feed for the sidebar lifetime", () => {
    const h = makeHarness([]);
    const sidebar = makeSidebar();
    const dispose = registerObservationSidebar(sidebar.service, h.store);
    expect(h.es()).toBeDefined();
    dispose();
    expect(h.es()?.close).toHaveBeenCalled?.();
  });

  it("opens the tab right away when a session is already live at activation", async () => {
    const h = makeHarness([BUSY]);
    const sidebar = makeSidebar();
    registerObservationSidebar(sidebar.service, h.store);
    // The initial state fetch lands asynchronously; the 0→N watcher then fires.
    await waitFor(() =>
      expect(sidebar.openTab).toHaveBeenCalledWith({
        type: OBSERVATION_TAB_TYPE,
        path: OBSERVATION_TAB_PATH,
      }),
    );
  });

  it("auto-opens on the first session but never re-focuses an open tab", async () => {
    const h = makeHarness([]);
    const sidebar = makeSidebar();
    registerObservationSidebar(sidebar.service, h.store);
    expect(sidebar.openTab).not.toHaveBeenCalled();
    // First session arrives: the tab lands in the sidebar.
    h.push([BUSY]);
    await waitFor(() => expect(sidebar.openTab).toHaveBeenCalledTimes(1));
    // The sidebar now reports the tab open (persisted/restored): further
    // session arrivals must not steal focus from whatever the user reads.
    sidebar.setState(leafWith(OBSERVATION_TAB_TYPE));
    h.push([]);
    h.push([{ ...BUSY, sessionId: "s2" }]);
    h.push([]);
    h.push([{ ...BUSY, sessionId: "s3" }]);
    await waitFor(() => expect(h.store.getSnapshot().sessions.length).toBe(1));
    expect(sidebar.openTab).toHaveBeenCalledTimes(1);
  });

  it("does not open while the sidebar has no active session state", () => {
    const h = makeHarness([BUSY]);
    const sidebar = makeSidebar(undefined);
    registerObservationSidebar(sidebar.service, h.store);
    expect(sidebar.openTab).not.toHaveBeenCalled();
  });

  it("nudges an existing tab back into sight when the panel is collapsed", async () => {
    const h = makeHarness([]);
    // Tab already open (persisted), but the panel is collapsed: a new
    // session should surface the tracking view again (focus + expand via a
    // content open), like the floating card reappearing.
    const sidebar = makeSidebar(leafWith(OBSERVATION_TAB_TYPE, false));
    registerObservationSidebar(sidebar.service, h.store);
    h.push([BUSY]);
    await waitFor(() =>
      expect(sidebar.openTab).toHaveBeenCalledWith({
        type: OBSERVATION_TAB_TYPE,
        path: OBSERVATION_TAB_PATH,
      }),
    );
  });

  it("shows the visible session count as the tab badge", () => {
    const h = makeHarness([]);
    const sidebar = makeSidebar();
    registerObservationSidebar(sidebar.service, h.store);
    const badge = sidebar.descriptor().badge;
    const scope = { sessionId: "conv-1" };
    expect(badge?.(undefined, scope, undefined)).toBeNull();
    h.store.acquire();
    h.push([BUSY, FOREIGN]);
    expect(badge?.(undefined, scope, undefined)).toBe(1);
    expect(badge?.(undefined, { sessionId: "other-conv" }, undefined)).toBe(1);
    expect(badge?.(undefined, { sessionId: "nobody" }, undefined)).toBeNull();
    h.store.release();
  });

  it("does not auto-open for sessions owned by other conversations", async () => {
    const h = makeHarness([]);
    const sidebar = makeSidebar();
    registerObservationSidebar(sidebar.service, h.store);
    h.push([FOREIGN]);
    await waitFor(() => expect(h.store.getSnapshot().sessions.length).toBe(1));
    expect(sidebar.openTab).not.toHaveBeenCalled();
    // A session visible to the active conversation does open the tab.
    h.push([BUSY]);
    await waitFor(() => expect(sidebar.openTab).toHaveBeenCalledTimes(1));
  });

  it("uses the BrowserSkill product mark as the tab icon", () => {
    const h = makeHarness([]);
    const sidebar = makeSidebar();
    registerObservationSidebar(sidebar.service, h.store);
    const icon = sidebar.descriptor().icon as (size: number) => ReactNode;
    const { container } = render(<>{icon(16)}</>);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("data:image/png;base64,");
    expect(img?.getAttribute("width")).toBe("16");
  });
});

describe("observationTabOpen", () => {
  it("finds the tab in either workbench tree", () => {
    expect(observationTabOpen(undefined)).toBe(false);
    expect(observationTabOpen(leafWith("explorer"))).toBe(false);
    expect(observationTabOpen(leafWith(OBSERVATION_TAB_TYPE))).toBe(true);
    const inBottom: SidebarStateLike = {
      splits: { kind: "leaf", id: "p1", active: null, tabs: [] },
      bottomSplits: {
        kind: "leaf",
        id: "p2",
        active: OBSERVATION_TAB_TYPE,
        tabs: [{ id: OBSERVATION_TAB_TYPE, type: OBSERVATION_TAB_TYPE, title: "Browser" }],
      },
    };
    expect(observationTabOpen(inBottom)).toBe(true);
  });
});

describe("ObservationSidebarTab", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
  });

  it("renders the tracking view without card chrome (no collapse, no drag header)", async () => {
    const h = makeHarness([BUSY]);
    render(<ObservationSidebarTab store={h.store} scopeId="conv-1" />);
    await screen.findByText(/s1 · clicking/);
    expect(screen.queryByRole("button", { name: "Collapse" })).toBeNull();
    expect(screen.getByTestId("obs-header").dataset.draggable).toBeUndefined();
    // No resize handles — the sidebar owns the geometry.
    expect(screen.queryByTestId("obs-resize-se")).toBeNull();
    // Session controls ride along: interrupt + stop-with-confirm.
    expect(screen.getByRole("button", { name: "Stop session s1" })).toBeTruthy();
  });

  it("scopes the view to the sidebar's conversation", async () => {
    const h = makeHarness([BUSY, FOREIGN]);
    render(<ObservationSidebarTab store={h.store} scopeId="conv-1" />);
    // Focus and content belong to the owned session; the foreign one never
    // reaches the stage, the status line, or the strip (which needs 2+).
    await screen.findByText(/s1 · clicking/);
    expect(screen.queryByText(/s9/)).toBeNull();
    expect(screen.queryByTestId("obs-strip")).toBeNull();
    // Scoping to the other conversation swaps what's visible.
    render(<ObservationSidebarTab store={h.store} scopeId="other-conv" />);
    await screen.findByText(/s9 · clicking/);
  });

  it("still pops out into a PiP window and returns on pagehide", async () => {
    const h = makeHarness([BUSY]);
    const pipDoc = document.implementation.createHTMLDocument("pip");
    const listeners = new Map<string, (() => void)[]>();
    (window as unknown as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: vi.fn(async () => {
        return {
          document: pipDoc,
          addEventListener: (name: string, fn: () => void) => {
            listeners.set(name, [...(listeners.get(name) ?? []), fn]);
          },
        } as unknown as Window;
      }),
    };
    render(<ObservationSidebarTab store={h.store} scopeId="conv-1" />);
    const popout = await screen.findByRole("button", { name: /Pop out/ });
    fireEvent.click(popout);
    await waitFor(() => expect(pipDoc.body.textContent).toContain("s1"));
    for (const fn of listeners.get("pagehide") ?? []) fn();
    await screen.findByText(/s1 · clicking/);
  });
});

describe("carrier switching", () => {
  it("hides the floating overlay while sidebar mode is active", async () => {
    const h = makeHarness([]);
    const { container } = render(<ObservationOverlay store={h.store} />);
    h.push([BUSY]);
    await screen.findByTestId("obs-card");
    setSidebarMode(true);
    await waitFor(() => expect(container.firstChild).toBeNull());
    setSidebarMode(false);
    await screen.findByTestId("obs-card");
  });

  it("keeps the feed alive across overlapping carriers (refcount)", async () => {
    const h = makeHarness([]);
    const overlay = render(<ObservationOverlay store={h.store} />);
    await waitFor(() => expect(h.es()).toBeDefined());
    // A second carrier mounts (the sidebar tab), then the overlay unmounts:
    // the stream must survive for the remaining consumer.
    const tab = render(<ObservationSidebarTab store={h.store} scopeId="conv-1" />);
    overlay.unmount();
    h.push([BUSY]);
    await screen.findByText(/s1 · clicking/);
    expect(h.es()?.close ?? vi.fn()).not.toHaveBeenCalled();
    tab.unmount();
  });
});
