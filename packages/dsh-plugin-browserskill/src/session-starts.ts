import { randomUUID } from "node:crypto";
import { bskInstallMessage, isCommandNotFound, parseBskJson } from "./runner";
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
      (r) => !this.reserved.has(r.requestId) && !this.ownsRegisteredSession(r),
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
      // No start has been sent, so even a lost prepare reply cannot own a window.
      this.forget(record);
      if (isCommandNotFound(error)) throw new Error(bskInstallMessage(this.deps.config.bskPath));
      throw error;
    }
  }

  assertStarting(record: StartRecord): void {
    if (this.closing || record.cleanup || !this.journal.records.has(record.requestId))
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

  async fail(record: StartRecord): Promise<void> {
    if (!this.journal.records.has(record.requestId)) return;
    record.cleanup = true;
    if (record.session && this.ownsRegisteredSession(record)) {
      this.deps.registry.markForCleanup(record.session.sessionId);
      this.deps.observation.endAction(record.session.sessionId);
    }
    // Keep the original record in memory even if persistence fails. Its
    // write-ahead version still lets a subsequent host clean up by request ID.
    try {
      this.journal.save();
    } catch (error) {
      console.warn("Browser cleanup journal write failed", error);
    }
    await this.cancel(record);
  }

  private cancel(record: StartRecord): Promise<void> {
    const existing = this.cleaning.get(record.requestId);
    if (existing) return existing;
    const work = this.cancelOnce(record).finally(() => {
      this.cleaning.delete(record.requestId);
      this.schedule();
    });
    this.cleaning.set(record.requestId, work);
    return work;
  }

  private async cancelOnce(record: StartRecord): Promise<void> {
    try {
      if (record.session && this.ownsRegisteredSession(record)) {
        await this.deps.observation.stopSession(record.session.sessionId);
        this.forget(record);
        return;
      }
      // Cleanup gets its own budget, never the aborted tool's signal.
      const result = await this.deps.runner.run(
        ["session", "request", record.requestId, "--cancel"],
        { timeoutMs: 30_000 },
      );
      const status = parseBskJson(result, "session request cancel") as RequestStatus;
      if (result.aborted) throw new Error("browser cleanup was interrupted");
      if (status.state === "closed" || status.state === "failed") {
        this.forget(record);
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
      this.schedule();
      throw error;
    }
  }

  private forget(record: StartRecord): void {
    if (record.session && this.ownsRegisteredSession(record)) {
      this.deps.registry.remove(record.session.sessionId);
      this.deps.observation.removeSession(record.session.sessionId);
    }
    if (this.reserved.delete(record.requestId)) this.deps.registry.abandonStart();
    this.journal.records.delete(record.requestId);
    this.journal.save();
  }

  private ownsRegisteredSession(record: StartRecord): boolean {
    return (
      record.session !== undefined &&
      this.deps.registry.requestFor(record.session.sessionId) === record.requestId
    );
  }

  /** Called after an ordinary/overlay stop has removed a confirmed session. */
  forgetStopped(): void {
    for (const record of this.journal.records.values()) {
      if (!record.cleanup && record.session && !this.ownsRegisteredSession(record))
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
