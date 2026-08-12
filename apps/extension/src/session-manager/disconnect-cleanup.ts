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

  for (const ctx of options.manager.list()) {
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
    } catch (err) {
      failures.push({
        sessionId: ctx.sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  options.onSessionsChanged?.();
  return { stoppedSessionIds, failures };
}
