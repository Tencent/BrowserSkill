// better-sidebar carrier for the observation view. When the
// dsh-better-sidebar plugin is installed its client publishes a
// `betterSidebar` cordis service; the client entry then runs the
// registration below and the tracking view moves from the floating card
// into a single-instance sidebar tab (Document PiP pop-out stays available
// from inside the tab). Detection is purely service-based — profiles
// without the sidebar plugin never start this fiber and keep the floating
// overlay.

import { createElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BSK_LOGO_URL } from "./brand-icon";
import { OverlayBody } from "./ObservationOverlay";
import css from "./ObservationOverlay.module.css";
import type { ObservationClientStore } from "./observation-store";
import { useObservationView, usePip, visibleToScope } from "./observation-view";
import { setSidebarMode } from "./sidebar-mode";

/** The tab title — "Browser Skill", distinct from the sidebar's built-in "browser" tab. */
const TAB_TITLE = "Browser Skill";

/** Tab strip icon: the BrowserSkill product mark at the requested size. */
function TabIcon({ size }: { size: number }) {
  return (
    <img
      src={BSK_LOGO_URL}
      width={size}
      height={size}
      alt=""
      aria-hidden
      className={css["brand-icon"]}
    />
  );
}

/**
 * Structural mirrors of dsh-better-sidebar's client service surface (only
 * the slices this integration touches — see the upstream
 * lib/types/client/service.d.ts). Declared locally so the plugin carries no
 * dependency on the sidebar package; the service contract has been stable
 * since v0.4.0 and newer capabilities arrive behind its `features` list.
 */
export interface SidebarTabLike {
  id: string;
  type: string;
  title: string;
}

export interface SidebarLeafLike {
  kind: "leaf";
  id: string;
  tabs: SidebarTabLike[];
  active: string | null;
}

export interface SidebarSplitLike {
  kind: "split";
  id: string;
  dir: "row" | "col";
  sizes: number[];
  children: SidebarNodeLike[];
}

export type SidebarNodeLike = SidebarLeafLike | SidebarSplitLike;

export interface SidebarStateLike {
  splits: SidebarNodeLike;
  bottomSplits: SidebarNodeLike;
  /** Whether the right panel is expanded (the merged drawer on narrow screens). */
  panelOpen?: boolean;
}

export interface SidebarSnapshotLike {
  sessionId?: string;
  state?: SidebarStateLike;
}

/** Props every tab component receives (the slices we read). */
export interface TabComponentPropsLike {
  /** The conversation this sidebar instance belongs to. */
  scope: { sessionId: string };
}

export interface TabDescriptorLike {
  id: string;
  title: string | (() => string);
  icon?: ReactNode | ((size: number) => ReactNode);
  order?: number;
  /** Single-instance: opening focuses the existing tab instead of duplicating. */
  single?: boolean;
  /** Small pill on the tab strip; null/undefined hides it. */
  badge?: (
    ctx: unknown,
    scope: { sessionId: string },
    state: unknown,
  ) => string | number | null | undefined;
  component: (props: TabComponentPropsLike) => ReactNode;
}

export interface BetterSidebarLike {
  registerTab(descriptor: TabDescriptorLike): () => void;
  openTab(seed: {
    type: string;
    title?: string;
    /** Content seed (lands on tab.path); content opens expand the panel. */
    path?: string;
  }): void;
  getSnapshot(): SidebarSnapshotLike;
  /** Sidebar state feed (v0.12+): session switches, state and prefs changes. */
  subscribeState?: (listener: () => void) => () => void;
  isTabEnabled(id: string): boolean;
}

/** The registered tab type id (also the SidebarTab.type value). */
export const OBSERVATION_TAB_TYPE = "browserskill:observation";

/**
 * Inert content seed carried on auto-opened tabs: its mere presence makes
 * the sidebar treat the open as a content open (expanding the hosting panel
 * so the tracking view lands in sight). Never read by our component.
 */
export const OBSERVATION_TAB_PATH = "browser-skill:observation";

/**
 * The observation tab body: the same OverlayBody the floating card renders,
 * minus the card chrome (no drag header, no collapse — the sidebar tab bar
 * owns those), plus the PiP pop-out upgrade. The view is scoped to the
 * sidebar's conversation: only browser sessions started by it (or its
 * descendants) show here — the floating card keeps the global view.
 */
