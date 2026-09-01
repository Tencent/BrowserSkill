import type { DiagnosticSink } from "@/lib/diagnostics";
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
  onSessionsChanged?: () => void;
  diagnostics?: DiagnosticSink;
}

/**
 * Build a coalesced cleanup operation for transport loss.
 *
 * The daemon purges its registry when the extension socket disappears. To
 * keep the extension-side mirror consistent, every local session must follow
 * the normal safe stop path as well: return borrowed tabs, clear refs, detach
 * CDP, and only then close the Agent Window.
 */
export function createDisconnectCleanup(options: DisconnectCleanupOptions) {
  let inFlight: Promise<DisconnectCleanupReport> | null = null;

  return (): Promise<DisconnectCleanupReport> => {
    if (inFlight) {
      options.diagnostics?.("disconnect_cleanup.coalesced", {
        live_session_ids: options.manager.list().map((ctx) => ctx.sessionId),
      });
      return inFlight;
    }
    options.diagnostics?.("disconnect_cleanup.scheduled", {
      live_session_ids: options.manager.list().map((ctx) => ctx.sessionId),
    });
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
  const capturedSessions = options.manager.list();
  options.diagnostics?.("disconnect_cleanup.started", {
    captured_session_ids: capturedSessions.map((ctx) => ctx.sessionId),
  });

  for (const ctx of capturedSessions) {
    options.diagnostics?.("disconnect_cleanup.session_stop.started", {
      session_id: ctx.sessionId,
      agent_window_id: ctx.agentWindowId,
      still_registered: options.manager.has(ctx.sessionId),
    });
    try {
      const result = await handleSessionStop(
        options.manager,
        { session_id: ctx.sessionId },
        options.sessionStopDeps,
      );
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
      options.diagnostics?.("disconnect_cleanup.session_stop.completed", {
        session_id: ctx.sessionId,
      });
    } catch (err) {
      failures.push({
        sessionId: ctx.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      options.diagnostics?.("disconnect_cleanup.session_stop.failed", {
        session_id: ctx.sessionId,
        error: err,
      });
    }
  }

  options.onSessionsChanged?.();
  options.diagnostics?.("disconnect_cleanup.completed", {
    stopped_session_ids: stoppedSessionIds,
    failures,
    remaining_session_ids: options.manager.list().map((ctx) => ctx.sessionId),
  });
  return { stoppedSessionIds, failures };
}
