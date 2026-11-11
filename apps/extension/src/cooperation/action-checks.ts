import {
  RECORD_PASSWORD_ATTRIBUTE,
  SENSITIVE_AUTOCOMPLETE_SELECTOR,
} from "@/lib/sensitive-autocomplete";
import type { SessionContext } from "@/session-manager/manager";
import { isMissingNode } from "@/tools/errors";
import { FOCUS_CHECK } from "@/tools/focus-state";
import { type ResolvedActionTarget, resolveActionTarget } from "@/tools/interaction";
import {
  type CdpRunner,
  isRpcError,
  type ResolvedTargetTab,
  sendToCdpTarget,
} from "@/tools/shared";
import type { RpcError, RpcErrorReason } from "@/transport/types";

export interface ActionExpectation {
  target: string;
  field: "text" | "value" | "checked" | "attribute" | "exists";
  equals: string | boolean | null;
  attribute?: string;
}

/** Preserve the actual failed check across handler/dispatch exception boundaries. */
export class ActionCheckError extends Error {
  constructor(readonly rpcError: RpcError) {
    super(rpcError.message);
  }
}

export function actionError(
  reason: RpcErrorReason,
  message: string,
  phase: "control" | "observation" | "target" | "precondition",
  recovery: string,
  details: Record<string, unknown> = {},
): RpcError {
  return {
    code: "permission_denied",
    message,
    data: { reason, phase, effect_state: "none", recovery, ...details },
  };
}

export function parseExpectations(value: unknown): ActionExpectation[] | RpcError {
  if (value === undefined) return [];
  const invalid: RpcError = {
    code: "invalid_params",
    message:
      "expect requires at most 16 checks with target, field and equals; only attribute checks accept attribute",
    data: { reason: "precondition_invalid", phase: "precondition", effect_state: "none" },
  };
  if (!Array.isArray(value) || value.length > 16) return invalid;
  for (const check of value) {
    if (
      !check ||
      typeof check !== "object" ||
      Array.isArray(check) ||
      Object.keys(check).some((key) => !["target", "field", "equals", "attribute"].includes(key)) ||
      typeof check.target !== "string" ||
      !check.target.trim() ||
      [...check.target].length > 1024
    )
      return invalid;
    if (check.field === "attribute") {
      if (
        typeof check.attribute !== "string" ||
        !check.attribute.trim() ||
        [...check.attribute].length > 256 ||
        (check.equals !== null && typeof check.equals !== "string")
      )
        return invalid;
    } else {
      if (check.attribute !== undefined) return invalid;
      if (["text", "value"].includes(check.field)) {
        if (typeof check.equals !== "string") return invalid;
      } else if (["checked", "exists"].includes(check.field)) {
        if (typeof check.equals !== "boolean") return invalid;
      } else return invalid;
    }
  }
  return value;
}

