import type { SessionContext } from "@/session-manager/manager";
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
const SAMPLE_TARGET = `function(field, attribute) {
  if (!this.isConnected) return { connected: false };
  if (field === 'exists') return { connected: true, value: true };
  if (field === 'text') return { connected: true, value: this.textContent };
  const sensitive = this.matches('input[type="password"],input[type="file"],input[type="hidden"]');
  if (field === 'attribute') return { connected: true, value: this.getAttribute(attribute), redacted: sensitive && attribute.toLowerCase() === 'value' };
  if (field) return { connected: true, value: this[field] ?? null, redacted: sensitive && field === 'value' };
  const style = getComputedStyle(this);
  return {
    connected: true,
    visible: (this.getClientRects().length > 0 || style.display === 'contents') && style.visibility !== 'hidden' && style.visibility !== 'collapse',
    disabled: this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true' || !!this.closest('[inert]'),
    readOnly: this.readOnly === true,
    focused: (${FOCUS_CHECK}).call(this)
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
        arguments: [{ value: check?.field ?? null }, { value: check?.attribute ?? null }],
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
      { target: target.usedRef ? `@${target.usedRef}` : target.usedSelector },
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
      actual = check.field === "exists" ? facts.connected : facts.connected ? facts.value : null;
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
