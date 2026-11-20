import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { DownloadConcurrencyGate, handleDownload } from "../download";

// `chrome.downloads` is browser-global, so only one capture can own attribution
// at a time. A second session must wait inside its own budget instead of being
// told the browser is busy before the caller ever queued.
function fixture() {
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const downloads = {
    onCreated: { addListener: () => {}, removeListener: () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} },
    onDeterminingFilename: { addListener: () => {}, removeListener: () => {} },
    search: async () => [],
    cancel: async () => {},
    removeFile: async () => {},
  };
  return { sessions, downloads };
}

async function busyGate(): Promise<{ gate: DownloadConcurrencyGate; release: () => void }> {
  const gate = new DownloadConcurrencyGate();
  const release = gate.tryAcquire("holder-session");
  if (!release) throw new Error("gate did not accept the first download");
  return { gate, release };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("waits inside the caller budget instead of failing the moment the slot is taken", async () => {
  const { sessions, downloads } = fixture();
  const ctx = await sessions.start("download-queue");
  const { gate, release } = await busyGate();
  try {
    const result = await handleDownload(
      sessions,
      {
        session_id: ctx.sessionId,
        ref: "e1",
        browser_relative_dir: "BrowserSkill/x",
        timeout_ms: 400,
      },
      // The run must never reach CDP: it gives up while queueing.
      // @ts-expect-error the queue rejects the call before any browser access.
      { downloads, downloadGate: gate },
    );
    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "session_busy", effect_state: "none" },
    });
    // A caller that waited must be told so; an immediate refusal reports 0.
    expect((result as { data: { waited_ms?: number } }).data.waited_ms).toBeGreaterThanOrEqual(200);
  } finally {
    release();
  }
});

it("still refuses a second download for the session that holds the slot", async () => {
  const { sessions, downloads } = fixture();
  const ctx = await sessions.start("download-same-session");
  const gate = new DownloadConcurrencyGate();
  const release = gate.tryAcquire(ctx.sessionId);
  if (!release) throw new Error("gate did not accept the first download");
  try {
    const started = Date.now();
    const result = await handleDownload(
      sessions,
      {
        session_id: ctx.sessionId,
        ref: "e1",
        browser_relative_dir: "BrowserSkill/x",
        timeout_ms: 5_000,
      },
      // @ts-expect-error the refusal happens before any browser access.
      { downloads, downloadGate: gate },
    );
    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "session_busy", effect_state: "none" },
    });
    // Same-session concurrency is a caller error, not contention: no waiting.
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    release();
  }
});

it("hands the slot to the next waiter without reopening it to new callers", async () => {
  const { gate, release } = await busyGate();
  const queued = gate.acquire(5_000, "s1");
  const latecomer = gate.acquire(5_000, "s2");
  release();
  const queuedRelease = await queued;
  expect(queuedRelease).not.toBeNull();
  // The queued caller owns the slot now; a third caller still has to queue.
  expect(gate.isBusy()).toBe(true);
  queuedRelease!();
  const latecomerRelease = await latecomer;
  expect(latecomerRelease).not.toBeNull();
  latecomerRelease!();
  expect(gate.isBusy()).toBe(false);
});

it("drops an aborted waiter so it can never hold the slot", async () => {
  const { gate, release } = await busyGate();
  const abort = new AbortController();
  const queued = gate.acquire(5_000, "s1", abort.signal);
  abort.abort();
  expect(await queued).toBeNull();
  release();
  expect(gate.isBusy()).toBe(false);
  // A waiter that was already gone must not consume the next release.
  const next = await gate.acquire(50, "s2");
  expect(next).not.toBeNull();
  next!();
});

it("reports cancellation, not a busy browser, when the caller aborts while queued", async () => {
  const { sessions, downloads } = fixture();
  const ctx = await sessions.start("download-queue-abort");
  const { gate, release } = await busyGate();
  const abort = new AbortController();
  try {
    const pending = handleDownload(
      sessions,
      {
        session_id: ctx.sessionId,
        ref: "e1",
        browser_relative_dir: "BrowserSkill/x",
        timeout_ms: 10_000,
      },
      // @ts-expect-error the queue rejects the call before any browser access.
      { downloads, downloadGate: gate, signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 50);
    expect(await pending).toMatchObject({ code: "cancelled" });
  } finally {
    release();
  }
});
