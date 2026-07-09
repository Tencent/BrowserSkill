// DOM interaction tools — `tool.click`, `tool.fill`, `tool.press`, and
// `tool.select`.
//
// All interaction tools:
// 1. Resolve target tab (sandbox: must be inside Agent Window).
// 2. Resolve target element by `ref` (RefStore.resolve with tabId
//    binding) or `selector` (DOM.querySelector + describeNode).
// 3. Scroll the node into view, then dispatch the appropriate
//    `Input.*` CDP events.
// 4. Honour `AbortSignal` so canceled calls don't issue follow-up CDP
//    commands.

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type {
  ClickParams,
  ClickResult,
  FillParams,
  FillResult,
  KeyModifier,
  MouseButton,
  PressParams,
  PressResult,
  RpcError,
  SelectParams,
  SelectResult,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import {
  backendNodeToObject,
  boxCentre,
  nodeCentre,
  quadCentre,
  scrollNodeIntoView,
} from "./element-geometry";
import { rpcError } from "./errors";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";
import { resolveSnapshotRef } from "./snapshot-ref";

export interface InteractionDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  /** Abort hook (full chain wired in M10.2). */
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
  /** Temporarily disable overlay click blocker during CDP automation. */
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) {
    defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  }
  return defaultDeps;
}

/**
 * Fold a list of `KeyModifier`s into CDP's bit layout (§4 of the
 * CDP Input domain): alt=1, ctrl=2, meta=4, shift=8.
 *
 * Exported for unit tests.
 */
export function modifiersBitfield(mods: KeyModifier[] | undefined): number {
  if (!mods) return 0;
  let bits = 0;
  for (const m of mods) {
    switch (m) {
      case "alt":
        bits |= 1;
        break;
      case "ctrl":
        bits |= 2;
        break;
      case "meta":
        bits |= 4;
        break;
      case "shift":
        bits |= 8;
        break;
    }
  }
  return bits;
}

function throwIfAborted(signal: AbortSignal | undefined): RpcError | null {
  if (signal?.aborted) {
    return { code: "cancelled", message: "interaction aborted" };
  }
  return null;
}

/**
 * Resolve `{ref?, selector?}` into a `backendNodeId`. Returns an
 * `RpcError` if the caller supplied neither (or both), or if neither
 * lookup matched.
 */
async function resolveBackendNode(
  cdp: CdpRunner,
  ctx: SessionContext,
  target: { tabId: number },
  params: { ref?: string; selector?: string },
  toolName: string,
): Promise<{ backendNodeId: number; usedRef?: string; usedSelector?: string } | RpcError> {
  const hasRef = typeof params.ref === "string" && params.ref.length > 0;
  const hasSelector = typeof params.selector === "string" && params.selector.length > 0;
  if (hasRef && hasSelector) {
    return {
      code: "invalid_params",
      message: `${toolName}: pass either ref or selector, not both`,
    };
  }
  if (!hasRef && !hasSelector) {
    return {
      code: "invalid_params",
      message: `${toolName} requires a ref or a selector`,
    };
  }
  if (hasRef) {
    const resolved = resolveSnapshotRef(ctx, params.ref as string, target.tabId);
    if (isRpcError(resolved)) return resolved;
    return { backendNodeId: resolved.backendNodeId, usedRef: resolved.refKey };
  }
  // selector path
  try {
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(target.tabId, "DOM.getDocument", {
      depth: 0,
    });
    const rootNodeId = doc.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      return {
        code: "cdp_failed",
        message: "DOM.getDocument returned no root nodeId",
      };
    }
    const found = await cdp.send<{ nodeId?: number }>(target.tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: params.selector,
    });
    if (typeof found.nodeId !== "number" || found.nodeId === 0) {
      return rpcError(
        "not_found",
        "selector_not_found",
        `selector ${params.selector} did not match any element`,
      );
    }
    const described = await cdp.send<{ node?: { backendNodeId?: number } }>(
      target.tabId,
      "DOM.describeNode",
      { nodeId: found.nodeId },
    );
    const backendNodeId = described.node?.backendNodeId;
    if (typeof backendNodeId !== "number") {
      return {
        code: "cdp_failed",
        message: "DOM.describeNode returned no backendNodeId",
      };
    }
    return { backendNodeId, usedSelector: params.selector };
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// tool.click
// ---------------------------------------------------------------------------

