import { debugActions, type ExtensionToolMethod, methods } from "@/transport/generated/methods";

export type CooperationMode =
  | "session_start"
  | "cooperate"
  | "session"
  | "dialog"
  | "manage_tabs"
  | "request_help"
  | "record_start"
  | "passive_read"
  | "debug"
  | "video"
  | "guarded_action";

export interface ToolPolicy {
  background: "none" | "accessible" | "controlled" | "navigation";
  resumeControl: "effect" | "always" | "never";
  opensTabs: boolean;
  remoteAllowed: boolean;
  autoBorrowWrite: boolean;
  cooperation: CooperationMode;
  /** True only when a resolved DOM target completely identifies the input recipient. */
  domTargeted: boolean;
  /** True when the untouched initial blank tab may run this action before its first sync. */
  bootstrapAllowed: boolean;
}

// Every extension method must deliberately select each local execution and cooperation policy.
export const TOOL_POLICIES = {
  "tool.cooperate": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "cooperate",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.session_start": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session_start",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.session_stop": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.window_resize": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: true,
  },
  "tool.emulate": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: true,
  },
  "tool.tab_list": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.tab_create": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "manage_tabs",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.tab_close": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: true,
  },
  "tool.tab_borrow": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "manage_tabs",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.tab_return": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "manage_tabs",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.tab_select": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "manage_tabs",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.navigate": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: true,
  },
  "tool.navigate_back": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.navigate_forward": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.reload": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.click": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: true,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.hover": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.drag": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: true,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.wheel": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.scroll_to": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.focus": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.blur": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.fill": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.press": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: true,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.select": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.upload": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: false,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.download": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: false,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: true,
    bootstrapAllowed: false,
  },
  "tool.snapshot": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.observe": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.get_html": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.read": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.screenshot": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.screenshot_full_page": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.screenshot_read": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.screenshot_release": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.console": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.extract": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.wait_for_element": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.video": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "video",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.debug": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "debug",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.network": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.evaluate": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "guarded_action",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.wait_for_navigation": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: true,
    cooperation: "passive_read",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.dialog_status": {
    background: "none",
    resumeControl: "never",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "dialog",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.dialog_accept": {
    background: "none",
    resumeControl: "never",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "dialog",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.dialog_dismiss": {
    background: "none",
    resumeControl: "never",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "dialog",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.request_help": {
    background: "none",
    resumeControl: "always",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "request_help",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.record_start": {
    background: "none",
    resumeControl: "always",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "record_start",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.record_stop": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session",
    domTargeted: false,
    bootstrapAllowed: false,
  },
  "tool.record_await": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
    autoBorrowWrite: false,
    cooperation: "session",
    domTargeted: false,
    bootstrapAllowed: false,
  },
} satisfies Record<ExtensionToolMethod, ToolPolicy>;

export function toolPolicy(method: string): ToolPolicy | undefined {
  return Object.hasOwn(TOOL_POLICIES, method)
    ? TOOL_POLICIES[method as ExtensionToolMethod]
    : undefined;
}

const effects = new Map(methods.map((method) => [method.method, method.effect]));

const passiveDebugActions = new Set<string>(
  debugActions
    .filter((entry) => entry.owner === "extension" && !entry.cooperation_guarded)
    .map((entry) => entry.action),
);

export function isPassiveDebugAction(action: string | undefined): boolean {
  return action !== undefined && passiveDebugActions.has(action);
}

export function resumesBrowserControl(method: ExtensionToolMethod, params: unknown): boolean {
  const policy = TOOL_POLICIES[method];
  if (policy.resumeControl === "never") return false;
  if (policy.resumeControl === "always") return true;
  if (method === "tool.video")
    return (params as { action?: unknown } | undefined)?.action === "start";
  if (method !== "tool.debug") {
    const effect = effects.get(method);
    return effect === "browser_mutation" || effect === "transient_input";
  }
  const action = (params as { action?: unknown } | undefined)?.action;
  return debugActions.some(
    (definition) => definition.action === action && definition.effect === "browser_mutation",
  );
}
