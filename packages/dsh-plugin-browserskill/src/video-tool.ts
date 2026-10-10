import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendTabId, type PhaseOneRuntime, type ToolRegistrar } from "./phase-one-runtime";
import { SESSION_PARAM, TAB_ID_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

export const VIDEO_PARAMETERS = {
  videoAction: {
    type: "string",
    enum: ["start", "status", "stop", "save", "list", "discard"],
    description:
      "Record only when requested. Start before task operations; wait for state=recording, then work. Stop before session teardown. A failed start must be reported before proceeding without video.",
  },
  recordingId: {
    type: "string",
    description:
      "Video ID returned by start; required for status/stop/save/discard. Remains usable after session stop. list shows only recordings started by this plugin instance.",
  },
  durationMs: {
    type: "integer",
    description: "Video start: duration limit, 1000..600000 ms; default 60000. Not a task timeout.",
  },
  quality: {
    type: "string",
    enum: ["standard", "clear"],
    description: "Video start: standard (1280 / 15 fps) or clear (1920 / 30 fps). Silent MP4.",
  },
  requestId: {
    type: "string",
    description:
      "Video start: stable retry ID (8..80 letters, digits, _ or -); reuse after a lost reply.",
  },
  output: {
    type: "string",
    description:
      "Debug export or video save: explicit file path on the host computer. Video requires the user's chosen destination; omit to keep the video for preview and Save As in the extension.",
  },
  overwrite: {
    type: "boolean",
    description: "Video save only: replace an existing output file when explicitly authorized.",
  },
} as const;

interface VideoIdentity {
  recording_id: string;
  session_id: string;
  state: string;
  expires_at: number;
}

interface OwnedVideo {
  browser: string;
  session: string;
  expiresAt: number;
}

function videoReply(value: unknown, session: string): VideoIdentity {
  const recording = (value as { recording?: VideoIdentity } | null)?.recording;
  if (
    !recording ||
    !/^vid_[a-f0-9]{32}$/.test(recording.recording_id) ||
    recording.session_id !== session ||
    !Number.isFinite(recording.expires_at)
  ) {
    throw new Error("Video start returned an invalid recording identity");
  }
  return recording;
}

/** Artifact ownership outlives the live session; the shared CLI cache is not authority. */
export function registerVideoTool(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const owned = new Map<string, OwnedVideo>();
  const requestScope = randomUUID();

  register(
    defineTool({
      name: "inspect.video",
      description:
        "Record an authorized, fixed task tab before performing the user's task. Start returns after the first encoded frame. Stop leaves the task running. Preview and Save As are in the extension's Features → Video recording. Files remain for 24 hours; partial results are never complete task evidence.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ...VIDEO_PARAMETERS,
        videoAction: { ...VIDEO_PARAMETERS.videoAction, required: true },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      // Artifact control must remain available during navigation or human help.
      isConcurrencySafe: (args) => ["status", "stop", "list"].includes(args.videoAction),
      async execute(args, exec) {
        const action = args.videoAction;
        if (!VIDEO_PARAMETERS.videoAction.enum.includes(action))
          throw new Error("invalid video action");
        for (const key of ["tabId", "durationMs", "quality", "requestId"] as const) {
          if (args[key] !== undefined && action !== "start")
            throw new Error(`${key} requires videoAction=start`);
        }
        if ((args.output !== undefined || args.overwrite !== undefined) && action !== "save")
          throw new Error("output and overwrite require videoAction=save");
        if (args.recordingId !== undefined && ["start", "list"].includes(action))
          throw new Error("recordingId requires status, stop, save or discard");
        if (action === "save" && !args.output?.trim())
          throw new Error("save requires the user's explicit output path");
        for (const [id, video] of owned) {
          if (video.expiresAt <= Date.now()) owned.delete(id);
        }

        if (action === "start") {
          if (
            args.durationMs !== undefined &&
            (!Number.isSafeInteger(args.durationMs) ||
              args.durationMs < 1000 ||
              args.durationMs > 600000)
          )
            throw new Error("durationMs must be 1000..600000");
          if (args.tabId !== undefined && (!Number.isSafeInteger(args.tabId) || args.tabId < 0))
            throw new Error("tabId must be a nonnegative integer");
          const requestId = args.requestId ?? randomUUID();
          if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) throw new Error("invalid video requestId");
          const session = deps.registry.resolve(args.session, "browser_inspect(action=video)");
          const tracked = deps.registry.list().find((value) => value.sessionId === session);
          const browser = tracked?.browserInstanceId;
          if (!browser) throw new Error("The owned session has no browser instance identity");
          // The browser shares a connection-wide retry namespace. Scope the
          // model's key to this plugin and session lifetime, so it cannot adopt
          // another caller's artifact by guessing a CLI request ID.
          const wireRequestId = createHash("sha256")
            .update(
              JSON.stringify([
                requestScope,
                tracked.requestId ?? tracked.startedAtMs,
                session,
                requestId,
              ]),
            )
            .digest("hex");
          const command = ["video", "start", "--session", session, "--request-id", wireRequestId];
          appendTabId(command, args.tabId);
          if (args.durationMs !== undefined) command.push("--duration", `${args.durationMs}ms`);
          if (args.quality !== undefined) command.push("--quality", args.quality);
          try {
            const reply = await runtime.run(exec, command, "video start", session);
            const video = videoReply(reply, session);
            owned.set(video.recording_id, { browser, session, expiresAt: video.expires_at });
            if (video.state !== "recording")
              throw new Error(
                `Recording ${video.recording_id} is ${video.state}, not actively recording`,
              );
            return reply as never;
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\nRecording has not been confirmed. Report this before proceeding without video. For a lost reply, retry start with requestId=${requestId} and the same session/options.`,
              { cause: error },
            );
          }
        }

        if (action === "list") {
          const candidates = [...owned.entries()].filter(
            ([, video]) => args.session === undefined || video.session === args.session,
          );
          const recordings: unknown[] = [];
          for (const browser of new Set(candidates.map(([, video]) => video.browser))) {
            const reply = (await runtime.run(
              exec,
              ["video", "list", "--browser", browser],
              "video list",
            )) as {
              recordings: VideoIdentity[];
            };
            const ids = new Set(
              candidates.filter(([, video]) => video.browser === browser).map(([id]) => id),
            );
            recordings.push(...reply.recordings.filter((video) => ids.has(video.recording_id)));
          }
          return { recordings } as never;
        }

        const id = args.recordingId;
        const video = id === undefined ? undefined : owned.get(id);
        if (!id || !video)
          throw new Error(
            "recordingId must identify a recording started by this plugin instance; use videoAction=list. Other recordings remain available in the extension.",
          );
        if (args.session !== undefined && args.session !== video.session)
          throw new Error("session does not match the recording");
        const command = ["video", action, "--recording", id, "--browser", video.browser];
        if (action === "save") {
          command.push("--out", args.output!);
          if (args.overwrite === true) command.push("--overwrite");
        }
        // No live-session resolution, queue, or foreground tag: stopping the
        // task cannot block artifact access or kill an export in progress.
        // The CLI's nonzero exit for a partial stop/save remains a tool error,
        // including the preserved recording metadata and any saved path.
        const reply = await runtime.run(exec, command, `video ${action}`);
        if (action === "discard") owned.delete(id);
        return reply as never;
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine(["video", args.videoAction]),
        description: "Record a task tab or manage its MP4 video",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