export async function handleClick(
  manager: SessionManager,
  params: ClickParams,
  deps: InteractionDeps = getDefaultDeps(),
): Promise<ClickResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "click");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const aborted = throwIfAborted(deps.signal);
  if (aborted) return aborted;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "click");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const node = await resolveBackendNode(deps.cdp, ctx, target, params, "click");
  if (isRpcError(node)) return node;

  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "click aborted" };
  }

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    const scrollErr = await scrollNodeIntoView(deps.cdp, target.tabId, node.backendNodeId);
    if (scrollErr) return scrollErr;
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const centre = await nodeCentre(deps.cdp, target.tabId, node.backendNodeId);
  if (isRpcError(centre)) return centre;

  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "click aborted" };
  }

  const button: MouseButton = params.button ?? "left";
  const clickCount = params.click_count ?? 1;
  if (clickCount < 1) {
    return { code: "invalid_params", message: "click_count must be greater than zero" };
  }
  const modifiers = modifiersBitfield(params.modifiers);

  const overlayBlocking = await checkOverlayAtPoint(deps.cdp, target.tabId, centre.x, centre.y);
  let automationBypassEnabled = false;
  if (overlayBlocking && deps.bypassOverlay) {
    try {
      await deps.bypassOverlay(target.tabId, true);
      automationBypassEnabled = true;
    } catch (err) {
      console.debug("[bsk interaction] overlay bypass enable failed", err);
    }
  }

  try {
    // Move first so hover state activates, then press → release.
    await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: centre.x,
      y: centre.y,
      modifiers,
    });
    if (throwIfAborted(deps.signal)) {
      return { code: "cancelled", message: "click aborted" };
    }
    await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: centre.x,
      y: centre.y,
      button,
      clickCount,
      modifiers,
    });
    if (throwIfAborted(deps.signal)) {
      try {
        await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: centre.x,
          y: centre.y,
          button,
          clickCount,
          modifiers,
        });
      } catch (err) {
        console.debug("[bsk interaction] best-effort mouseReleased after abort failed", err);
      }
      return { code: "cancelled", message: "click aborted" };
    }
    await deps.cdp.send(target.tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: centre.x,
      y: centre.y,
      button,
      clickCount,
      modifiers,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (automationBypassEnabled && deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(target.tabId, false);
      } catch (err) {
        console.debug("[bsk interaction] overlay bypass disable failed", err);
      }
    }
  }

  return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
    tab_id: target.tabId,
    used_ref: node.usedRef,
    used_selector: node.usedSelector,
    x: centre.x,
    y: centre.y,
  });
}

interface OverlayHitInspection {
  overlayHostPresent: boolean;
  overlayHostConnected: boolean;
  hitIndex: number;
}

/**
 * Returns true when the control overlay shadow root has a visible layer
 * with pointer-events blocking the click point (mirrors intern execClick).
 */
