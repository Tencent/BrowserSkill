import { defineTool } from "@deepseek-ai/dsh-tools";
import type { PhaseOneRuntime, ToolRegistrar } from "./phase-one-runtime";
import { requireNonEmpty } from "./phase-one-runtime";
import { SESSION_PARAM } from "./tool-params";
import type { ToolDeps } from "./tools";

const TAB_ID_REQUIRED = {
  type: "integer",
  required: true,
  description: "Chrome tab id returned by browser_tab_list or browser_tab_create.",
} as const;

interface RawTabInfo {
  tab_id: number;
  title?: string;
  url?: string;
  window_id?: number;
  active?: boolean;
  scope?: "user" | "agent";
}

/** Add Agent Window tab management while preserving the owned-session boundary. */
export function registerPhaseOneTabTools(
  deps: ToolDeps,
  register: ToolRegistrar,
  runtime: PhaseOneRuntime,
): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "browser_tab_list",
      description:
        "List tabs visible to an owned browser session. Other sessions' Agent Windows remain " +
        "hidden; use scope=user to find a user tab before borrowing it.",
      parameters: {
        session: SESSION_PARAM,
        scope: {
          type: "string",
          enum: ["user", "agent", "all"],
          description: "Which tabs to list (default: all).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabs: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tabId: { type: "integer", required: true },
                  title: { type: "string" },
                  url: { type: "string" },
                  windowId: { type: "integer" },
                  active: { type: "boolean" },
                  scope: { type: "string", enum: ["user", "agent"] },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.tabs.length === 0
                ? `[session ${value.session}] no matching tabs`
                : value.tabs
                    .map(
                      (tab) =>
                        `${tab.tabId} [${tab.scope ?? "unknown"}]${tab.active === true ? " [active]" : ""} ` +
                        `${tab.title ?? "(untitled)"} — ${tab.url ?? "(unknown URL)"}`,
                    )
                    .join("\n"),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_tab_list");
        const cmdArgs = ["tab", "list", "--session", sessionId];
        if (args.scope !== undefined) cmdArgs.push("--scope", args.scope);
        const reply = (await runtime.run(exec, cmdArgs, "tab list", sessionId)) as {
          tabs: RawTabInfo[];
        };
        return {
          session: sessionId,
          tabs: reply.tabs.map((tab) => ({
            tabId: tab.tab_id,
            ...(tab.title !== undefined ? { title: tab.title } : {}),
            ...(tab.url !== undefined ? { url: tab.url } : {}),
            ...(tab.window_id !== undefined ? { windowId: tab.window_id } : {}),
            ...(tab.active !== undefined ? { active: tab.active } : {}),
            ...(tab.scope !== undefined ? { scope: tab.scope } : {}),
          })),
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "tab",
          "list",
          "--session",
          args.session ?? "(current)",
          ...(args.scope !== undefined ? ["--scope", args.scope] : []),
        ]),
        description: "List browser tabs",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_tab_create",
      description:
        "Create a tab inside the owned session's Agent Window. The tab is focused by default; " +
        "set active=false to open it in the background.",
      parameters: {
        session: SESSION_PARAM,
        url: { type: "string", description: "Initial URL (default: chrome://newtab/)." },
        active: { type: "boolean", description: "Whether to focus the new tab (default: true)." },
        index: { type: "integer", description: "Insertion index in the Agent Window tab strip." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            windowId: { type: "integer", required: true },
            url: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] created tab ${value.tabId} in window ${value.windowId} (${value.url || "pending URL"})`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.url !== undefined) requireNonEmpty(args.url, "url");
        const sessionId = registry.resolve(args.session, "browser_tab_create");
        const cmdArgs = ["tab", "create", "--session", sessionId];
        if (args.url !== undefined) cmdArgs.push("--url", args.url);
        if (args.active === false) cmdArgs.push("--no-active");
        if (args.index !== undefined) cmdArgs.push("--index", String(args.index));
        const reply = (await runtime.run(exec, cmdArgs, "tab create", sessionId)) as {
          tab_id: number;
          window_id: number;
          url: string;
        };
        if (args.active !== false && reply.url.length > 0) {
          deps.observation.setUrl(sessionId, reply.url);
        }
        return {
          session: sessionId,
          tabId: reply.tab_id,
          windowId: reply.window_id,
          url: reply.url,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "tab",
          "create",
          "--session",
          args.session ?? "(current)",
          ...(args.url !== undefined ? ["--url", args.url] : []),
        ]),
        description: "Create an Agent Window tab",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_tab_close",
      description: "Close a tab in the owned session's Agent Window.",
      parameters: { tabId: TAB_ID_REQUIRED, session: SESSION_PARAM },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `[session ${value.session}] closed tab ${value.tabId}` },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_tab_close");
        const reply = (await runtime.run(
          exec,
          ["tab", "close", String(args.tabId), "--session", sessionId],
          "tab close",
          sessionId,
        )) as { tab_id: number };
        return { session: sessionId, tabId: reply.tab_id };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "tab",
          "close",
          String(args.tabId),
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Close an Agent Window tab",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_tab_select",
      description: "Focus a tab in the owned session's Agent Window.",
      parameters: { tabId: TAB_ID_REQUIRED, session: SESSION_PARAM },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            windowId: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] selected tab ${value.tabId} in window ${value.windowId}`,
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_tab_select");
        const reply = (await runtime.run(
          exec,
          ["tab", "select", String(args.tabId), "--session", sessionId],
          "tab select",
          sessionId,
        )) as { tab_id: number; window_id: number };
        return { session: sessionId, tabId: reply.tab_id, windowId: reply.window_id };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "tab",
          "select",
          String(args.tabId),
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Select an Agent Window tab",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_tab_borrow",
      description:
        "Move a user-window tab into the owned session's Agent Window for controlled interaction. " +
        "Return it with browser_tab_return when finished; stopping the session also auto-returns it.",
      parameters: { tabId: TAB_ID_REQUIRED, session: SESSION_PARAM },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            originalWindowId: { type: "integer", required: true },
            originalIndex: { type: "integer", required: true },
            agentWindowId: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] borrowed tab ${value.tabId} from window ` +
              `${value.originalWindowId} into Agent Window ${value.agentWindowId}`,
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_tab_borrow");
        const reply = (await runtime.run(
          exec,
          ["tab", "borrow", String(args.tabId), "--session", sessionId],
          "tab borrow",
          sessionId,
        )) as {
          tab_id: number;
          original_window_id: number;
          original_index: number;
          agent_window_id: number;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          originalWindowId: reply.original_window_id,
          originalIndex: reply.original_index,
          agentWindowId: reply.agent_window_id,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "tab",
          "borrow",
          String(args.tabId),
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Borrow a user tab",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "browser_tab_return",
      description: "Return a borrowed tab to its original user window and tab-strip position.",
      parameters: { tabId: TAB_ID_REQUIRED, session: SESSION_PARAM },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            returnedToWindowId: { type: "integer", required: true },
            returnedToIndex: { type: "integer", required: true },
            fallback: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] returned tab ${value.tabId} to window ` +
              `${value.returnedToWindowId} at index ${value.returnedToIndex}` +
              (value.fallback ? " (original window unavailable; used fallback)" : ""),
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "browser_tab_return");
        const reply = (await runtime.run(
          exec,
          ["tab", "return", String(args.tabId), "--session", sessionId],
          "tab return",
          sessionId,
        )) as {
          tab_id: number;
          returned_to_window_id: number;
          returned_to_index: number;
          fallback?: boolean;
        };
        return {
          session: sessionId,
          tabId: reply.tab_id,
          returnedToWindowId: reply.returned_to_window_id,
          returnedToIndex: reply.returned_to_index,
          fallback: reply.fallback ?? false,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: runtime.commandLine([
          "tab",
          "return",
          String(args.tabId),
          "--session",
          args.session ?? "(current)",
        ]),
        description: "Return a borrowed tab",
      }),
      presentResult: runtime.presentTerminalResult,
    }),
  );
}
