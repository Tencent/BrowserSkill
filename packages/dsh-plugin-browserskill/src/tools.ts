/**
 * Internal browser operation definitions shared by the six model-facing tools.
 * These definitions are never registered with `ctx.tools`: they provide the
 * action-level validation, execution, rendering, and UI presentation reused by
 * the domain tools without exposing one schema per operation to the model.
 */

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  defineTool,
  type ToolDefinition,
  type ToolResult,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { ownerSessionIds } from "./archive-cleanup";
import { trySaveScreenshot } from "./image";
import { actionForLabel, type ObservationService } from "./observation";
import { registerPhaseOneTools } from "./phase-one-tools";
import type { KeyedExecutor } from "./queue";
import {
  type BskRunner,
  bskInstallMessage,
  isCommandNotFound,
  parseBskJson,
  runWithSessionBusyRetry,
} from "./runner";
import type { SessionRegistry } from "./sessions";
import { SESSION_PARAM } from "./tool-params";

/** Plugin configuration resolved from the Schemastery schema in index.ts. */
export interface PluginConfig {
  bskPath: string;
  defaultTimeoutMs: number;
  maxSessions: number;
  observationEnabled: boolean;
  thumbnailIntervalMs: number;
  idleIntervalMs: number;
  /**
   * Lazy tool-schema injection: when true (default), the browser_* tools are
   * registered only after the `browser-skill` skill has been successfully
   * invoked (skill catalog entry advertises alone until then); when false,
   * the suite is registered at apply time (legacy always-on behavior).
   */
  lazyTools: boolean;
}

export interface ToolDeps {
  ctx: Context;
  runner: BskRunner;
  registry: SessionRegistry;
  config: PluginConfig;
  observation: ObservationService;
  /** Per-session FIFO: the daemon rejects a second command while one is unfinished. */
  queue: KeyedExecutor;
}

/** Device presets supported by `bsk emulate --device`. */
const DEVICE_PRESETS = [
  "iphone-14",
  "iphone-14-pro-max",
  "iphone-se",
  "pixel-7",
  "galaxy-s23",
  "ipad-mini",
  "galaxy-tab-s8",
] as const;

/**
 * Run one bsk command and return its parsed JSON payload, or throw.
 * `observeSession` marks the run as model-facing work on that session: it is
 * instrumented into the observation service (action begin/end) and tagged so
 * interrupt() can kill exactly this child. Observation traffic itself never
 * passes an observeSession.
 */
async function runBsk(
  deps: ToolDeps,
  exec: ToolRunContext,
  args: string[],
  label: string,
  observeSession?: string,
  runnerTimeoutMs?: number,
): Promise<unknown> {
  const releaseForeground =
    observeSession !== undefined ? deps.observation.acquireForeground(observeSession) : undefined;
  // beginAction must fire only when the task actually starts inside the
  // per-session queue — marking it while still queued would overwrite the
  // in-flight action's label (and flash it idle on a queued abort).
  let began = false;
  let actionError: string | undefined;
  try {
    let result;
    try {
      const runOnce = () => {
        if (observeSession !== undefined) {
          began = true;
          deps.observation.beginAction(observeSession, actionForLabel(label));
        }
        return runWithSessionBusyRetry(
          () =>
            deps.runner.run(args, {
              signal: exec.signal,
              timeoutMs: runnerTimeoutMs ?? deps.config.defaultTimeoutMs,
              ...(observeSession !== undefined ? { tag: observeSession } : {}),
            }),
          exec.signal,
        );
      };
      result =
        observeSession !== undefined
          ? await deps.queue.run(observeSession, runOnce, exec.signal)
          : await runOnce();
    } catch (error) {
      if (isCommandNotFound(error)) {
        throw new Error(bskInstallMessage(deps.config.bskPath));
      }
      throw error;
    }
    if (result.aborted) {
      const error = new Error("tool call aborted");
      error.name = "AbortError";
      throw error;
    }
    return parseBskJson(result, label);
  } catch (error) {
    actionError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw error;
  } finally {
    if (observeSession !== undefined && began) {
      deps.observation.endAction(observeSession, actionError);
    }
    releaseForeground?.();
  }
}