async function checkOverlayAtPoint(
  cdp: CdpRunner,
  tabId: number,
  x: number,
  y: number,
): Promise<boolean> {
  try {
    const hitTest = await cdp.send<{
      result?: {
        value?: {
          overlayHostPresent?: boolean;
          overlayHostConnected?: boolean;
        } | null;
      };
    }>(tabId, "Runtime.evaluate", {
      expression: `(function() {
        const overlayHost = document.querySelector("[data-bsk-overlay]");
        return {
          overlayHostPresent: !!overlayHost,
          overlayHostConnected: !!overlayHost?.isConnected,
        };
      })()`,
      returnByValue: true,
    });

    const hitTarget = hitTest.result?.value ?? null;
    if (!hitTarget?.overlayHostPresent || !hitTarget.overlayHostConnected) {
      return false;
    }

    const inspection = await cdp.send<{
      result?: { value?: OverlayHitInspection | null };
    }>(tabId, "Runtime.evaluate", {
      expression: `(function() {
        const overlayHost = document.querySelector("[data-bsk-overlay]");
        const shadowRoot = overlayHost instanceof HTMLElement ? overlayHost.shadowRoot : null;
        const overlays = Array.from(shadowRoot?.querySelectorAll("*") ?? []);
        const overlayDetails = overlays
          .map((node) => {
            if (!(node instanceof HTMLElement)) return null;
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return {
              display: style.display,
              pointerEvents: style.pointerEvents,
              connected: node.isConnected,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          })
          .filter((node) => {
            if (!node) return false;
            return (
              node.connected &&
              node.display !== "none" &&
              node.pointerEvents !== "none" &&
              node.rect.width > 0 &&
              node.rect.height > 0
            );
          });
        const hitIndex = overlayDetails.findIndex((node) => {
          const withinX = ${x} >= node.rect.x && ${x} <= node.rect.x + node.rect.width;
          const withinY = ${y} >= node.rect.y && ${y} <= node.rect.y + node.rect.height;
          return withinX && withinY;
        });
        return {
          overlayHostPresent: true,
          overlayHostConnected: true,
          hitIndex,
        };
      })()`,
      returnByValue: true,
    });

    const value = inspection.result?.value;
    return (value?.hitIndex ?? -1) >= 0;
  } catch (err) {
    console.debug("[bsk interaction] overlay hit-test failed", err);
    return false;
  }
}

/**
 * Describes the subset of `DOM.describeNode`'s `node` we inspect to
 * decide whether the target is fillable. `attributes` is the CDP
 * flat-array form (`[name, value, name, value, ...]`).
 */
interface DescribedNode {
  nodeName?: string;
  attributes?: string[];
}

/**
 * Decide whether a node can receive `tool.fill`: native `<input>` /
 * `<textarea>`, or any element flagged `contenteditable="true"`.
 * Exported via `__testing__` for unit coverage.
 */
function isFillable(node: DescribedNode): boolean {
  const tag = (node.nodeName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  const attrs = node.attributes ?? [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i].toLowerCase() === "contenteditable") {
      const value = attrs[i + 1].toLowerCase();
      return value === "" || value === "true" || value === "plaintext-only";
    }
  }
  return false;
}

type SelectMutationResult =
  | {
      ok: true;
      multiple: boolean;
      selected_values: string[];
      selected_labels: string[];
    }
  | {
      ok: false;
      reason: "option_not_found";
      missing?: string;
    };

// ---------------------------------------------------------------------------
// tool.fill
// ---------------------------------------------------------------------------

