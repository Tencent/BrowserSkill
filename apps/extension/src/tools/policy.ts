import { debugActions, type ExtensionToolMethod, methods } from "@/transport/generated/methods";

export interface ToolPolicy {
  background: "none" | "accessible" | "controlled" | "navigation";
  resumeControl: "effect" | "always";
  opensTabs: boolean;
  remoteAllowed: boolean;
}

// Every extension method must deliberately select each local execution policy.
export const TOOL_POLICIES = {
  "tool.session_start": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.session_stop": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.window_resize": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.emulate": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.tab_list": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.tab_create": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.tab_close": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.tab_borrow": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.tab_return": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.tab_select": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.navigate": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.navigate_back": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.navigate_forward": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.reload": {
    background: "navigation",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.click": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: true,
    remoteAllowed: true,
  },
  "tool.hover": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.wheel": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.scroll_to": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.focus": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.blur": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.fill": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.press": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: true,
    remoteAllowed: true,
  },
  "tool.select": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.upload": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: false,
  },
  "tool.download": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: false,
  },
  "tool.snapshot": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.observe": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.get_html": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.screenshot": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.screenshot_full_page": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.screenshot_read": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.screenshot_release": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.console": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.debug": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.network": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.evaluate": {
    background: "accessible",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.wait_for_navigation": {
    background: "controlled",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.request_help": {
    background: "none",
    resumeControl: "always",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.record_start": {
    background: "none",
    resumeControl: "always",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.record_stop": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
  "tool.record_await": {
    background: "none",
    resumeControl: "effect",
    opensTabs: false,
    remoteAllowed: true,
  },
} satisfies Record<ExtensionToolMethod, ToolPolicy>;

export function toolPolicy(method: string): ToolPolicy | undefined {
  return Object.hasOwn(TOOL_POLICIES, method)
    ? TOOL_POLICIES[method as ExtensionToolMethod]
    : undefined;
}

const effects = new Map(methods.map((method) => [method.method, method.effect]));

export function resumesBrowserControl(method: ExtensionToolMethod, params: unknown): boolean {
  if (method !== "tool.debug") {
    const effect = effects.get(method);
    return (
      TOOL_POLICIES[method].resumeControl === "always" ||
      effect === "browser_mutation" ||
      effect === "transient_input"
    );
  }
  const action = (params as { action?: unknown } | undefined)?.action;
  return debugActions.some(
    (definition) => definition.action === action && definition.effect === "browser_mutation",
  );
}
