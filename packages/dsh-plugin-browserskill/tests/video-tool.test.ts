import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerBrowserTools } from "../src/browser-tools";
import { ObservationService } from "../src/observation";
import { KeyedExecutor } from "../src/queue";
import type { BskRunner, BskRunOptions, BskRunResult } from "../src/runner";
import { SessionRegistry } from "../src/sessions";

const ID = `vid_${"a".repeat(32)}`;
const FOREIGN_ID = `vid_${"b".repeat(32)}`;
const RECORDING = {
  recording_id: ID,
  session_id: "s1",
  tab_id: 7,
  state: "recording",
  expires_at: Date.now() + 86400000,
};
const result = (value: unknown, code = 0): BskRunResult => ({
  code,
  stdout: JSON.stringify(value),
  stderr: "",
  timedOut: false,
  aborted: false,
});
const exec = (signal = new AbortController().signal) =>
  ({ callId: "video-call", name: "browser_inspect", signal }) as ToolRunContext;

function setup(
  respond: (args: string[], options?: BskRunOptions) => Promise<BskRunResult> = async () =>
    result({ recording: RECORDING, path: null }),
) {
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
    get: () => undefined,
  } as never;
  const run = vi.fn(respond);
  const runner: BskRunner = { run, killAll() {}, killFor: () => 0 };
  const registry = new SessionRegistry(5);
  registry.reserveStart();
  registry.completeStart({
    sessionId: "s1",
    requestId: "session-request",
    browserInstanceId: "browser-1",
    startedAtMs: Date.now(),
  });
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx,
    runner,
    registry,
    queue,
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  registerBrowserTools({
    ctx,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath: "bsk",
      defaultTimeoutMs: 120000,
      maxSessions: 5,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  });
  const tool = tools.get("browser_inspect")!;
  const call = (args: Record<string, unknown>, context = exec()) =>
    tool.execute({ action: "video", ...args }, context);
  return { call, tool, run, registry, queue };
}

