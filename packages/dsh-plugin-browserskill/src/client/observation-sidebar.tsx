// better-sidebar carrier for the observation view. When the
// dsh-better-sidebar plugin is installed its client publishes a
// `betterSidebar` cordis service; the client entry then runs the
// registration below and the tracking view moves from the floating card
// into a single-instance sidebar tab (Document PiP pop-out stays available
// from inside the tab). Detection is purely service-based — profiles
// without the sidebar plugin never start this fiber and keep the floating
// overlay.

import { RiGlobalLine } from "@remixicon/react";
import { createElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { OverlayBody } from "./ObservationOverlay";
import css from "./ObservationOverlay.module.css";
import type { ObservationClientStore } from "./observation-store";
import { useObservationView, usePip } from "./observation-view";
import { setSidebarMode } from "./sidebar-mode";

// remixicon's component types target @types/react 19 while the dsh shell
// runs react 18 — the same compile-time-only recast as the overlay.
const IconGlobe = RiGlobalLine as unknown as (props: {
  size?: number | string;
  className?: string;
}) => ReactNode;

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
}

export interface SidebarSnapshotLike {
  sessionId?: string;
  state?: SidebarStateLike;
}

export interface TabDescriptorLike {
  id: string;
  title: string | (() => string);
  icon?: ReactNode | ((size: number) => ReactNode);
  order?: number;
  /** Single-instance: opening focuses the existing tab instead of duplicating. */
  single?: boolean;
  /** Small pill on the tab strip; null/undefined hides it. */
  badge?: () => string | number | null | undefined;
  component: () => ReactNode;
}

export interface BetterSidebarLike {
  registerTab(descriptor: TabDescriptorLike): () => void;
  openTab(seed: { type: string; title?: string }): void;
  getSnapshot(): SidebarSnapshotLike;
  isTabEnabled(id: string): boolean;
}

/** The registered tab type id (also the SidebarTab.type value). */
export const OBSERVATION_TAB_TYPE = "browserskill:observation";

/**
 * The observation tab body: the same OverlayBody the floating card renders,
 * minus the card chrome (no drag header, no collapse — the sidebar tab bar
 * owns those), plus the PiP pop-out upgrade.
 */
export function ObservationSidebarTab({ store }: { store: ObservationClientStore }) {
  const { snapshot, focus, pinnedId, onTogglePin, now } = useObservationView(store);
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
    title: "Browser",
    icon: (size: number) => createElement(IconGlobe, { size }),
    single: true,
    badge: () => {
      const count = store.getSnapshot().sessions.length;
      return count > 0 ? count : null;
    },
    component: () => createElement(ObservationSidebarTab, { store }),
  });

  // Open the tab when the first browser session appears (and right away
  // when one is already live at activation). An already-open tab is never
  // re-focused — the user may be reading another page on purpose. Type-only
  // opens never force the panel open, so this stays as unobtrusive as the
  // floating card's collapsed capsule was.
  let previousCount = store.getSnapshot().sessions.length;
  const maybeOpen = (): void => {
    if (service.getSnapshot().state === undefined) return;
    if (!service.isTabEnabled(OBSERVATION_TAB_TYPE)) return;
    if (observationTabOpen(service.getSnapshot().state)) return;
    service.openTab({ type: OBSERVATION_TAB_TYPE });
  };
  if (previousCount > 0) maybeOpen();
  const unsubscribe = store.subscribe(() => {
    const count = store.getSnapshot().sessions.length;
    if (previousCount === 0 && count > 0) maybeOpen();
    previousCount = count;
  });

  return () => {
    unsubscribe();
    disposeTab();
    store.release();
    setSidebarMode(false);
  };
}
