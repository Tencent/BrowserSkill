import {
  debugActions,
  type ExtensionToolMethod,
  methods,
  videoActions,
} from "@/transport/generated/methods";

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

// Derived directly from bsk-protocol MethodSpec so TS and Rust stay lockstep.
export const TOOL_POLICIES = Object.fromEntries(
  methods
    .filter((entry) => entry.owner === "extension")
    .map((entry) => [
      entry.method,
      {
        background: entry.background,
        resumeControl: entry.resume_control,
        opensTabs: entry.opens_tabs,
        remoteAllowed: entry.remote_allowed,
        autoBorrowWrite: entry.auto_borrow_write,
        cooperation: entry.cooperation as CooperationMode,
        domTargeted: entry.dom_targeted,
        bootstrapAllowed: entry.bootstrap_allowed,
      } satisfies ToolPolicy,
    ]),
) as Record<ExtensionToolMethod, ToolPolicy>;

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

const videoActionSet = new Set<string>(videoActions.map((entry) => entry.action));
const resumingVideoActions = new Set<string>(
  videoActions.filter((entry) => entry.resumes_control).map((entry) => entry.action),
);

export function isPassiveDebugAction(action: string | undefined): boolean {
  return action !== undefined && passiveDebugActions.has(action);
}

export function isKnownVideoAction(action: string | undefined): boolean {
  return action !== undefined && videoActionSet.has(action);
}

export function resumesBrowserControl(method: ExtensionToolMethod, params: unknown): boolean {
  const policy = TOOL_POLICIES[method];
  if (policy.resumeControl === "never") return false;
  if (policy.resumeControl === "always") return true;
  const action = (params as { action?: unknown } | undefined)?.action;
  if (method === "tool.video") {
    return typeof action === "string" && resumingVideoActions.has(action);
  }
  if (method !== "tool.debug") {
    const effect = effects.get(method);
    return effect === "browser_mutation" || effect === "transient_input";
  }
  return debugActions.some(
    (definition) => definition.action === action && definition.effect === "browser_mutation",
  );
}