export function ObservationSidebarTab({
  store,
  scopeId,
}: {
  store: ObservationClientStore;
  scopeId: string;
}) {
  const { snapshot, focus, pinnedId, onTogglePin, now } = useObservationView(store, scopeId);
  const { pipWindow, pipSupported, popOut } = usePip();

  const body = (
    <OverlayBody
      store={store}
      focus={focus}
      sessions={snapshot.sessions}
      available={snapshot.available}
      pinnedId={pinnedId}
      onTogglePin={onTogglePin}
      now={now}
      inPip={pipWindow !== null}
      onPopOut={pipWindow === null && pipSupported ? () => popOut() : undefined}
      onClosePip={pipWindow !== null ? () => pipWindow.close() : undefined}
    />
  );

  if (pipWindow !== null) {
    return createPortal(body, pipWindow.document.body);
  }
  return <div className={css["sidebar-tab"]}>{body}</div>;
}

function* leafNodes(node: SidebarNodeLike): Generator<SidebarLeafLike> {
  if (node.kind === "leaf") {
    yield node;
    return;
  }
  for (const child of node.children) yield* leafNodes(child);
}

/** Whether a tab of our type is already open in either sidebar workbench. */
export function observationTabOpen(state: SidebarStateLike | undefined): boolean {
  if (state === undefined) return false;
  for (const root of [state.splits, state.bottomSplits]) {
    for (const leaf of leafNodes(root)) {
      if (leaf.tabs.some((tab) => tab.type === OBSERVATION_TAB_TYPE)) return true;
    }
  }
  return false;
}

/**
 * Register the observation sidebar tab and flip the carrier flag. Returns
 * the disposer the cordis fiber invokes when the sidebar service goes away
 * (plugin unload/HMR): the floating overlay then resumes as the carrier.
 */
export function registerObservationSidebar(
  service: BetterSidebarLike,
  store: ObservationClientStore,
): () => void {
  setSidebarMode(true);
  // Hold the feed for the whole sidebar lifetime so the auto-open watcher
  // sees new sessions even while the tab itself is closed.
  store.acquire();
  const disposeTab = service.registerTab({
    id: OBSERVATION_TAB_TYPE,
    title: TAB_TITLE,
    icon: (size: number) => createElement(TabIcon, { size }),
    single: true,
    // The badge counts only sessions visible to the tab strip's own
    // conversation (global sessions from other conversations stay hidden,
    // mirroring the tab body's scoped view).
    badge: (_ctx, scope) => {
      const count = store
        .getSnapshot()
        .sessions.filter((s) => visibleToScope(s, scope.sessionId)).length;
      return count > 0 ? count : null;
    },
    component: (props) =>
      createElement(ObservationSidebarTab, { store, scopeId: props.scope.sessionId }),
  });

  // Auto-open the tab when a browser session VISIBLE TO the active
  // conversation appears (and right away when one is already live). The
  // evaluation runs on observation publishes AND on sidebar state changes:
  // the latter covers the sidebar store's async init (its state is
  // undefined for the first beats after page load) and conversation
  // switches. The open carries a content seed (`path`): only content opens
  // land in sight — the sidebar expands the hosting panel for them. While
  // the panel is OPEN an existing tab is never re-focused — the user may
  // be reading another page on purpose; while it is collapsed a NEW
  // session (0→N) nudges the tab back into sight, mirroring how the
  // floating card used to reappear.
  const activeVisibleCount = (): number => {
    const activeId = service.getSnapshot().sessionId;
    if (activeId === undefined) return 0;
    return store.getSnapshot().sessions.filter((s) => visibleToScope(s, activeId)).length;
  };
  let previousVisible = activeVisibleCount();
  const evaluate = (): void => {
    const count = activeVisibleCount();
    const { state, sessionId } = service.getSnapshot();
    if (
      state !== undefined &&
      sessionId !== undefined &&
      service.isTabEnabled(OBSERVATION_TAB_TYPE)
    ) {
      const open = observationTabOpen(state);
      if (count > 0 && !open) {
        service.openTab({ type: OBSERVATION_TAB_TYPE, path: OBSERVATION_TAB_PATH });
      } else if (previousVisible === 0 && count > 0 && open && state.panelOpen === false) {
        service.openTab({ type: OBSERVATION_TAB_TYPE, path: OBSERVATION_TAB_PATH });
      }
    }
    previousVisible = count;
  };
  evaluate();
  const unsubscribe = store.subscribe(evaluate);
  const unsubscribeState = service.subscribeState?.(evaluate);

  return () => {
    unsubscribe();
    unsubscribeState?.();
    disposeTab();
    store.release();
    setSidebarMode(false);
  };
}