export async function handleFill(
  manager: SessionManager,
  params: FillParams,
  deps: InteractionDeps = getDefaultDeps(),
): Promise<FillResult | RpcError> {
  if (!params || typeof params.value !== "string") {
    return { code: "invalid_params", message: "fill requires a value string" };
  }
  const ctxOrErr = lookupSession(manager, params, "fill");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "fill aborted" };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "fill");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const node = await resolveBackendNode(deps.cdp, ctx, target, params, "fill");
  if (isRpcError(node)) return node;

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    const described = await deps.cdp.send<{ node?: DescribedNode }>(
      target.tabId,
      "DOM.describeNode",
      {
        backendNodeId: node.backendNodeId,
      },
    );
    if (!described.node || !isFillable(described.node)) {
      return rpcError(
        "invalid_params",
        "target_not_fillable",
        `element ${described.node?.nodeName ?? "?"} not fillable (need input/textarea/contenteditable)`,
      );
    }
    const scrollErr = await scrollNodeIntoView(deps.cdp, target.tabId, node.backendNodeId);
    if (scrollErr) return scrollErr;
    if (throwIfAborted(deps.signal)) {
      return { code: "cancelled", message: "fill aborted" };
    }
    await deps.cdp.send(target.tabId, "DOM.focus", { backendNodeId: node.backendNodeId });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "fill aborted" };
  }

  const objectIdOrErr = await backendNodeToObject(deps.cdp, target.tabId, node.backendNodeId);
  if (isRpcError(objectIdOrErr)) return objectIdOrErr;
  const objectId = objectIdOrErr;
  const clearBefore = params.clear_before ?? true;

  try {
    if (clearBefore) {
      // Clear input/textarea value or wipe contenteditable innerText,
      // then fire `input` so frameworks observe the empty state.
      await deps.cdp.send(target.tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          if (this.isContentEditable) { this.textContent = ''; }
          else {
            const proto = this instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(this, '');
            else this.value = '';
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }`,
        returnByValue: true,
      });
    }
    if (throwIfAborted(deps.signal)) {
      return { code: "cancelled", message: "fill aborted" };
    }
    // CDP `Input.insertText` handles IME / multi-byte input out of the
    // box, much more reliably than per-key `dispatchKeyEvent`.
    await deps.cdp.send(target.tabId, "Input.insertText", { text: params.value });
    if (throwIfAborted(deps.signal)) {
      return { code: "cancelled", message: "fill aborted" };
    }
    // Fire `input` + `change` so React / Vue controlled inputs commit.
    await deps.cdp.send(target.tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      returnByValue: true,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
    tab_id: target.tabId,
    used_ref: node.usedRef,
    used_selector: node.usedSelector,
    value_length: params.value.length,
  });
}

// ---------------------------------------------------------------------------
// tool.press
// ---------------------------------------------------------------------------

const KEY_MODIFIER_SET = new Set<KeyModifier>(["alt", "ctrl", "meta", "shift"]);

/**
 * Normalise a modifier token (case-insensitive, accepts `Control` →
 * `ctrl`, `Cmd`/`Command` → `meta`, `Option`/`Opt` → `alt`). Returns
 * `null` if the token isn't recognised as a modifier.
 */
function normaliseModifier(token: string): KeyModifier | null {
  const lower = token.toLowerCase();
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt" || lower === "option" || lower === "opt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") {
    return "meta";
  }
  return null;
}

/**
 * Split a compound key spec like `Ctrl+Shift+P` into its modifier
 * list and base key name. Single keys (`Enter`, `a`) come back with
 * an empty modifier list.
 *
 * The split is `+`-delimited; modifier matching is case-insensitive
 * and order-independent. Whitespace around tokens is trimmed.
 */
export function parseKeySpec(spec: string): { key: string; modifiers: KeyModifier[] } {
  const parts = spec
    .split("+")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length <= 1) {
    return { key: spec.trim(), modifiers: [] };
  }
  const mods: KeyModifier[] = [];
  let baseKey: string | null = null;
  for (const part of parts) {
    const mod = normaliseModifier(part);
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod);
    } else {
      baseKey = part;
    }
  }
  return { key: baseKey ?? parts[parts.length - 1], modifiers: mods };
}

interface KeyDescriptor {
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode?: number;
}

const SPECIAL_KEYMAP: Record<string, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", text: "\t", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Space: { key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 },
};

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYMAP[`F${i}`] = {
    key: `F${i}`,
    code: `F${i}`,
    windowsVirtualKeyCode: 111 + i,
  };
}

/**
 * Translate a logical key name (`Enter`, `a`, `3`, `F5`, `ArrowDown`)
 * into the CDP `Input.dispatchKeyEvent` descriptor. Returns `null`
 * for keys we don't recognise (caller surfaces `invalid_params`).
 */
export function resolveKeyDescriptor(key: string): KeyDescriptor | null {
  if (key.length === 0) return null;
  if (SPECIAL_KEYMAP[key]) return SPECIAL_KEYMAP[key];
  if (key.length === 1) {
    const ch = key;
    const upper = ch.toUpperCase();
    if (upper >= "A" && upper <= "Z") {
      return {
        key: ch,
        code: `Key${upper}`,
        text: ch,
        windowsVirtualKeyCode: upper.charCodeAt(0),
      };
    }
    if (ch >= "0" && ch <= "9") {
      return {
        key: ch,
        code: `Digit${ch}`,
        text: ch,
        windowsVirtualKeyCode: ch.charCodeAt(0),
      };
    }
    // Common punctuation falls back to `text` only. Browsers
    // synthesise the right code from `text` when CDP can't find one.
    return { key: ch, code: "", text: ch };
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) {
      onAbort = finish;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function handlePress(
  manager: SessionManager,
  params: PressParams,
  deps: InteractionDeps = getDefaultDeps(),
): Promise<PressResult | RpcError> {
  if (!params || typeof params.key !== "string" || params.key.length === 0) {
    return { code: "invalid_params", message: "press requires a key string" };
  }
  const ctxOrErr = lookupSession(manager, params, "press");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "press aborted" };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "press");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const parsed = parseKeySpec(params.key);
  // Merge param `modifiers` with anything parsed from the compound
  // key string; de-duplicate.
  const mods: KeyModifier[] = [...parsed.modifiers];
  for (const m of params.modifiers ?? []) {
    if (KEY_MODIFIER_SET.has(m) && !mods.includes(m)) mods.push(m);
  }
  const descriptor = resolveKeyDescriptor(parsed.key);
  if (!descriptor) {
    return {
      code: "invalid_params",
      message: `press: unknown key "${parsed.key}"`,
    };
  }

  // Optional focus before key dispatch.
  if (params.ref || params.selector) {
    const node = await resolveBackendNode(deps.cdp, ctx, target, params, "press");
    if (isRpcError(node)) return node;
    try {
      deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
      const scrollErr = await scrollNodeIntoView(deps.cdp, target.tabId, node.backendNodeId);
      if (scrollErr) return scrollErr;
      if (throwIfAborted(deps.signal)) {
        return { code: "cancelled", message: "press aborted" };
      }
      await deps.cdp.send(target.tabId, "DOM.focus", { backendNodeId: node.backendNodeId });
    } catch (err) {
      return {
        code: "cdp_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "press aborted" };
  }

  const modifiers = modifiersBitfield(mods);
  // Suppress `text` when any non-shift modifier is held — `Ctrl+a`
  // should not also type the character "a" into the focused field.
  const suppressText = mods.some((m) => m === "ctrl" || m === "meta" || m === "alt");
  try {
    let cancelled = false;
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await deps.cdp.send(target.tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers,
    });
    cancelled = throwIfAborted(deps.signal) !== null;
    if (
      !cancelled &&
      !suppressText &&
      typeof descriptor.text === "string" &&
      descriptor.text.length > 0
    ) {
      await deps.cdp.send(target.tabId, "Input.dispatchKeyEvent", {
        type: "char",
        key: descriptor.key,
        code: descriptor.code,
        text: descriptor.text,
        modifiers,
      });
      cancelled = throwIfAborted(deps.signal) !== null;
    }
    if (!cancelled && params.hold_ms && params.hold_ms > 0) {
      await sleep(params.hold_ms, deps.signal);
      if (throwIfAborted(deps.signal)) {
        // Still send keyUp so the page doesn't think the key is stuck
        // down — best-effort.
        cancelled = true;
      }
    }
    await deps.cdp.send(target.tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      modifiers,
    });
    if (cancelled || throwIfAborted(deps.signal)) {
      return { code: "cancelled", message: "press aborted" };
    }
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
    tab_id: target.tabId,
    key: descriptor.key,
    code: descriptor.code,
    modifiers: mods,
  });
}

// ---------------------------------------------------------------------------
// tool.select
// ---------------------------------------------------------------------------

export async function handleSelect(
  manager: SessionManager,
  params: SelectParams,
  deps: InteractionDeps = getDefaultDeps(),
): Promise<SelectResult | RpcError> {
  if (!params || !Array.isArray(params.values)) {
    return { code: "invalid_params", message: "select requires a values array" };
  }
  if (!params.values.every((value) => typeof value === "string")) {
    return { code: "invalid_params", message: "select values must all be strings" };
  }
  const ctxOrErr = lookupSession(manager, params, "select");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "select aborted" };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "select");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const node = await resolveBackendNode(deps.cdp, ctx, target, params, "select");
  if (isRpcError(node)) return node;

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    const described = await deps.cdp.send<{ node?: DescribedNode }>(
      target.tabId,
      "DOM.describeNode",
      { backendNodeId: node.backendNodeId },
    );
    if (!described.node || (described.node.nodeName ?? "").toUpperCase() !== "SELECT") {
      return rpcError(
        "invalid_params",
        "target_not_select",
        `element ${described.node?.nodeName ?? "?"} not a <select>`,
      );
    }
    const attrs = described.node.attributes ?? [];
    const isMultiple = attrs.some(
      (attr, idx) => idx % 2 === 0 && attr.toLowerCase() === "multiple",
    );
    if (!isMultiple && params.values.length !== 1) {
      return rpcError(
        "invalid_params",
        "single_select_value_count",
        "single-select <select> requires exactly one value",
      );
    }
    const scrollErr = await scrollNodeIntoView(deps.cdp, target.tabId, node.backendNodeId);
    if (scrollErr) return scrollErr;
    if (throwIfAborted(deps.signal)) {
      return { code: "cancelled", message: "select aborted" };
    }
    await deps.cdp.send(target.tabId, "DOM.focus", { backendNodeId: node.backendNodeId });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (throwIfAborted(deps.signal)) {
    return { code: "cancelled", message: "select aborted" };
  }

  const objectIdOrErr = await backendNodeToObject(deps.cdp, target.tabId, node.backendNodeId);
  if (isRpcError(objectIdOrErr)) return objectIdOrErr;
  const objectId = objectIdOrErr;

  try {
    const evaluated = await deps.cdp.send<{
      result?: { value?: SelectMutationResult | null };
    }>(target.tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(values) {
        const select = this;
        const multiple = select.multiple;
        const known = new Set(Array.from(select.options).map((o) => o.value));
        for (const v of values) {
          if (!known.has(v)) {
            return { ok: false, reason: 'option_not_found', missing: v };
          }
        }
        const want = new Set(values);
        for (const opt of select.options) {
          opt.selected = want.has(opt.value);
        }
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const selected = Array.from(select.selectedOptions);
        return {
          ok: true,
          multiple,
          selected_values: selected.map((o) => o.value),
          selected_labels: selected.map((o) => o.text),
        };
      }`,
      arguments: [{ value: params.values }],
      returnByValue: true,
    });
    const mutation = evaluated.result?.value;
    if (!mutation?.ok) {
      if (mutation?.reason === "option_not_found") {
        return rpcError(
          "invalid_params",
          "option_not_found",
          `option value ${mutation.missing ?? "?"} not found in <select>`,
        );
      }
      return { code: "cdp_failed", message: "select mutation returned an unexpected result" };
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      used_ref: node.usedRef,
      used_selector: node.usedSelector,
      multiple: mutation.multiple,
      selected_values: mutation.selected_values,
      selected_labels: mutation.selected_labels,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const __testing__ = {
  DEFAULT_TIMEOUT_MS,
  quadCentre,
  boxCentre,
  resolveBackendNode,
  nodeCentre,
  isFillable,
};
