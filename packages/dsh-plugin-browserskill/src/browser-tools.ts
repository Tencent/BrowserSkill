/**
 * The six model-facing BrowserSkill tools. Each action dispatches to a private
 * operation handler, so the model receives only six schemas while every action
 * retains the existing ownership, cancellation, queuing, observation,
 * screenshot, and presentation behavior.
 */

import { defineTool, type ParameterSchemaSpec, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { SESSION_PARAM, TAB_ID_PARAM, TIMEOUT_MS_PARAM, WAIT_UNTIL_PARAM } from "./tool-params";
import { createBrowserOperationDefinitions, type ToolDeps } from "./tools";

const DEVICE_PRESETS = [
  "iphone-14",
  "iphone-14-pro-max",
  "iphone-se",
  "pixel-7",
  "galaxy-s23",
  "ipad-mini",
  "galaxy-tab-s8",
] as const;

const TARGET_PARAM = {
  type: "string",
  description: "Snapshot ref such as @e3, or a CSS selector.",
} as const;

const DOMAIN_RESULT = { type: "json" } as const;

interface BrowserToolSpec {
  name: string;
  description: string;
  actions: Record<string, string>;
  parameters: ParameterSchemaSpec;
}

function operationArgs(args: unknown): Record<string, unknown> {
  const { action: _action, ...rest } = args as Record<string, unknown>;
  return rest;
}

function definitionFor(
  definitions: ReadonlyMap<string, ToolDefinition>,
  actions: Record<string, string>,
  action: unknown,
): ToolDefinition {
  const operationName = typeof action === "string" ? actions[action] : undefined;
  const definition = operationName === undefined ? undefined : definitions.get(operationName);
  if (definition === undefined) throw new Error(`unsupported browser action: ${String(action)}`);
  return definition;
}

function defineBrowserTool(
  spec: BrowserToolSpec,
  definitions: ReadonlyMap<string, ToolDefinition>,
): ToolDefinition {
  const actionNames = Object.keys(spec.actions);
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: actionNames,
        description:
          "Operation to perform. Other arguments are action-dependent and are validated by that operation.",
      },
      ...spec.parameters,
    },
    output: {
      schema: DOMAIN_RESULT,
      render(args, value) {
        const definition = definitionFor(definitions, spec.actions, args.action);
        return definition.output.render(operationArgs(args), value);
      },
    },
    isConcurrencySafe(args) {
      const definition = definitionFor(definitions, spec.actions, args.action);
      return definition.isConcurrencySafe?.(operationArgs(args)) === true;
    },
    async execute(args, exec) {
      const definition = definitionFor(definitions, spec.actions, args.action);
      return (await definition.execute(operationArgs(args), exec)) as never;
    },
    presentCall(args) {
      const definition = definitionFor(definitions, spec.actions, args.action);
      return definition.presentCall?.(operationArgs(args));
    },
    presentResult(args, result) {
      const definition = definitionFor(definitions, spec.actions, args.action);
      return definition.presentResult?.(operationArgs(args), result);
    },
  });
}