/** Fixed read-only probes; page text and supplied expected values are never code. */
const SAMPLE_TARGET = `function(field, attribute, needRowAnchor) {
  if (!this.isConnected) return { connected: false };
  if (field === 'exists') return { connected: true, value: true };
  if (field === 'text') return { connected: true, value: this.textContent };
  const sensitiveSelector = 'input[type="password"],input[type="file"],input[type="hidden"],' + ${JSON.stringify(`[${RECORD_PASSWORD_ATTRIBUTE}],${SENSITIVE_AUTOCOMPLETE_SELECTOR}`)};
  const sensitive = this.matches(sensitiveSelector);
  if (field === 'attribute') return { connected: true, value: this.getAttribute(attribute), redacted: sensitive && attribute.toLowerCase() === 'value' };
  if (field) return { connected: true, value: this[field] ?? null, redacted: sensitive && field === 'value' };
  const style = getComputedStyle(this);
  let rowAnchor = null;
  if (needRowAnchor) {
    const el = this;
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const directText = (n) => {
      const parts = [];
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const t = String(c.nodeValue || '').trim();
          if (t) parts.push(t);
        }
      }
      return parts.length ? clean(parts.join(' ')) : '';
    };
    const stopTags = new Set(['body','html','form','table','main','nav','header','footer','section','article','aside','dialog']);
    const nonAnchorTags = new Set(['button','input','select','textarea','option','optgroup','summary','script','style','noscript','template','svg']);
    const nonAnchorRoles = new Set(['button','checkbox','combobox','listbox','menuitem','menuitemcheckbox','menuitemradio','option','radio','searchbox','slider','spinbutton','switch','tab','textbox','treeitem']);
    const timerRe = /^(?:\\d{1,2}:\\d{2}(?::\\d{2})?|\\d+\\s*(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|秒|分钟|分|小时)(?:\\s*前|\\s*ago)?)$/i;
    const findRow = () => {
      let cur = el.parentElement;
      for (let hop = 0; hop < 12 && cur; hop++) {
        const t = cur.tagName.toLowerCase();
        if (t === 'body' || t === 'html') break;
        const r = (cur.getAttribute('role') || '').trim().toLowerCase();
        if (t === 'tr' || t === 'li' || r === 'row' || r === 'listitem') return cur;
        cur = cur.parentElement;
      }
      if (el.closest('form')) return null;
      cur = el.parentElement;
      for (let hop = 0; hop < 3 && cur; hop++) {
        const t = cur.tagName.toLowerCase();
        if (stopTags.has(t)) break;
        if (t === 'div') {
          const r = (cur.getAttribute('role') || '').trim().toLowerCase();
          const cls = (cur.getAttribute('class') || '').trim();
          const pool = cur.parentElement;
          const poolTag = pool ? pool.tagName.toLowerCase() : '';
          if (
            cls &&
            (!r || r === 'generic' || r === 'none' || r === 'presentation') &&
            cur.children.length >= 1 &&
            cur.children.length <= 12 &&
            pool &&
            poolTag !== 'body' &&
            poolTag !== 'html' &&
            poolTag !== 'form' &&
            poolTag !== 'label' &&
            poolTag !== 'fieldset'
          ) {
            let same = 0;
            for (let i = 0; i < pool.children.length && same < 4; i++) {
              const sib = pool.children[i];
              if (sib.tagName.toLowerCase() === 'div' && (sib.getAttribute('class') || '').trim() === cls) {
                same++;
              }
            }
            if (same >= 4) return cur;
          }
        }
        cur = cur.parentElement;
      }
      return null;
    };
    const slotText = (n) => {
      if (n === el || !(n instanceof Element)) return '';
      if (n.hasAttribute('hidden') || (n.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return '';
      const t = n.tagName.toLowerCase();
      if (nonAnchorTags.has(t)) return '';
      const r = (n.getAttribute('role') || '').trim().toLowerCase();
      if (r && nonAnchorRoles.has(r)) return '';
      if (n.matches(sensitiveSelector)) return '';
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return '';
      const op = parseFloat(st.opacity || '1');
      if (Number.isFinite(op) && op < 0.05) return '';
      const fs = parseFloat(st.fontSize || '16');
      if (Number.isFinite(fs) && fs <= 1.5) return '';
      const parts = [];
      let len = 0;
      const own = directText(n);
      if (own) {
        parts.push(own);
        len += own.length;
      }
      for (let i = 0; i < n.children.length; i++) {
        const sub = slotText(n.children[i]);
        if (sub) {
          parts.push(sub);
          len += sub.length + 1;
          if (len >= 160) break;
        }
      }
      return parts.length ? clean(parts.join(' ')) : '';
    };
    const row = findRow();
    if (row) {
      const selfText = clean(el.textContent).toLowerCase();
      const selfAria = clean(el.getAttribute('aria-label')).toLowerCase();
      const accept = (raw) => {
        if (!raw || timerRe.test(raw)) return null;
        const lower = raw.toLowerCase();
        if ((selfText && lower === selfText) || (selfAria && lower === selfAria)) return null;
        const cps = Array.from(raw);
        return cps.length > 80 ? cps.slice(0, 80).join('').trim() : raw;
      };
      rowAnchor = accept(directText(row));
      if (!rowAnchor) {
        for (let i = 0; i < row.children.length; i++) {
          rowAnchor = accept(slotText(row.children[i]));
          if (rowAnchor) break;
        }
      }
    }
  }
  return {
    connected: true,
    visible: (this.getClientRects().length > 0 || style.display === 'contents') && style.visibility !== 'hidden' && style.visibility !== 'collapse',
    disabled: this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true' || !!this.closest('[inert]'),
    readOnly: this.readOnly === true,
    focused: (${FOCUS_CHECK}).call(this),
    ...(needRowAnchor ? { rowAnchor } : {})
  };
}`;

interface Sample {
  connected: boolean;
  value?: string | boolean | null;
  visible?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  focused?: boolean;
  redacted?: boolean;
  rowAnchor?: string | null;
}

