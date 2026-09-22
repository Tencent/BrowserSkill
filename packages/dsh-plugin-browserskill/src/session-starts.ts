import { randomUUID } from "node:crypto";
import {
  bskInstallMessage,
  isCommandNotFound,
  parseBskJson,
  runWithSessionBusyRetry,
} from "./runner";
import { memoryStartJournal, type StartJournal, type StartRecord } from "./start-journal";
import type { ToolDeps } from "./tools";

interface RequestStatus {
  state:
    | "prepared"
    | "unknown"
    | "starting"
    | "ready"
    | "active"
    | "cancelling"
    | "cleanup_failed"
    | "closed"
    | "failed";
  session?: { session_id: string; browser_instance_id: string } | null;
  cleanup_error?: string | null;
}

export interface StopOptions {
  sessionId?: string;
  /** Exact target for recovery, including starts that never returned a session ID. */
  requestId?: string;
  signal?: AbortSignal;
}

export interface StopResult {
  stopped: string;
  requestId: string;
  alreadyClosed: boolean;
}

/** The one lifecycle owner for pending, live, and failed-cleanup starts. */
export class SessionStarts {
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly cleaning = new Map<string, Promise<void>>();
  private readonly reserved = new Set<string>();

  constructor(
    private readonly deps: ToolDeps,
    readonly journal: StartJournal = memoryStartJournal(),
  ) {}

  begin(owners: string[]): StartRecord {
    if (this.closing) throw new Error("browser plugin is unloading");
    const archived = this.deps.ctx.get("workspaceRegistry") as
      | { archivedSessionIds?: string[] }
      | undefined;
    if (owners.some((id) => archived?.archivedSessionIds?.includes(id)))
      throw new Error("browser conversation is archived");
    // Recovered requests may still own windows even without a returned session
    // ID. Count them before admitting more work into this plugin's capacity.
    const recoveredPending = [...this.journal.records.values()].filter(
      (r) =>
        r.stop !== "closed" && !this.reserved.has(r.requestId) && !this.ownsRegisteredSession(r),
    ).length;
    this.deps.registry.reserveStart(recoveredPending);
    const record: StartRecord = {
      requestId: `${Date.now() + 5 * 60_000}:${randomUUID()}`,
      owners,
      startedAtMs: Date.now(),
      cleanup: false,
    };
    this.reserved.add(record.requestId);
    this.journal.records.set(record.requestId, record);
    try {
      this.journal.save();
    } catch (error) {
      this.forget(record);
      throw error;
    }
    return record;
  }

