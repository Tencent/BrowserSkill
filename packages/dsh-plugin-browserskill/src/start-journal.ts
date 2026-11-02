/** Write-ahead ownership for starts, including ones whose CLI never replies. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface StartRecord {
  requestId: string;
  owners: string[];
  startedAtMs: number;
  cleanup: boolean;
  /** An explicit stop stays retryable until its caller acknowledges completion. */
  stop?: "pending" | "closed";
  /** A failed implicit waiter advances this revision; other callers cannot consume its retry. */
  defaultStopRevision?: number;
  session?: { sessionId: string; browserInstanceId: string };
}

export interface StartJournal {
  records: Map<string, StartRecord>;
  save(): void;
  release(): void;
}

export function memoryStartJournal(): StartJournal {
  return { records: new Map(), save() {}, release() {} };
}

const liveKey = Symbol.for("browser-skill.live-start-journals");
const globals = globalThis as typeof globalThis & { [liveKey]?: Set<string> };
const live = (globals[liveKey] ??= new Set<string>());

export function defaultStartJournalDirectory(bskPath: string): string {
  const scope = createHash("sha256")
    .update(JSON.stringify([process.cwd(), bskPath]))
    .digest("hex")
    .slice(0, 24);
  return join(process.env.BSK_HOME ?? join(homedir(), ".bsk"), "dsh-starts", scope);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Separate owner directories avoid overwriting another live plugin's ledger.
 * Stale directories are claimed by atomic rename before reading their records.
 * A reused PID is conservatively treated as live; daemon leases/idle reaping
 * still bound the abandoned browser lifetime in that case.
 */
export class DiskStartJournal implements StartJournal {
  readonly records = new Map<string, StartRecord>();
  private readonly owner = `${process.pid}-${randomUUID()}`;
  private readonly directory: string;
  private initialized = false;

  constructor(private readonly root: string) {
    this.directory = join(resolve(root), this.owner);
    live.add(this.owner);
  }

  recover(): void {
    if (this.initialized) return;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.directory, { mode: 0o700 });
    this.initialized = true;
    for (const dir of readdirSync(this.root, { withFileTypes: true })) {
      const match = /^(\d+)-([a-f0-9-]{36})$/.exec(dir.name);
      if (!dir.isDirectory() || !match || dir.name === this.owner) continue;
      const pid = Number(match[1]);
      if (pid === process.pid ? live.has(dir.name) : processAlive(pid)) continue;
      const claimed = join(this.directory, `recovered-${dir.name}`);
      try {
        renameSync(join(this.root, dir.name), claimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      this.readRecovered(claimed);
      this.save();
      rmSync(claimed, { recursive: true });
    }
  }

  private readRecovered(directory: string): void {
    const file = join(directory, "requests.json");
    if (existsSync(file)) {
      const records: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(records)) throw new Error(`Invalid browser start journal: ${file}`);
      for (const item of records) {
        if (
          !item ||
          typeof item.requestId !== "string" ||
          !/^\d+:[a-f0-9-]{36}$/.test(item.requestId) ||
          !Array.isArray(item.owners) ||
          !item.owners.every((id: unknown) => typeof id === "string") ||
          typeof item.startedAtMs !== "number" ||
          (item.stop !== undefined && item.stop !== "pending" && item.stop !== "closed") ||
          (item.defaultStopRevision !== undefined &&
            (!Number.isSafeInteger(item.defaultStopRevision) ||
              item.defaultStopRevision < 0 ||
              item.stop === undefined))
        )
          throw new Error(`Invalid browser start journal: ${file}`);
        this.records.set(item.requestId, { ...item, cleanup: item.stop !== "closed" });
      }
    }
    // A crash during adoption must not lose the already-renamed source.
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("recovered-"))
        this.readRecovered(join(directory, entry.name));
    }
  }

  save(): void {
    if (!this.initialized) this.recover();
    const temporary = join(this.directory, "requests.tmp");
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify([...this.records.values()]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(this.directory, "requests.json"));
    // Directory fsync is supported on Unix; Windows atomic rename remains the
    // durability boundary and does not allow opening directories this way.
    if (process.platform !== "win32") {
      const dir = openSync(this.directory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
  }

  release(): void {
    live.delete(this.owner);
    if (this.initialized && this.records.size === 0)
      rmSync(this.directory, { recursive: true, force: true });
  }
}