/** Build the command line shown on the pending terminal card (pure). */
function cmdline(deps: ToolDeps, args: string[]): string {
  return [deps.config.bskPath, ...args].join(" ");
}

/** Shared completed-card presenter: terminal card with the rendered text. */
function presentTerminalResult(_args: never, result: ToolResult) {
  // Multi-block results (e.g. screenshot text + image) still project their
  // text block onto the terminal card.
  const block = result.content.find((b) => b.type === "text");
  if (block === undefined || block.type !== "text") return undefined;
  if (result.isError) return undefined;
  return { card: "terminal" as const, output: block.text, exitCode: 0 };
}

function abortError(): Error {
  const error = new Error("tool call aborted");
  error.name = "AbortError";
  return error;
}

type DefinitionRegistrar = (definition: ToolDefinition) => void;

/** Define the private action handlers through an injected collector. */
function defineBrowserOperations(deps: ToolDeps, register: DefinitionRegistrar): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "session.start",
      description:
        "Start a new browser session: opens an Agent Window in the connected browser and returns " +
        "its session id. The new session becomes the current session for subsequent browser_* calls. " +
        "Optionally navigate to an initial URL and/or apply a mobile device emulation preset.",
      parameters: {
        url: {
          type: "string",
          description: "Initial URL to navigate to after the session starts.",
        },
        width: {
          type: "integer",
          description: "Agent Window outer width in CSS pixels (100..=7680). Requires height.",
        },
        height: {
          type: "integer",
          description: "Agent Window outer height in CSS pixels (100..=7680). Requires width.",
        },
        noFocus: {
          type: "boolean",
          description: "Open the Agent Window in the background without stealing focus.",
        },
        browser: {
          type: "string",
          description:
            "Target browser instance id (only needed when multiple browsers are connected).",
        },
        device: {
          type: "string",
          enum: DEVICE_PRESETS,
          description: "Mobile device emulation preset applied to the tab after start.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            browserInstanceId: { type: "string", required: true },
            url: { type: "string" },
            device: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `started browser session ${value.sessionId}` +
              (value.url !== undefined ? ` and navigated to ${value.url}` : "") +
              (value.device !== undefined ? ` (device: ${value.device})` : ""),
          },
        ],
      },
      async execute(args, exec) {
        if (args.url !== undefined && args.url.trim().length === 0) {
          throw new Error("url must be a non-empty string");
        }
        if ((args.width === undefined) !== (args.height === undefined)) {
          throw new Error("width and height must be given together");
        }
        // Reserve the slot BEFORE spawning: check-and-reserve is synchronous,
        // so concurrent starts can never both pass the cap and leak a session.
        registry.reserveStart();
        const startArgs = ["session", "start"];
        if (args.width !== undefined && args.height !== undefined) {
          startArgs.push("--width", String(args.width), "--height", String(args.height));
        }
        if (args.noFocus === true) startArgs.push("--no-focus");
        if (args.browser !== undefined) startArgs.push("--browser", args.browser);
        let reply: { session_id: string; browser_instance_id: string };
        try {
          reply = (await runBsk(deps, exec, startArgs, "session start")) as typeof reply;
        } catch (error) {
          registry.abandonStart();
          throw error;
        }
        registry.completeStart({
          sessionId: reply.session_id,
          browserInstanceId: reply.browser_instance_id,
          startedAtMs: Date.now(),
        });
        // Ownership for archive cleanup: the calling conversation and its
        // ancestors reap this session when any of them is archived.
        registry.trackOwner(reply.session_id, ownerSessionIds(deps.ctx, exec.agent?.id));
        deps.observation.addSession(reply.session_id, args.url);
        try {
          if (args.device !== undefined) {
            await runBsk(
              deps,
              exec,
              ["emulate", "--session", reply.session_id, "--device", args.device],
              "emulate",
              reply.session_id,
            );
          }
          if (args.url !== undefined) {
            await runBsk(
              deps,
              exec,
              ["navigate", "--session", reply.session_id, args.url],
              "navigate",
              reply.session_id,
            );
          }
        } catch (error) {
          // A half-initialized session must not leak: stop it before surfacing.
          // Reuse the same capture-preempting, idempotent path as explicit and
          // overlay stops; local ownership is dropped even when daemon cleanup
          // itself fails, because this start never becomes usable to the model.
          try {
            await deps.observation.stopSession(reply.session_id);
          } catch {
            registry.remove(reply.session_id);
            deps.observation.removeSession(reply.session_id);
          }
          throw error;
        }
        return {
          sessionId: reply.session_id,
          browserInstanceId: reply.browser_instance_id,
          ...(args.url !== undefined ? { url: args.url } : {}),
          ...(args.device !== undefined ? { device: args.device } : {}),
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, [
          "session",
          "start",
          ...(args.device !== undefined ? ["+ emulate", args.device] : []),
          ...(args.url !== undefined ? ["+ navigate", args.url] : []),
        ]),
        description: "Start a browser session",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "session.stop",
      description:
        "Stop a browser session and close its Agent Window. Stops the given session, or the " +
        "current session when `session` is omitted. Only plugin-created sessions " +
        "can be stopped — sessions owned by other programs sharing the bsk daemon are refused.",
      parameters: { session: SESSION_PARAM },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { stopped: { type: "string", required: true } },
        },
        render: (_args, value) => [
          { type: "text", text: `stopped browser session ${value.stopped}` },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolveForStop(args.session);
        try {
          const stopped = await deps.observation.stopSession(sessionId, exec.signal);
          if (!stopped) throw new Error(`browser session ${sessionId} is not owned by this plugin`);
        } catch (error) {
          if (isCommandNotFound(error)) {
            throw new Error(bskInstallMessage(deps.config.bskPath));
          }
          throw error;
        }
        return { stopped: sessionId };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["session", "stop", args.session ?? "(current session)"]),
        description: "Stop a browser session",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "session.list",
      description:
        "List the browser sessions created by this plugin. Sessions owned by other programs on the " +
        "shared bsk daemon are not visible here. The session marked `current` is the one browser_* " +
        "tools act on when no explicit `session` is passed.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessions: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sessionId: { type: "string", required: true },
                  browserInstanceId: { type: "string", required: true },
                  current: { type: "boolean", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.sessions.length === 0
                ? "no active browser sessions"
                : value.sessions
                    .map(
                      (s) =>
                        `${s.sessionId} (browser ${s.browserInstanceId})${s.current ? " [current]" : ""}`,
                    )
                    .join("\n"),
          },
        ],
      },
      isConcurrencySafe: () => true,
      // Registry-only by design: no daemon call, so foreign sessions on a
      // shared daemon can never even be SEEN through this tool.
      async execute() {
        const current = registry.current();
        return {
          sessions: registry.list().map((entry) => ({
            sessionId: entry.sessionId,
            browserInstanceId: entry.browserInstanceId ?? "",
            current: entry.sessionId === current,
          })),
        };
      },
      presentCall: () => ({
        card: "terminal",
        title: cmdline(deps, ["session", "list"]),
        description: "List browser sessions",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "page.navigate",
      description:
        "Navigate the session's active tab to a URL and wait for a page lifecycle phase " +
        "(default: load). Returns the final URL after redirects.",
      parameters: {
        url: { type: "string", required: true, description: "Destination URL." },
        session: SESSION_PARAM,
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          description: "Lifecycle phase to wait for (default: load).",
        },
        timeoutMs: {
          type: "integer",
          description: "Navigation wait timeout in milliseconds (default 30000).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            url: { type: "string", required: true },
            finalUrl: { type: "string" },
            reached: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] navigated to ${value.finalUrl ?? value.url} (reached: ${value.reached})` +
              (value.reached === "timeout"
                ? " — the wait timed out before the requested phase"
                : ""),
          },
        ],
      },
      async execute(args, exec) {
        if (args.url.trim().length === 0) throw new Error("url must be a non-empty string");
        const sessionId = registry.resolve(args.session, "browser_page(action=navigate)");
        const cmdArgs = ["navigate", "--session", sessionId];
        if (args.waitUntil !== undefined) cmdArgs.push("--wait-until", args.waitUntil);
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        cmdArgs.push(args.url);
        const reply = (await runBsk(deps, exec, cmdArgs, "navigate", sessionId)) as {
          tab_id: number;
          url: string;
          final_url?: string;
          reached: string;
        };
        deps.observation.setUrl(sessionId, reply.final_url ?? reply.url);
        return {
          session: sessionId,
          tabId: reply.tab_id,
          url: reply.url,
          ...(reply.final_url !== undefined ? { finalUrl: reply.final_url } : {}),
          reached: reply.reached,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["navigate", "--session", args.session ?? "(current)", args.url]),
        description: "Navigate to a URL",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  const registerObservationTool = (kind: "snapshot" | "observe") => {
    const isSnapshot = kind === "snapshot";
    const name = isSnapshot ? "inspect.snapshot" : "inspect.observe";
    const description = isSnapshot
      ? "Capture an indented aria-tree snapshot of the session's active tab. Interactive elements " +
        "carry @eN refs for browser_interact actions. Prefer browser_inspect action=observe for a richer semantic view."
      : "Produce a semantic VOM observation of the session's active tab (roles, states, perception " +
        "probes) with @eN refs for browser_interact actions. Visual-only surfaces require image " +
        "understanding and their refs are screenshot-only; keep using any DOM/AX semantics rendered " +
        "alongside them. Read-only: never submits input.";
    register(
      defineTool({
        name,
        description,
        parameters: {
          session: SESSION_PARAM,
          maxDepth: { type: "integer", description: "Cap on tree depth before truncating." },
          maxTokens: {
            type: "integer",
            description: "Soft cap on rendered tokens (~4 chars/token).",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              session: { type: "string", required: true },
              tabId: { type: "integer", required: true },
              text: { type: "string", required: true },
              refCount: { type: "integer", required: true },
              truncated: { type: "boolean", required: true },
            },
          },
          render: (_args, value) => [
            {
              type: "text",
              text:
                value.text.length > 0
                  ? value.text + (value.truncated ? "\n(truncated — re-run with looser caps)" : "")
                  : "(empty observation — page may still be loading)",
            },
          ],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const sessionId = registry.resolve(args.session, name);
          const cmdArgs = [kind, "--session", sessionId];
          if (args.maxDepth !== undefined) cmdArgs.push("--max-depth", String(args.maxDepth));
          if (args.maxTokens !== undefined) cmdArgs.push("--max-tokens", String(args.maxTokens));
          const reply = (await runBsk(deps, exec, cmdArgs, kind, sessionId)) as {
            text: string;
            ref_count: number;
            tab_id: number;
            truncated?: boolean;
          };
          return {
            session: sessionId,
            tabId: reply.tab_id,
            text: reply.text,
            refCount: reply.ref_count,
            truncated: reply.truncated ?? false,
          };
        },
        presentCall: (args) => ({
          card: "terminal",
          title: cmdline(deps, [kind, "--session", args.session ?? "(current)"]),
          description: isSnapshot ? "Capture an aria snapshot" : "Observe the page semantically",
        }),
        presentResult: presentTerminalResult,
      }),
    );
  };
  registerObservationTool("snapshot");
  registerObservationTool("observe");

  register(
    defineTool({
      name: "interact.click",
      description:
        "Click an element in the session's active tab. Target is a snapshot ref (@e3) from the " +
        "last browser_inspect observation, or a CSS selector. A visual Surface requires the " +
        "captureId and image coordinates returned by browser_inspect action=screenshot.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Snapshot ref (@e3 / e3) or CSS selector of the element to click.",
        },
        session: SESSION_PARAM,
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button (default: left).",
        },
        clickCount: {
          type: "integer",
          description: "Number of consecutive presses (double-click = 2).",
        },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] },
          description: "Keyboard modifiers held during the click.",
        },
        captureId: {
          type: "string",
          description:
            "Short-lived Surface capture id returned by browser_inspect action=screenshot.",
        },
        imageX: {
          type: "number",
          description: "X coordinate in capture-image pixels; requires captureId and imageY.",
        },
        imageY: {
          type: "number",
          description: "Y coordinate in capture-image pixels; requires captureId and imageX.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            x: { type: "number", required: true },
            y: { type: "number", required: true },
            captureId: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] clicked at (${value.x}, ${value.y}) on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.target.trim().length === 0) throw new Error("target must be a non-empty string");
        const pointArgCount =
          Number(args.captureId !== undefined) +
          Number(args.imageX !== undefined) +
          Number(args.imageY !== undefined);
        if (pointArgCount !== 0 && pointArgCount !== 3) {
          throw new Error("captureId, imageX, and imageY must be given together");
        }
        const sessionId = registry.resolve(args.session, "browser_interact(action=click)");
        const cmdArgs = ["click", "--session", sessionId];
        if (args.button !== undefined) cmdArgs.push("--button", args.button);
        if (args.clickCount !== undefined) cmdArgs.push("--click-count", String(args.clickCount));
        if (args.modifiers !== undefined && args.modifiers.length > 0) {
          cmdArgs.push("--modifiers", args.modifiers.join(","));
        }
        if (args.captureId !== undefined) {
          cmdArgs.push(
            "--capture",
            args.captureId,
            "--image-x",
            String(args.imageX),
            "--image-y",
            String(args.imageY),
          );
        }
        cmdArgs.push(args.target);
        const reply = (await runBsk(deps, exec, cmdArgs, "click", sessionId)) as {
          tab_id: number;
          x: number;
          y: number;
          capture_id?: string;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          x: reply.x,
          y: reply.y,
          ...(reply.capture_id !== undefined ? { captureId: reply.capture_id } : {}),
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["click", args.target, "--session", args.session ?? "(current)"]),
        description: "Click an element",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "interact.fill",
      description:
        "Fill an input / textarea / contenteditable element, clearing it first by default. " +
        "Target is a snapshot ref (@e3) or a CSS selector.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Snapshot ref (@e3 / e3) or CSS selector of the field.",
        },
        value: { type: "string", required: true, description: "Text to type into the element." },
        session: SESSION_PARAM,
        noClear: {
          type: "boolean",
          description: "Skip the default wipe-the-field-first pass (append instead).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            valueLength: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] filled field on tab ${value.tabId} (${value.valueLength} chars)`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.target.trim().length === 0) throw new Error("target must be a non-empty string");
        const sessionId = registry.resolve(args.session, "browser_interact(action=fill)");
        const cmdArgs = ["fill", "--session", sessionId, "--value", args.value];
        if (args.noClear === true) cmdArgs.push("--no-clear");
        cmdArgs.push(args.target);
        const reply = (await runBsk(deps, exec, cmdArgs, "fill", sessionId)) as {
          tab_id: number;
          value_length: number;
        };
        return { session: sessionId, tabId: reply.tab_id, valueLength: reply.value_length };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["fill", args.target, "--session", args.session ?? "(current)"]),
        description: `Fill a field with ${args.value.length} chars`,
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "interact.press",
      description:
        "Dispatch a keyboard key or combo (Enter, Escape, ArrowDown, Ctrl+A, …) to the session's " +
        "active tab, optionally focusing a target element first.",
      parameters: {
        key: {
          type: "string",
          required: true,
          description: "Key spec: a CDP key name (Enter, a, ArrowLeft) or a combo (Ctrl+A).",
        },
        session: SESSION_PARAM,
        target: {
          type: "string",
          description: "Snapshot ref (@e3) or CSS selector to focus before pressing.",
        },
        holdMs: {
          type: "integer",
          description: "Hold the key down for N milliseconds between keyDown and keyUp.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            key: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] pressed ${value.key} on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.key.trim().length === 0) throw new Error("key must be a non-empty string");
        const sessionId = registry.resolve(args.session, "browser_interact(action=press)");
        const cmdArgs = ["press", "--session", sessionId];
        if (args.target !== undefined) {
          if (args.target.trim().length === 0) throw new Error("target must be a non-empty string");
          // bsk distinguishes ref vs selector via flags; positional detection is CLI-side for
          // click/fill only, so pass the explicit flag that matches the target's shape.
          if (/^@?e\d+$/.test(args.target)) {
            cmdArgs.push("--ref", args.target);
          } else {
            cmdArgs.push("--selector", args.target);
          }
        }
        if (args.holdMs !== undefined) cmdArgs.push("--hold-ms", String(args.holdMs));
        cmdArgs.push(args.key);
        const reply = (await runBsk(deps, exec, cmdArgs, "press", sessionId)) as {
          tab_id: number;
          key: string;
        };
        return { session: sessionId, tabId: reply.tab_id, key: reply.key };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["press", args.key, "--session", args.session ?? "(current)"]),
        description: "Press a key",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "inspect.screenshot",
      description:
        "Capture a PNG screenshot of the session's active tab, or crop to a snapshot ref element. " +
        "This is the supported operation for visual surface refs emitted by inspect.observe. Only use " +
        "it to interpret a visual-only surface when you can inspect image output. If you lack multimodal " +
        "or image-reading capability, tell the user to switch to a model with image understanding; do " +
        "not guess content or coordinates. " +
        "Returns the image itself when the deployment supports image input, otherwise a file path.",
      parameters: {
        session: SESSION_PARAM,
        ref: {
          type: "string",
          description:
            "Ref (@e3) from the last snapshot/observe; crops to that DOM element or visual surface.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            path: { type: "string", required: true },
            width: { type: "integer", required: true },
            height: { type: "integer", required: true },
            byteSize: { type: "integer", required: true },
            captureId: { type: "string" },
            captureExpiresAt: { type: "integer" },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string", required: true },
                mediaType: {
                  type: "string",
                  required: true,
                  enum: ["image/png", "image/jpeg", "image/webp", "image/gif"],
                },
                bytes: { type: "integer", required: true },
                width: { type: "integer", required: true },
                height: { type: "integer", required: true },
                name: { type: "string" },
              },
            },
          },
        },
        render: (_args, value) => {
          const text =
            value.image !== undefined
              ? `[session ${value.session}] screenshot of tab ${value.tabId} (${value.width}x${value.height}px)`
              : `[session ${value.session}] screenshot saved to ${value.path} (${value.width}x${value.height}px, ${value.byteSize} bytes) — this deployment cannot inline images; read the file to view it`;
          const captureText =
            value.captureId !== undefined
              ? ` Surface capture ${value.captureId} uses capture-image-pixel coordinates and expires at ${value.captureExpiresAt}.`
              : "";
          const blocks: ContentBlock[] = [{ type: "text", text: text + captureText }];
          if (value.image !== undefined) {
            blocks.push({
              type: "image",
              // Structurally an ImageAttachmentRef; branded without a runtime import.
              attachment: {
                attachmentId: value.image.attachmentId,
                mediaType: value.image.mediaType,
                bytes: value.image.bytes,
                width: value.image.width,
                height: value.image.height,
                ...(value.image.name !== undefined ? { name: value.image.name } : {}),
              } as never,
            });
          }
          return blocks;
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_inspect(action=screenshot)");
        const outPath = join(
          tmpdir(),
          `bsk-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
        );
        const cmdArgs = ["screenshot", "--session", sessionId, "--out", outPath];
        if (args.ref !== undefined) cmdArgs.push("--ref", args.ref);
        // The scratch PNG is only kept when it IS the model-facing artifact
        // (no attachment store to inline through); once the bytes are saved
        // into the store — and on every failure/abort path — it is deleted.
        let keepFile = false;
        let writtenPath: string | undefined;
        try {
          const reply = (await runBsk(deps, exec, cmdArgs, "screenshot", sessionId)) as {
            tab_id: number;
            width: number;
            height: number;
            path: string;
            byte_size: number;
            capture?: { id: string; expires_at: number };
          };
          writtenPath = reply.path;
          const data = await readFile(reply.path);
          if (exec.signal.aborted) throw abortError();
          const ref = await trySaveScreenshot(deps.ctx, exec, data, `screenshot-${sessionId}.png`);
          keepFile = ref === undefined;
          return {
            session: sessionId,
            tabId: reply.tab_id,
            path: reply.path,
            width: reply.width,
            height: reply.height,
            byteSize: reply.byte_size,
            ...(reply.capture !== undefined
              ? { captureId: reply.capture.id, captureExpiresAt: reply.capture.expires_at }
              : {}),
            ...(ref !== undefined
              ? {
                  image: {
                    attachmentId: String(ref.attachmentId),
                    mediaType: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...(ref.name !== undefined ? { name: ref.name } : {}),
                  },
                }
              : {}),
          };
        } finally {
          if (!keepFile) await unlink(writtenPath ?? outPath).catch(() => {});
        }
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, [
          "screenshot",
          "--session",
          args.session ?? "(current)",
          ...(args.ref !== undefined ? ["--ref", args.ref] : []),
        ]),
        description: "Capture a screenshot",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "assist.emulate",
      description:
        "Apply (or clear) mobile device emulation on the session's active tab: viewport metrics, " +
        "user agent, and touch. Overrides are per-tab and not inherited by new tabs.",
      parameters: {
        session: SESSION_PARAM,
        device: {
          type: "string",
          enum: DEVICE_PRESETS,
          description: "Built-in device preset.",
        },
        width: { type: "integer", description: "Viewport width in CSS pixels (requires height)." },
        height: { type: "integer", description: "Viewport height in CSS pixels (requires width)." },
        mobile: {
          type: "boolean",
          description:
            "Emulate a mobile viewport. Requires width+height — the bsk daemon refuses " +
            "--mobile without viewport dimensions, so this flag cannot be used alone.",
        },
        off: { type: "boolean", description: "Clear every emulation override on the tab." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            cleared: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.cleared
              ? `[session ${value.session}] cleared emulation on tab ${value.tabId}`
              : `[session ${value.session}] applied emulation on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_assist(action=emulate)");
        if (args.off === true) {
          if (args.device !== undefined || args.width !== undefined || args.height !== undefined) {
            throw new Error("off is mutually exclusive with device/width/height");
          }
        } else if (args.device === undefined && args.width === undefined) {
          throw new Error(
            "nothing to apply: pass device or width+height (mobile also requires width+height), or off",
          );
        }
        if ((args.width === undefined) !== (args.height === undefined)) {
          throw new Error("width and height must be given together");
        }
        const cmdArgs = ["emulate", "--session", sessionId];
        if (args.off === true) {
          cmdArgs.push("--off");
        } else {
          if (args.device !== undefined) cmdArgs.push("--device", args.device);
          if (args.width !== undefined && args.height !== undefined) {
            cmdArgs.push("--width", String(args.width), "--height", String(args.height));
          }
          if (args.mobile === true) cmdArgs.push("--mobile");
        }
        const reply = (await runBsk(deps, exec, cmdArgs, "emulate", sessionId)) as {
          tab_id: number;
          cleared: boolean;
        };
        return { session: sessionId, tabId: reply.tab_id, cleared: reply.cleared };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, [
          "emulate",
          "--session",
          args.session ?? "(current)",
          ...(args.off === true ? ["--off"] : []),
          ...(args.device !== undefined ? ["--device", args.device] : []),
        ]),
        description: "Emulate a device environment",
      }),
      presentResult: presentTerminalResult,
    }),
  );
  registerPhaseOneTools(deps, register, {
    run: (exec, args, label, observeSession, runnerTimeoutMs) =>
      runBsk(deps, exec, args, label, observeSession, runnerTimeoutMs),
    commandLine: (args) => cmdline(deps, args),
    presentTerminalResult,
  });
}

/**
 * Build the private action handlers without publishing them to the model. The
 * six browser tools dispatch through these handlers, preserving validation,
 * rendering, cancellation, ownership, UI presentation, and attachments.
 */
export function createBrowserOperationDefinitions(deps: ToolDeps): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  defineBrowserOperations(deps, (definition) => {
    definitions.push(definition);
  });
  return definitions;
}