  async prepare(record: StartRecord, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.deps.runner.run(
        ["session", "request", record.requestId, "--prepare"],
        { signal, timeoutMs: 30_000 },
      );
      if (signal.aborted || result.aborted)
        throw new DOMException("tool call aborted", "AbortError");
      const status = parseBskJson(result, "session request prepare") as RequestStatus;
      if (status.state !== "prepared")
        throw new Error("Browser start preparation failed; use matching CLI and daemon versions.");
      this.assertStarting(record);
    } catch (error) {
      // No start has been sent. An independently accepted stop still owns its
      // cancellation job/receipt; a late prepare must not discard that intent.
      if (!record.cleanup && !record.stop) this.forget(record);
      if (isCommandNotFound(error)) throw new Error(bskInstallMessage(this.deps.config.bskPath));
      throw error;
    }
  }

  assertStarting(record: StartRecord): void {
    if (
      this.closing ||
      record.cleanup ||
      record.stop ||
      !this.journal.records.has(record.requestId)
    )
      throw new Error("browser start was cancelled during cleanup");
  }

  register(record: StartRecord, reply: { session_id: string; browser_instance_id: string }): void {
    this.assertStarting(record);
    if (typeof reply.session_id !== "string" || typeof reply.browser_instance_id !== "string")
      throw new Error("invalid browser start result");
    record.session = { sessionId: reply.session_id, browserInstanceId: reply.browser_instance_id };
    this.journal.save();
    this.adopt(record);
  }

  private adopt(record: StartRecord): void {
    if (!record.session) return;
    if (this.deps.registry.isOwned(record.session.sessionId)) {
      if (this.ownsRegisteredSession(record)) return;
      throw new Error("browser session id conflicts with another owned start");
    }
    if (!this.reserved.has(record.requestId)) this.deps.registry.reserveStart();
    this.deps.registry.trackStart(
      {
        ...record.session,
        requestId: record.requestId,
        startedAtMs: record.startedAtMs,
      },
      record.cleanup ? "cleanup" : "starting",
    );
    this.reserved.delete(record.requestId);
    this.deps.registry.trackOwner(record.session.sessionId, record.owners);
    this.deps.observation.addSession(record.session.sessionId);
  }

  async claim(record: StartRecord, signal: AbortSignal): Promise<void> {
    this.assertStarting(record);
    if (!record.session || !this.ownsRegisteredSession(record))
      throw new Error("browser start must be registered before claiming it");
    const result = await this.deps.runner.run(["session", "request", record.requestId, "--claim"], {
      timeoutMs: 30_000,
      signal,
    });
    if (signal.aborted || result.aborted) throw new DOMException("tool call aborted", "AbortError");
    const status = parseBskJson(result, "session request") as RequestStatus;
    if (status.state !== "active") throw new Error("browser start could not be claimed");
    this.assertStarting(record);
    this.deps.registry.activate(record.session.sessionId);
    this.deps.observation.endAction(record.session.sessionId);
  }

  /** Accept a durable stop; aborting its caller only cancels waiting, never cleanup. */
  async stop({ sessionId, requestId, signal }: StopOptions = {}): Promise<StopResult> {
    if (signal?.aborted) throw abortError();
    if (this.closing) throw new Error("browser plugin is unloading");
    const record = this.resolveStop(sessionId, requestId);
    const stopped = record.session?.sessionId ?? "pending browser starts";
    const alreadyClosed = record.stop === "closed";
    const implicit = !sessionId?.trim() && requestId === undefined;
    let admitted = false;
    try {
      if (!alreadyClosed || (implicit && record.defaultStopRevision === undefined))
        this.requestCleanup(record, true, implicit);
      admitted = true;
      const revision = implicit ? record.defaultStopRevision : undefined;
      if (!alreadyClosed) await waitForCleanup(this.cancel(record), signal);
      if (signal?.aborted) throw abortError();
      // An explicit/overlay caller, or a concurrent waiter that predates another
      // caller's failure, must not consume that caller's default retry target.
      if (record.defaultStopRevision === undefined || revision === record.defaultStopRevision) {
        this.journal.records.delete(record.requestId);
        try {
          this.journal.save();
        } catch (error) {
          this.journal.records.set(record.requestId, record);
          throw error;
        }
      }
      return { stopped, requestId: record.requestId, alreadyClosed };
    } catch (error) {
      if (implicit && admitted) {
        // Restore even if another waiter just acknowledged completion. Keeping
        // this receipt ensures the failed call can never fall through to A.
        record.defaultStopRevision = (record.defaultStopRevision ?? 0) + 1;
        this.journal.records.set(record.requestId, record);
        try {
          this.journal.save();
        } catch (saveError) {
          console.warn("Browser stop retry receipt write failed", saveError);
        }
      }
      throw error;
    }
  }

  private resolveStop(sessionId?: string, requestId?: string): StartRecord {
    if (requestId !== undefined) {
      if (sessionId !== undefined) throw new Error("Specify either session or requestId, not both");
      const record = this.journal.records.get(requestId);
      if (!record) throw new Error("browser stop request does not belong to this plugin");
      return record;
    }
    const records = [...this.journal.records.values()];
    const receipts = records.filter((r) => r.stop !== undefined);
    if (sessionId?.trim()) {
      // Prefer a previous stop even if Chrome has since reused its short ID.
      const receipt = receipts.find((r) => r.session?.sessionId === sessionId);
      if (receipt) return receipt;
    } else {
      if (receipts.length === 1) return receipts[0];
      if (receipts.length > 1) {
        throw new Error(
          `Several stops await acknowledgement (${receipts.map((r) => `${r.session?.sessionId ?? "pending start"}: ${r.requestId}`).join(", ")}); specify session or requestId to retry one`,
        );
      }
      if (this.deps.registry.current() === undefined) {
        const pending = records.filter((r) => r.cleanup);
        if (pending.length === 1) return pending[0];
        if (pending.length > 1)
          throw new Error(
            `Several browser starts await cleanup (${pending.map((r) => r.requestId).join(", ")}); use list to retry cleanup or specify requestId`,
          );
      }
    }
    const id = this.deps.registry.resolveForStop(sessionId);
    const ownedRequestId = this.deps.registry.requestFor(id);
    const record = ownedRequestId ? this.journal.records.get(ownedRequestId) : undefined;
    if (!record || !this.ownsRegisteredSession(record))
      throw new Error(`browser session ${id} has no owned lifecycle request`);
    return record;
  }

  private requestCleanup(record: StartRecord, explicitStop = false, implicit = false): void {
    const previous = {
      cleanup: record.cleanup,
      stop: record.stop,
      defaultStopRevision: record.defaultStopRevision,
    };
    if (record.stop !== "closed") {
      record.cleanup = true;
      if (explicitStop) record.stop = "pending";
    }
    if (implicit) record.defaultStopRevision ??= 0;
    try {
      this.journal.save();
    } catch (error) {
      if (explicitStop) {
        // Nothing has been dispatched or made unusable yet: reject admission.
        record.cleanup = previous.cleanup;
        record.stop = previous.stop;
        record.defaultStopRevision = previous.defaultStopRevision;
        throw error;
      }
      // Startup/archival cleanup must continue even if the disk is unavailable.
      // Its original ownership record still enables recovery after restart.
      console.warn("Browser cleanup journal write failed", error);
    }
    if (
      record.session &&
      record.stop !== "closed" &&
      this.ownsRegisteredSession(record) &&
      this.deps.registry.stateFor(record.session.sessionId) !== "cleanup"
    ) {
      this.deps.registry.markForCleanup(record.session.sessionId);
      this.deps.observation.endAction(record.session.sessionId);
    }
    this.schedule();
  }

  async fail(record: StartRecord): Promise<void> {
    if (!this.journal.records.has(record.requestId) || record.stop === "closed") return;
    this.requestCleanup(record);
    await this.cancel(record);
  }

  private cancel(record: StartRecord): Promise<void> {
    const existing = this.cleaning.get(record.requestId);
    if (existing) return existing;
    // Publish the shared job before observation callbacks or runner hooks run.
    const work = Promise.resolve()
      .then(() => this.cancelOnce(record))
      .finally(() => {
        this.cleaning.delete(record.requestId);
        this.schedule();
      });
    this.cleaning.set(record.requestId, work);
    return work;
  }

  private async cancelOnce(record: StartRecord): Promise<void> {
    const sessionId = this.ownsRegisteredSession(record) ? record.session?.sessionId : undefined;
    const release = sessionId ? this.deps.observation.acquireForeground(sessionId) : undefined;
    let actionError: string | undefined;
    try {
      if (sessionId) {
        this.deps.observation.beginAction(sessionId, "stopping");
        this.deps.runner.killFor(sessionId);
      }
      // All entry points share one job per request. Neither its queue slot nor
      // its process belongs to the caller's abort signal or ordinary tool tag.
      const run = () =>
        runWithSessionBusyRetry(() =>
          this.deps.runner.run(["session", "request", record.requestId, "--cancel"], {
            timeoutMs: 30_000,
            tag: `cleanup:${record.requestId}`,
          }),
        );
      const result = sessionId ? await this.deps.queue.run(sessionId, run) : await run();
      const status = parseBskJson(result, "session request cancel") as RequestStatus;
      if (result.aborted) throw new Error("browser cleanup was interrupted");
      if (status.session) {
        if (
          typeof status.session.session_id !== "string" ||
          typeof status.session.browser_instance_id !== "string"
        )
          throw new Error("Invalid browser cleanup session identity; ownership retained");
        if (
          record.session &&
          (record.session.sessionId !== status.session.session_id ||
            record.session.browserInstanceId !== status.session.browser_instance_id)
        )
          throw new Error(
            "Browser cleanup returned a different session identity; ownership retained",
          );
      }
      if (status.state === "closed" || status.state === "failed") {
        this.completeCleanup(record);
        return;
      }
      if (status.session) {
        record.session = {
          sessionId: status.session.session_id,
          browserInstanceId: status.session.browser_instance_id,
        };
        this.journal.save();
        this.adopt(record);
      }
      throw new Error(status.cleanup_error ?? "browser start is still being cancelled");
    } catch (error) {
      actionError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw error;
    } finally {
      if (sessionId && this.ownsRegisteredSession(record))
        this.deps.observation.endAction(sessionId, actionError);
      release?.();
    }
  }

  private releaseResource(record: StartRecord): void {
    if (record.session && this.ownsRegisteredSession(record)) {
      this.deps.registry.remove(record.session.sessionId);
      this.deps.observation.removeSession(record.session.sessionId);
    }
    if (this.reserved.delete(record.requestId)) this.deps.registry.abandonStart();
  }

  private completeCleanup(record: StartRecord): void {
    if (record.stop) {
      record.stop = "closed";
      record.cleanup = false;
      this.releaseResource(record);
      this.journal.save();
    } else this.forget(record);
  }

  private forget(record: StartRecord): void {
    this.releaseResource(record);
    this.journal.records.delete(record.requestId);
    this.journal.save();
  }

  private ownsRegisteredSession(record: StartRecord): boolean {
    return (
      record.session !== undefined &&
      this.deps.registry.requestFor(record.session.sessionId) === record.requestId
    );
  }

  /** Forget passive session disappearance, preserving unacknowledged stop receipts. */
  forgetStopped(): void {
    for (const record of this.journal.records.values()) {
      if (!record.cleanup && !record.stop && record.session && !this.ownsRegisteredSession(record))
        this.forget(record);
    }
  }

  async reconcile(): Promise<void> {
    this.forgetStopped();
    await Promise.allSettled(
      [...this.journal.records.values()].filter((r) => r.cleanup).map((r) => this.cancel(r)),
    );
  }

  pendingCleanup(): number {
    return [...this.journal.records.values()].filter((r) => r.cleanup).length;
  }

  archive(owner: string): void {
    for (const record of this.journal.records.values()) {
      if (record.owners.includes(owner)) void this.fail(record).catch(() => {});
    }
  }

  private schedule(): void {
    if (this.closing || this.timer || this.pendingCleanup() === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile().catch((error) => {
        console.warn("Browser start reconciliation failed", error);
        this.schedule();
      });
    }, 15_000);
    this.timer.unref();
  }

  async dispose(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.deps.runner.killAll();
    await Promise.allSettled([...this.journal.records.values()].map((r) => this.fail(r)));
    this.journal.release();
  }
}

function abortError(): Error {
  return new DOMException("tool call aborted", "AbortError");
}

/** Detach one waiter without cancelling shared cleanup or leaking its rejection. */
function waitForCleanup(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortError());
        else resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
