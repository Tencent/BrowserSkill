/** Native DSH right-Sidebar carrier. All runtime collaboration uses optional host services. */
import { Component, type ReactNode, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BSK_LOGO_URL } from "./brand-icon";
import { OverlayBody } from "./ObservationOverlay";
import css from "./ObservationOverlay.module.css";
import type { ObservationClientStore } from "./observation-store";
import { useObservationView, usePip, visibleToScope } from "./observation-view";

export const OBSERVATION_TAB_KIND = "browserskill-observation";
export const OBSERVATION_TAB_ID = "@wxg-prc-cpg/browser-skill-dsh-plugin/observation";
const TAB_TITLE = "Browser Skill";
const BODY_SLOT = "sidebar.right.pane.tab";
const TITLE_SLOT = "sidebar.right.pane.tab.title";

/**
 * Narrow public contract from dsh-client-ui-sidebar-right 0.1.5-rc.1.
 * No value imports: older hosts need neither the package nor its module-loader entry.
 * openTabIn is the exported controller's session-addressed navigation method;
 * the mounted-only openTab can act on the previous conversation during a switch.
 */
export interface NativeSidebar {
  openTabIn(sessionId: string, kind: string): void;
}

export interface NativeTabDefinition {
  id: string;
  kind: string;
  title: () => string;
  guide: { order: number; title: () => string; description: () => string; icon: typeof TabIcon }[];
}

export interface NativeTabProps {
  sessionId: string;
  useTabInfo: () => { tab: { visible: boolean } };
}

export interface NativeSidebarSlots {
  inject(name: string, callback: () => () => void): () => void;
  register(
    options: { name: string; key: string },
    component: (props: NativeTabProps) => ReactNode,
  ): () => void;
}

export interface SessionListSource {
  getSnapshot(): { current: string | undefined };
  subscribe(listener: () => void): () => void;
}

export interface NativeSidebarHost {
  slots: NativeSidebarSlots;
  get(name: string): unknown;
}