const BROWSER_TOOL_SPECS: BrowserToolSpec[] = [
  {
    name: "browser_session",
    description:
      "Manage plugin-owned browser sessions. Actions: start opens an Agent Window; stop closes an " +
      "owned session; list returns owned sessions. For start, url/device/width/height/noFocus/browser " +
      "are optional. For stop, session is optional and defaults to the current owned session.",
    actions: {
      start: "session.start",
      stop: "session.stop",
      list: "session.list",
    },
    parameters: {
      session: SESSION_PARAM,
      url: { type: "string", description: "Initial URL for start." },
      width: { type: "integer", description: "Agent Window width; start requires height too." },
      height: { type: "integer", description: "Agent Window height; start requires width too." },
      noFocus: { type: "boolean", description: "Start the Agent Window in the background." },
      browser: { type: "string", description: "Browser instance id for start." },
      device: { type: "string", enum: DEVICE_PRESETS, description: "Device preset for start." },
    },
  },
  {
    name: "browser_page",
    description:
      "Navigate and wait on the active Agent Window tab. Actions: navigate, back, forward, reload, " +
      "wait. navigate requires url; reload optionally accepts hard; navigation actions accept " +
      "waitUntil/timeoutMs. Observe again after a meaningful page change before reusing refs.",
    actions: {
      navigate: "page.navigate",
      back: "page.back",
      forward: "page.forward",
      reload: "page.reload",
      wait: "page.wait",
    },
    parameters: {
      session: SESSION_PARAM,
      tabId: TAB_ID_PARAM,
      url: { type: "string", description: "Destination URL; required for navigate." },
      waitUntil: WAIT_UNTIL_PARAM,
      timeoutMs: TIMEOUT_MS_PARAM,
      hard: { type: "boolean", description: "Bypass cache for reload." },
    },
  },
  {
    name: "browser_inspect",
    description:
      "Read page state without arbitrary script execution. Actions: observe, snapshot, html, " +
      "screenshot, console, network. Prefer observe, then snapshot, then bounded html; use screenshot " +
      "for visual evidence. console/network support cursor fields since/limit/maxTextChars.",
    actions: {
      observe: "inspect.observe",
      snapshot: "inspect.snapshot",
      html: "inspect.html",
      screenshot: "inspect.screenshot",
      console: "inspect.console",
      network: "inspect.network",
    },
    parameters: {
      session: SESSION_PARAM,
      tabId: TAB_ID_PARAM,
      maxDepth: { type: "integer", description: "Tree depth cap for observe/snapshot." },
      maxTokens: { type: "integer", description: "Token cap for observe/snapshot." },
      ref: { type: "string", description: "Fresh ref for scoped html or cropped screenshot." },
      maxBytes: { type: "integer", description: "HTML byte cap." },
      since: { type: "integer", description: "Console/network sequence cursor." },
      limit: { type: "integer", description: "Console/network entry cap." },
      maxTextChars: { type: "integer", description: "Console/network per-entry text cap." },
      includeStack: { type: "boolean", description: "Include console stack frames." },
    },
  },
  {
    name: "browser_interact",
    description:
      "Interact with an element in the active Agent Window tab. Actions: click, hover, fill, select, " +
      "press. click/hover/fill/select require target; fill also requires value; select requires " +
      "values; press requires key and may optionally focus target first.",
    actions: {
      click: "interact.click",
      hover: "interact.hover",
      fill: "interact.fill",
      select: "interact.select",
      press: "interact.press",
    },
    parameters: {
      session: SESSION_PARAM,
      tabId: TAB_ID_PARAM,
      target: TARGET_PARAM,
      button: { type: "string", enum: ["left", "middle", "right"], description: "Click button." },
      clickCount: { type: "integer", description: "Click count." },
      value: { type: "string", description: "Text for fill." },
      noClear: { type: "boolean", description: "Append instead of clearing for fill." },
      modifiers: {
        type: "array",
        items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] },
        description: "Modifiers held during hover.",
      },
      settleMs: { type: "integer", description: "Hover settle delay." },
      timeoutMs: TIMEOUT_MS_PARAM,
      values: {
        type: "array",
        items: { type: "string" },
        description: "Option values for select; at least one is required.",
      },
      key: { type: "string", description: "Key or combo for press." },
      holdMs: { type: "integer", description: "Key hold duration for press." },
    },
  },
  {
    name: "browser_tabs",
    description:
      "Manage tabs visible to an owned session. Actions: list, create, select, close, borrow, return. " +
      "select/close/borrow/return require tabId from list/create. Borrow moves a user tab into the " +
      "Agent Window; return it as soon as the task finishes.",
    actions: {
      list: "tabs.list",
      create: "tabs.create",
      select: "tabs.select",
      close: "tabs.close",
      borrow: "tabs.borrow",
      return: "tabs.return",
    },
    parameters: {
      session: SESSION_PARAM,
      tabId: TAB_ID_PARAM,
      scope: {
        type: "string",
        enum: ["user", "agent", "all"],
        description: "Tab scope for list.",
      },
      url: { type: "string", description: "Initial URL for create." },
      active: { type: "boolean", description: "Focus the created tab (default true)." },
      index: { type: "integer", description: "Insertion index for create." },
    },
  },
  {
    name: "browser_assist",
    description:
      "Display and human-assistance operations. Actions: resize, emulate, request-help. resize " +
      "requires width/height; emulate accepts device or width/height/mobile, or off alone; " +
      "request-help requires prompt and can wait for explicit completion criteria.",
    actions: {
      resize: "assist.resize",
      emulate: "assist.emulate",
      "request-help": "assist.request-help",
    },
    parameters: {
      session: SESSION_PARAM,
      tabId: TAB_ID_PARAM,
      width: { type: "integer", description: "Window/viewport width." },
      height: { type: "integer", description: "Window/viewport height." },
      device: { type: "string", enum: DEVICE_PRESETS, description: "Emulation device preset." },
      mobile: { type: "boolean", description: "Enable a mobile viewport with width/height." },
      off: { type: "boolean", description: "Clear emulation; use alone." },
      prompt: { type: "string", description: "Instructions shown to the user for request-help." },
      title: { type: "string", description: "Optional request-help title." },
      targets: {
        type: "array",
        items: { type: "string" },
        description: "Refs/selectors highlighted for request-help.",
      },
      timeoutMs: TIMEOUT_MS_PARAM,
      completionCriteria: {
        type: "object",
        additionalProperties: false,
        description: "Automatic completion detector for request-help.",
        properties: {
          any: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                urlContains: { type: "string" },
                urlMatches: { type: "string" },
                selectorExists: { type: "string" },
                selectorMissing: { type: "string" },
                textExists: { type: "string" },
                textMissing: { type: "string" },
              },
            },
          },
          all: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                urlContains: { type: "string" },
                urlMatches: { type: "string" },
                selectorExists: { type: "string" },
                selectorMissing: { type: "string" },
                textExists: { type: "string" },
                textMissing: { type: "string" },
              },
            },
          },
          stableForMs: { type: "integer" },
        },
      },
    },
  },
];

function indexOperations(definitions: ToolDefinition[]): ReadonlyMap<string, ToolDefinition> {
  const indexed = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    if (indexed.has(definition.name)) {
      throw new Error(`duplicate browser operation definition: ${definition.name}`);
    }
    indexed.set(definition.name, definition);
  }

  const routed = new Set(BROWSER_TOOL_SPECS.flatMap((spec) => Object.values(spec.actions)));
  const missing = [...routed].filter((name) => !indexed.has(name));
  const unreachable = [...indexed.keys()].filter((name) => !routed.has(name));
  if (missing.length > 0 || unreachable.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `missing operations: ${missing.join(", ")}` : undefined,
        unreachable.length > 0 ? `unreachable operations: ${unreachable.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  return indexed;
}

/** Register the complete six-tool browser suite; returns its combined disposer. */
export function registerBrowserTools(deps: ToolDeps): () => void {
  const definitions = indexOperations(createBrowserOperationDefinitions(deps));
  const disposers = BROWSER_TOOL_SPECS.map((spec) =>
    deps.ctx.tools.register(defineBrowserTool(spec, definitions)),
  ).filter((dispose): dispose is () => void => typeof dispose === "function");
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