describe("DSH task videos", () => {
  it("starts with the owned session, requested target/settings and stable retry key", async () => {
    const { call, run } = setup();
    expect(
      await call({
        videoAction: "start",
        tabId: 7,
        durationMs: 90000,
        quality: "clear",
        requestId: "retry-start-1",
      }),
    ).toMatchObject({ recording: RECORDING });
    expect(run).toHaveBeenCalledWith(
      [
        "video",
        "start",
        "--session",
        "s1",
        "--request-id",
        expect.stringMatching(/^[a-f0-9]{64}$/),
        "--tab-id",
        "7",
        "--duration",
        "90000ms",
        "--quality",
        "clear",
      ],
      expect.objectContaining({ tag: "s1", timeoutMs: 120000 }),
    );
  });

  it("isolates retry keys from other plugin instances and reused session IDs", async () => {
    const first = setup();
    const second = setup();
    const args = { videoAction: "start", requestId: "shared-request-id" };
    await first.call(args);
    await first.call(args);
    await second.call(args);
    expect(first.run.mock.calls[0][0]).toEqual(first.run.mock.calls[1][0]);
    expect(first.run.mock.calls[0][0]).not.toEqual(second.run.mock.calls[0][0]);
    first.registry.remove("s1");
    first.registry.reserveStart();
    first.registry.completeStart({
      sessionId: "s1",
      requestId: "new-session-request",
      browserInstanceId: "browser-1",
      startedAtMs: Date.now(),
    });
    await first.call(args);
    expect(first.run.mock.calls[0][0]).not.toEqual(first.run.mock.calls[2][0]);
  });

  it("does not confirm start while the first-frame response is pending", async () => {
    let firstFrame!: (value: BskRunResult) => void;
    const { call } = setup(
      () =>
        new Promise((resolve) => {
          firstFrame = resolve;
        }),
    );
    let started = false;
    const pending = call({ videoAction: "start" }).then(() => {
      started = true;
    });
    await vi.waitFor(() => expect(firstFrame).toBeDefined());
    expect(started).toBe(false);
    firstFrame(result({ recording: RECORDING }));
    await pending;
    expect(started).toBe(true);
  });

  it("serializes start behind earlier page operations", async () => {
    const { call, queue, run } = setup();
    let release!: () => void;
    const page = queue.run(
      "s1",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    const start = call({ videoAction: "start" });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    release();
    await Promise.all([page, start]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    "status",
    "stop",
    "list",
  ])("allows %s while a page/help operation is blocked", async (action) => {
    const { call, queue, run, tool } = setup(async (args) =>
      result(args[1] === "list" ? { recordings: [RECORDING] } : { recording: RECORDING }),
    );
    await call({ videoAction: "start" });
    let release!: () => void;
    const page = queue.run(
      "s1",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      expect(tool.isConcurrencySafe?.({ action: "video", videoAction: action })).toBe(true);
      await call({ videoAction: action, ...(action === "list" ? {} : { recordingId: ID }) });
      expect(run.mock.calls.at(-1)?.[1]?.tag).toBeUndefined();
    } finally {
      release();
      await page;
    }
  });

  it("keeps status and export available after session removal, without adopting a reused ID", async () => {
    const { call, run, registry } = setup();
    await call({ videoAction: "start" });
    registry.remove("s1");
    registry.reserveStart();
    registry.completeStart({
      sessionId: "s1",
      browserInstanceId: "browser-2",
      startedAtMs: Date.now(),
    });
    await call({ videoAction: "status", recordingId: ID });
    await call({ videoAction: "save", recordingId: ID, output: "/tmp/user video.mp4" });
    expect(run.mock.calls.at(-1)?.[0]).toEqual([
      "video",
      "save",
      "--recording",
      ID,
      "--browser",
      "browser-1",
      "--out",
      "/tmp/user video.mp4",
    ]);
    expect(run.mock.calls.at(-1)?.[1]?.tag).toBeUndefined();
  });

  it("filters shared browser listings to returned IDs even after task teardown", async () => {
    const { call, registry } = setup(async (args) =>
      result(
        args[1] === "list"
          ? { recordings: [RECORDING, { ...RECORDING, recording_id: FOREIGN_ID }] }
          : { recording: RECORDING },
      ),
    );
    await call({ videoAction: "start" });
    registry.remove("s1");
    expect(await call({ videoAction: "list" })).toEqual({ recordings: [RECORDING] });
    expect(await call({ videoAction: "list", session: "foreign-session" })).toEqual({
      recordings: [],
    });
  });

  it.each([
    "status",
    "stop",
    "save",
    "discard",
  ])("rejects foreign recording IDs before %s", async (action) => {
    const { call, run } = setup();
    await expect(
      call({
        videoAction: action,
        recordingId: FOREIGN_ID,
        ...(action === "save" ? { output: "/tmp/foreign.mp4" } : {}),
      }),
    ).rejects.toThrow(/started by this plugin/);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects foreign sessions before start", async () => {
    const { call, run } = setup();
    await expect(call({ videoAction: "start", session: "foreign" })).rejects.toThrow(
      /does not belong/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { videoAction: "start", durationMs: 999 },
    { videoAction: "start", durationMs: 600001 },
    { videoAction: "start", requestId: "short" },
    { videoAction: "start", tabId: -1 },
    { videoAction: "start", output: "/tmp/no.mp4" },
    { videoAction: "stop", durationMs: 1000 },
    { videoAction: "start", recordingId: ID },
    { videoAction: "save", recordingId: ID },
  ])("rejects invalid options before running: %j", async (args) => {
    const { call, run } = setup();
    await expect(call(args)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("passes explicit overwrite only when requested", async () => {
    const { call, run } = setup();
    await call({ videoAction: "start" });
    await call({ videoAction: "save", recordingId: ID, output: "video.mp4", overwrite: true });
    expect(run.mock.calls.at(-1)?.[0]).toContain("--overwrite");
  });

  it.each([
    "stop",
    "save",
  ])("surfaces partial %s as an error including metadata and saved path", async (action) => {
    const { call } = setup(async (args) =>
      result(
        {
          recording:
            args[1] === "start"
              ? RECORDING
              : {
                  ...RECORDING,
                  state: "ready",
                  completeness: "partial",
                  stop_reason: "session_ended",
                },
          path: args[1] === "save" ? "/tmp/partial.mp4" : null,
        },
        args[1] === "start" ? 0 : 1,
      ),
    );
    await call({ videoAction: "start" });
    await expect(
      call({
        videoAction: action,
        recordingId: ID,
        ...(action === "save" ? { output: "/tmp/partial.mp4" } : {}),
      }),
    ).rejects.toThrow(action === "save" ? /partial.mp4/ : /session_ended/);
  });

  it("reports a startup failure with a stable recovery key and never claims recording started", async () => {
    const { call, run } = setup();
    run.mockResolvedValueOnce(result({ message: "H.264 encoder unavailable" }, 1));
    await expect(call({ videoAction: "start", requestId: "recover-start-1" })).rejects.toThrow(
      /H.264 encoder unavailable[\s\S]*Recording has not been confirmed[\s\S]*requestId=recover-start-1/,
    );
    expect(await call({ videoAction: "list" })).toEqual({ recordings: [] });
    await call({ videoAction: "start", requestId: "recover-start-1" });
    expect(run.mock.calls[0][0]).toEqual(run.mock.calls[1][0]);
  });

  it("keeps an already-finished retry accessible but does not report an active recording", async () => {
    const { call } = setup(async () => result({ recording: { ...RECORDING, state: "ready" } }));
    await expect(call({ videoAction: "start" })).rejects.toThrow(/not actively recording/);
    expect(await call({ videoAction: "status", recordingId: ID })).toMatchObject({
      recording: { state: "ready" },
    });
  });

  it("does not adopt a mismatched recording returned from start", async () => {
    const { call } = setup(async () =>
      result({ recording: { ...RECORDING, session_id: "foreign" } }),
    );
    await expect(call({ videoAction: "start" })).rejects.toThrow(/invalid recording identity/);
    await expect(call({ videoAction: "status", recordingId: ID })).rejects.toThrow(
      /started by this plugin/,
    );
  });

  it("forwards cancellation without converting it to recording success", async () => {
    const { call, run } = setup();
    run.mockResolvedValueOnce({ ...result(null), code: null, aborted: true });
    await expect(call({ videoAction: "start" })).rejects.toMatchObject({ name: "AbortError" });
    expect(await call({ videoAction: "list" })).toEqual({ recordings: [] });
  });

  it("forgets a discarded recording but retains it on a failed discard", async () => {
    const { call, run } = setup();
    await call({ videoAction: "start" });
    run.mockResolvedValueOnce(result({ message: "still recording" }, 1));
    await expect(call({ videoAction: "discard", recordingId: ID })).rejects.toThrow(
      /still recording/,
    );
    await call({ videoAction: "stop", recordingId: ID });
    await call({ videoAction: "discard", recordingId: ID });
    await expect(call({ videoAction: "status", recordingId: ID })).rejects.toThrow(
      /started by this plugin/,
    );
  });
});
