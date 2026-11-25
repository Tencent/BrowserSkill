import { withSessionDialogCleanup } from "@/tools/dialogs";
import { handleSessionStop, type SessionStopDeps } from "@/tools/session";
import type { SessionManager } from "./manager";

export interface DisconnectCleanupFailure {
  sessionId: string;
  message: string;
}

export interface DisconnectCleanupReport {
  stoppedSessionIds: string[];
  failures: DisconnectCleanupFailure[];
}

export interface DisconnectCleanupOptions {
  manager: SessionManager;
  sessionStopDeps?: SessionStopDeps;
  /** Cancel all in-flight RPCs and stop accepting new requests on the outgoing connection. */
  cancelAll?: () => void;
  /** Briefly await cancelled in-flight `tool.session_start` RPCs before enumerating sessions. */
  awaitPendingStarts?: () => Promise<void>;
  /** Cancel in-flight RPCs belonging to `sessionId` before tearing the session down. */
  cancelSession?: (sessionId: string) => void;
  /** Briefly await cancelled in-flight RPCs for `sessionId` after dialog dismissal. */
  awaitSessionCancelled?: (sessionId: string) => Promise<void>;
  /** Clear hover latches and `OVERLAY_AUTOMATION_BYPASS` state (per-session or global). */
  releaseHover?: (sessionId?: string) => void | Promise<void>;
  /** Dismiss pending and chained JS dialogs while tearing down `sessionId`. */
  withDialogCleanup?: <T>(sessionId: string, stop: () => Promise<T>) => Promise<T>;
  /** Release per-session side state once a session is removed (e.g. cooperation, exports, runners). */
  onSessionStopped?: (sessionId: string) => void | Promise<void>;
  onSessionsChanged?: () => void;
}

/**
 * Build a coalesced cleanup operation for transport loss.
 *
 * The daemon purges its registry when the extension socket disappears. To
 * keep the extension-side mirror consistent, every local session must cancel
 * in-flight work, dismiss blocking dialogs, clear hover bypass overlays, and
 * follow the normal safe stop path: return borrowed tabs, clear refs, detach
 * CDP, and only then close the Agent Window.
 */
export function createDisconnectCleanup(options: DisconnectCleanupOptions) {
  let inFlight: Promise<DisconnectCleanupReport> | null = null;

  return (): Promise<DisconnectCleanupReport> => {
    if (inFlight) return inFlight;
    inFlight = cleanupSessions(options).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

async function cleanupSessions(
  options: DisconnectCleanupOptions,
): Promise<DisconnectCleanupReport> {
  const stoppedSessionIds: string[] = [];
  const failures: DisconnectCleanupFailure[] = [];

  options.cancelAll?.();
  await options.awaitPendingStarts?.();
  const runWithDialogCleanup =
    options.withDialogCleanup ??
    (<T>(sessionId: string, stop: () => Promise<T>) =>
      withSessionDialogCleanup(options.manager, options.sessionStopDeps?.cdp, sessionId, stop));

  for (const ctx of options.manager.list()) {
    try {
      options.cancelSession?.(ctx.sessionId);
      const result = await runWithDialogCleanup(ctx.sessionId, async () => {
        await options.awaitSessionCancelled?.(ctx.sessionId);
        await options.releaseHover?.(ctx.sessionId);
        const outcome = await handleSessionStop(
          options.manager,
          { session_id: ctx.sessionId },
          options.sessionStopDeps,
        );
        if (!options.manager.has(ctx.sessionId)) {
          await options.onSessionStopped?.(ctx.sessionId);
        }
        return outcome;
      });
      if ("code" in result) {
        failures.push({ sessionId: ctx.sessionId, message: result.message });
        continue;
      }
      if (result.return_failures?.length) {
        failures.push({
          sessionId: ctx.sessionId,
          message: result.return_failures.map((failure) => failure.message).join("; "),
        });
        continue;
      }
      stoppedSessionIds.push(ctx.sessionId);
    } catch (err) {
      failures.push({
        sessionId: ctx.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clear any residual hover latches / bypasses left by sessions that closed just before disconnect.
  await Promise.resolve(options.releaseHover?.()).catch(() => {});
  options.onSessionsChanged?.();
  return { stoppedSessionIds, failures };
}