function TabIcon({ size = 16 }: { size?: number }) {
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

/** Same observation content as the overlay, scoped by the native slot's session identity. */
export function ObservationSidebarTab({
  store,
  scopeId,
  visible = true,
}: {
  store: ObservationClientStore;
  scopeId: string;
  visible?: boolean;
}) {
  const { snapshot, focus, pinnedId, onTogglePin, now } = useObservationView(store, scopeId);
  const { pipWindow, pipSupported, popOut } = usePip();
  const presentation = useSyncExternalStore(
    store.presentation.subscribe,
    store.presentation.getSnapshot,
  );

  if (presentation.floating && presentation.sidebarAvailable) {
    return (
      <div className={`${css["floating-notice"]} bsk-obs`}>
        <p>The browser view is in a floating window.</p>
        <button type="button" onClick={store.presentation.showSidebar}>
          Show here
        </button>
      </div>
    );
  }

  const body = (
    <OverlayBody
      store={store}
      focus={focus}
      sessions={snapshot.sessions}
      available={snapshot.available}
      pinnedId={pinnedId}
      onTogglePin={onTogglePin}
      now={now}
      visible={visible || pipWindow !== null}
      inPip={pipWindow !== null}
      onPopOut={pipWindow === null && pipSupported ? () => popOut() : undefined}
      onClosePip={pipWindow !== null ? () => pipWindow.close() : undefined}
      onUseFloating={() => {
        pipWindow?.close();
        store.presentation.showFloating();
      }}
    />
  );
  if (pipWindow !== null) return createPortal(body, pipWindow.document.body);
  return <div className={css["sidebar-tab"]}>{body}</div>;
}

function ObservationTitle({ store, scopeId }: { store: ObservationClientStore; scopeId: string }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const count = snapshot.sessions.filter((session) => visibleToScope(session, scopeId)).length;
  return (
    <span className={css["tab-title"]}>
      <TabIcon size={14} />
      {TAB_TITLE}
      {count > 0 ? ` (${count})` : ""}
    </span>
  );
}

function reportFailure(error: unknown): void {
  console.warn("[browser-skill] native sidebar unavailable; using floating view", error);
}

/** A native hook or view failure must never reach DSH's surrounding workbench. */
class ObservationBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Wait for both native seats, then install the type and its keyed renderers as
 * one lifetime. Missing native services are normal, including on older DSH.
 */
export function registerObservationSidebar(
  host: NativeSidebarHost,
  store: ObservationClientStore,
): () => void {
  const sidebar = host.get("sidebarRight") as NativeSidebar | undefined;
  const tabs = host.get("sidebarRightTabs") as
    | { register(definition: NativeTabDefinition): () => void }
    | undefined;
  const sessions = (host.get("sessions") as { list?: SessionListSource } | undefined)?.list;
  if (
    typeof sidebar?.openTabIn !== "function" ||
    typeof tabs?.register !== "function" ||
    typeof sessions?.getSnapshot !== "function" ||
    typeof sessions?.subscribe !== "function"
  )
    return () => {};

  return host.slots.inject(BODY_SLOT, () =>
    host.slots.inject(TITLE_SLOT, () => {
      const disposers: (() => void)[] = [];
      const autoOpened = new Set<string>();
      const mounted = new Map<string, number>();
      let disposed = false;
      let failed = false;
      let scheduled = false;
      let disconnect: (() => void) | undefined;
      let pending:
        | { sessionId: string; attempts: number; timer?: ReturnType<typeof setTimeout> }
        | undefined;

      const cancelOpen = () => {
        clearTimeout(pending?.timer);
        pending = undefined;
      };
      const fallback = () => {
        cancelOpen();
        disconnect?.();
        disconnect = undefined;
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        fallback();
        for (const release of disposers.reverse()) release();
      };
      const connect = () => {
        if (failed) return;
        disconnect ??= store.presentation.connectSidebar(reveal);
      };
      const fail = (error: unknown) => {
        failed = true;
        fallback();
        reportFailure(error);
      };
      // The controller can receive an open before its per-session store is
      // adopted (it deliberately no-ops then). Only retry that initial handoff;
      // a mounted body/title acknowledges it, stopping retries before normal
      // observation updates or a user's later close can cause another reveal.
      const open = (sessionId: string) => {
        cancelOpen();
        const request = {
          sessionId,
          attempts: 0,
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        pending = request;
        const attempt = () => {
          if (disposed || pending !== request) return;
          try {
            if (
              sessions.getSnapshot().current !== sessionId ||
              store.presentation.getSnapshot().floating
            ) {
              cancelOpen();
              return;
            }
            sidebar.openTabIn(sessionId, OBSERVATION_TAB_KIND);
          } catch (error) {
            fail(error);
            return;
          }
          if (mounted.has(sessionId)) {
            autoOpened.add(sessionId);
            cancelOpen();
          }
          if (pending !== request) return;
          request.attempts += 1;
          request.timer = setTimeout(() => {
            if (pending !== request) return;
            if (request.attempts < 4) attempt();
            else fallback();
          }, 250);
        };
        attempt();
      };
      function reveal() {
        try {
          const current = sessions?.getSnapshot().current;
          if (current !== undefined) open(current);
        } catch (error) {
          fail(error);
        }
      }
      const acknowledge = (sessionId: string) => {
        if (disposed) return;
        mounted.set(sessionId, (mounted.get(sessionId) ?? 0) + 1);
        autoOpened.add(sessionId);
        if (pending?.sessionId === sessionId) cancelOpen();
        connect();
        return () => {
          const remaining = (mounted.get(sessionId) ?? 1) - 1;
          if (remaining === 0) mounted.delete(sessionId);
          else mounted.set(sessionId, remaining);
        };
      };
      const evaluate = () => {
        if (disposed) return;
        const current = sessions.getSnapshot().current;
        const observations = store.getSnapshot().sessions;
        for (const id of autoOpened) {
          if (!observations.some((session) => visibleToScope(session, id))) autoOpened.delete(id);
        }
        if (
          pending !== undefined &&
          (pending.sessionId !== current || store.presentation.getSnapshot().floating)
        )
          cancelOpen();
        if (
          current === undefined ||
          store.presentation.getSnapshot().floating ||
          pending !== undefined ||
          autoOpened.has(current)
        )
          return;
        if (observations.some((session) => visibleToScope(session, current))) open(current);
      };
      // Host and SSE subscriptions are synchronous. Defer opens out of their
      // notifications so a navigation cannot recursively re-enter the host.
      const schedule = () => {
        if (disposed || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          try {
            evaluate();
          } catch (error) {
            fail(error);
          }
        });
      };

      function NativeBody(props: NativeTabProps) {
        const { tab } = props.useTabInfo();
        useEffect(() => acknowledge(props.sessionId), [props.sessionId]);
        return (
          <ObservationSidebarTab store={store} scopeId={props.sessionId} visible={tab.visible} />
        );
      }

      try {
        disposers.push(
          host.slots.register({ name: BODY_SLOT, key: OBSERVATION_TAB_ID }, function Body(props) {
            return (
              <ObservationBoundary onError={fail}>
                <NativeBody {...props} />
              </ObservationBoundary>
            );
          }),
        );
        disposers.push(
          host.slots.register({ name: TITLE_SLOT, key: OBSERVATION_TAB_ID }, function Title(props) {
            useEffect(() => acknowledge(props.sessionId), [props.sessionId]);
            return <ObservationTitle store={store} scopeId={props.sessionId} />;
          }),
        );
        disposers.push(
          tabs.register({
            id: OBSERVATION_TAB_ID,
            kind: OBSERVATION_TAB_KIND,
            title: () => TAB_TITLE,
            guide: [
              {
                order: 60,
                title: () => TAB_TITLE,
                description: () => "Watch browser activity and control running sessions.",
                icon: TabIcon,
              },
            ],
          }),
        );
        disposers.push(() => store.release());
        store.acquire();
        disposers.push(store.subscribe(schedule));
        disposers.push(sessions.subscribe(schedule));
        disposers.push(store.presentation.subscribe(schedule));
        connect();
        schedule();
      } catch (error) {
        dispose();
        reportFailure(error);
      }
      return dispose;
    }),
  );
}