async function sample(
  cdp: CdpRunner,
  target: ResolvedActionTarget,
  check?: ActionExpectation,
): Promise<Sample | RpcError> {
  const objectGroup = `action-check-${crypto.randomUUID()}`;
  const send = <T>(method: string, params: object) =>
    sendToCdpTarget<T>(cdp, target.cdpTarget, method, params);
  try {
    const resolved = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", {
      backendNodeId: target.backendNodeId,
      objectGroup,
    });
    if (!resolved.object?.objectId) return { connected: false };
    const reply = await send<{ result?: { value?: Sample }; exceptionDetails?: unknown }>(
      "Runtime.callFunctionOn",
      {
        objectId: resolved.object.objectId,
        functionDeclaration: SAMPLE_TARGET,
        arguments: [
          { value: check?.field ?? null },
          { value: check?.attribute ?? null },
          { value: !check && Boolean(target.usedRef && target.rowAnchor) },
        ],
        returnByValue: true,
      },
    );
    if (reply.exceptionDetails || !reply.result?.value)
      return actionError(
        "target_unavailable",
        "Could not inspect the action target",
        "target",
        "Inspect the target again before deciding on another action.",
      );
    return reply.result.value;
  } catch (error) {
    // CDP can collect an already removed node before it can be sampled. This is
    // the same detached identity, not an unavailable browser or a new target.
    if (isMissingNode(error)) return { connected: false };
    return actionError(
      "target_unavailable",
      error instanceof Error ? error.message : String(error),
      "target",
      "Inspect the target again; the document or node may have been replaced.",
    );
  } finally {
    // Navigation may already have released the execution context.
    await send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

export async function checkActionTarget(
  cdp: CdpRunner,
  target: ResolvedActionTarget,
  method: string,
  requireFocus = false,
): Promise<RpcError | undefined> {
  const facts = await sample(cdp, target);
  if (isRpcError(facts)) return facts;
  if (
    facts.connected &&
    target.usedRef &&
    target.rowAnchor &&
    facts.rowAnchor !== target.rowAnchor
  ) {
    return actionError(
      "virtual_row_recycled",
      `Target @${target.usedRef} belonged to row "${target.rowAnchor}", but its DOM slot now renders "${facts.rowAnchor ?? "(empty)"}"`,
      "target",
      "Run cooperate sync (or observe) to refresh refs for the updated rows before retrying.",
      {
        target: `@${target.usedRef}`,
        expected_row: target.rowAnchor,
        actual_row: facts.rowAnchor ?? null,
        backend_node_id: target.backendNodeId,
        ...(target.frameId ? { frame_id: target.frameId } : {}),
      },
    );
  }
  const reason = !facts.connected
    ? "target_detached"
    : !facts.visible && !["tool.upload", "tool.blur"].includes(method)
      ? "target_hidden"
      : facts.disabled &&
          !["tool.hover", "tool.scroll_to", "tool.wheel", "tool.blur"].includes(method)
        ? "target_disabled"
        : facts.readOnly && method === "tool.fill"
          ? "target_readonly"
          : requireFocus && !facts.focused
            ? "target_focus_lost"
            : undefined;
  const messages = {
    target_detached: "The action target was removed from its document",
    target_hidden: "The action target is not visible",
    target_disabled: "The action target is disabled",
    target_readonly: "The fill target is read-only",
    target_focus_lost: "Keyboard focus moved away from the requested target",
  };
  if (reason)
    return actionError(
      reason,
      messages[reason],
      "target",
      "Inspect or wait for this target to become actionable. A new control context is not required unless control or the document changed.",
      {
        target: target.usedRef ? `@${target.usedRef}` : target.usedSelector,
        backend_node_id: target.backendNodeId,
        ...(target.frameId ? { frame_id: target.frameId } : {}),
      },
    );
}

export async function checkExpectations(
  cdp: CdpRunner,
  session: SessionContext,
  tab: ResolvedTargetTab,
  checks: readonly ActionExpectation[],
): Promise<RpcError | undefined> {
  for (const check of checks) {
    const target = await resolveActionTarget(
      cdp,
      session,
      tab,
      /^@?e\d+$/.test(check.target) ? { ref: check.target } : { selector: check.target },
      "precondition",
      true,
    );
    let actual: string | boolean | null | undefined;
    let redacted = false;
    if (isRpcError(target)) {
      if (check.field === "exists" && target.data?.reason === "selector_not_found") actual = false;
      else
        return {
          ...target,
          message:
            target.data?.reason === "selector_not_found"
              ? `${target.message}. CSS selectors search the main document; use an observed ref for iframe elements.`
              : target.message,
          data: {
            ...target.data,
            phase: "precondition",
            effect_state: "none",
            target: check.target,
          },
        };
    } else {
      const facts = await sample(cdp, target, check);
      if (isRpcError(facts)) return facts;
      if (!facts.connected && check.field !== "exists")
        return actionError(
          "target_detached",
          `Precondition target ${check.target} was removed from its document`,
          "precondition",
          "Observe again, or use a selector for elements that re-render, before deciding.",
          { target: check.target },
        );
      actual = check.field === "exists" ? facts.connected : facts.value;
      redacted = facts.redacted === true;
    }
    if (actual !== check.equals)
      return actionError(
        "precondition_failed",
        `Precondition failed: ${check.target} ${check.field}${check.attribute ? ` ${check.attribute}` : ""}`,
        "precondition",
        "Read the changed business fact and decide again. Do not replace the expected value without reconsidering the action.",
        {
          target: check.target,
          field: check.field,
          ...(check.attribute ? { attribute: check.attribute } : {}),
          expected: redacted ? "•••" : check.equals,
          actual: redacted ? "•••" : actual,
          ...(redacted ? { redacted: true } : {}),
        },
      );
  }
}
