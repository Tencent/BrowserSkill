// Browser-native editing transaction for input, textarea, and contenteditable
// targets. The CDP target/session is selected by interaction.ts; this module
// owns the shorter-lived editable identity inside that target.

import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import type { CdpRunner } from "./shared";

interface EditableState {
  supported: boolean;
  connected: boolean;
  focused: boolean;
  value: string;
  kind: "input" | "textarea" | "contenteditable" | "unsupported";
}

export interface EditableFillResult {
  value: string;
  replacedNode: boolean;
}

function cancelled(signal: AbortSignal | undefined): RpcError | null {
  return signal?.aborted ? { code: "cancelled", message: "fill aborted" } : null;
}

async function inspectEditable(
  cdp: CdpRunner,
  tabId: number,
  objectId: string,
): Promise<EditableState> {
  const reply = await cdp.send<{
    result?: { value?: EditableState };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      /* bsk-editable-state */
      const doc = this.ownerDocument;
      const focused = !!doc && doc.activeElement === this;
      if (this instanceof HTMLInputElement) {
        return { supported: true, connected: this.isConnected, focused,
          value: this.value, kind: 'input' };
      }
      if (this instanceof HTMLTextAreaElement) {
        return { supported: true, connected: this.isConnected, focused,
          value: this.value, kind: 'textarea' };
      }
      if (this.isContentEditable) {
        return { supported: true, connected: this.isConnected, focused,
          value: this.innerText ?? this.textContent ?? '', kind: 'contenteditable' };
      }
      return { supported: false, connected: this.isConnected === true, focused,
        value: '', kind: 'unsupported' };
    }`,
    returnByValue: true,
  });
  const state = reply.result?.value;
  if (!state || typeof state.value !== "string") {
    throw new Error("editable state probe returned no value");
  }
  return state;
}

/**
 * Return the active editable from the anchor's own document. Using the
 * anchor's execution context also works for same-process nested frames, where
 * a target-level Runtime.evaluate would otherwise see the top document.
 */
async function focusedEditableFromAnchor(
  cdp: CdpRunner,
  tabId: number,
  anchorObjectId: string,
): Promise<string | null> {
  const reply = await cdp.send<{
    result?: { objectId?: string; subtype?: string };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId: anchorObjectId,
    functionDeclaration: `function() {
      /* bsk-editable-live */
      const active = this.ownerDocument?.activeElement;
      if (!active) return null;
      const editable = active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement || active.isContentEditable;
      return editable ? active : null;
    }`,
    returnByValue: false,
  });
  if (reply.result?.subtype === "null") return null;
  return typeof reply.result?.objectId === "string" ? reply.result.objectId : null;
}

async function resolveLiveEditable(
  cdp: CdpRunner,
  tabId: number,
  anchorObjectId: string,
): Promise<{ objectId: string; state: EditableState; replaced: boolean } | RpcError> {
  const anchor = await inspectEditable(cdp, tabId, anchorObjectId);
  if (anchor.supported && anchor.connected && anchor.focused) {
    return { objectId: anchorObjectId, state: anchor, replaced: false };
  }

  const focusedObjectId = await focusedEditableFromAnchor(cdp, tabId, anchorObjectId);
  if (!focusedObjectId) {
    return rpcError(
      "cdp_failed",
      "input_not_applied",
      "the target editable lost focus or detached before input",
      { phase: "resolve_live_editable" },
    );
  }
  const focused = await inspectEditable(cdp, tabId, focusedObjectId);
  if (!focused.supported || !focused.connected || !focused.focused) {
    return rpcError(
      "cdp_failed",
      "input_not_applied",
      "the replacement editable was not live and focused",
      { phase: "resolve_live_editable" },
    );
  }
  return { objectId: focusedObjectId, state: focused, replaced: true };
}

async function selectEditableContents(
  cdp: CdpRunner,
  tabId: number,
  objectId: string,
): Promise<void> {
  const reply = await cdp.send<{
    result?: { value?: { selected?: boolean } };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      /* bsk-editable-selection */
      if (!this.isConnected || this.ownerDocument?.activeElement !== this) {
        return { selected: false };
      }
      if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
        try {
          this.setSelectionRange(0, this.value.length);
        } catch {
          if (typeof this.select !== 'function') return { selected: false };
          this.select();
        }
        return { selected: true };
      }
      if (this.isContentEditable) {
        const selection = this.ownerDocument.getSelection();
        if (!selection) return { selected: false };
        const range = this.ownerDocument.createRange();
        range.selectNodeContents(this);
        selection.removeAllRanges();
        selection.addRange(range);
        return { selected: true };
      }
      return { selected: false };
    }`,
    returnByValue: true,
  });
  if (reply.result?.value?.selected !== true) {
    throw new Error("could not select the live editable contents");
  }
}

async function waitForEditableSettlement(
  cdp: CdpRunner,
  tabId: number,
  anchorObjectId: string,
): Promise<void> {
  await cdp.send(tabId, "Runtime.callFunctionOn", {
    objectId: anchorObjectId,
    functionDeclaration: `function() {
      /* bsk-editable-sync */
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 100);
        const view = this.ownerDocument?.defaultView;
        if (!view || typeof view.requestAnimationFrame !== 'function') { finish(); return; }
        view.requestAnimationFrame(() => view.requestAnimationFrame(finish));
      });
    }`,
    awaitPromise: true,
    returnByValue: true,
  });
}

async function deleteSelection(cdp: CdpRunner, tabId: number): Promise<void> {
  await cdp.send(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  await cdp.send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
}

/**
 * Replace or append text through Chromium's editing pipeline. No value setter
 * or synthetic DOM events are used: controlled components observe the same
 * beforeinput/input path as a real browser edit. The live editable is resolved
 * again after settlement so a framework may remount it without producing a
 * false failure or a stale-object success.
 */
export async function fillEditable(
  cdp: CdpRunner,
  tabId: number,
  anchorObjectId: string,
  value: string,
  clearBefore: boolean,
  signal?: AbortSignal,
): Promise<EditableFillResult | RpcError> {
  try {
    const abortedBefore = cancelled(signal);
    if (abortedBefore) return abortedBefore;

    const initial = await resolveLiveEditable(cdp, tabId, anchorObjectId);
    if ("code" in initial) return initial;
    let replacedNode = initial.replaced;

    if (clearBefore) await selectEditableContents(cdp, tabId, initial.objectId);
    const abortedAfterSelection = cancelled(signal);
    if (abortedAfterSelection) return abortedAfterSelection;

    if (value.length > 0) {
      await cdp.send(tabId, "Input.insertText", { text: value });
    } else if (clearBefore) {
      await deleteSelection(cdp, tabId);
    }

    const abortedAfterInput = cancelled(signal);
    if (abortedAfterInput) return abortedAfterInput;
    await waitForEditableSettlement(cdp, tabId, initial.objectId);

    const abortedAfterSettlement = cancelled(signal);
    if (abortedAfterSettlement) return abortedAfterSettlement;

    let finalObjectId = initial.objectId;
    let finalState = await inspectEditable(cdp, tabId, finalObjectId);
    if (!finalState.connected || !finalState.focused) {
      const live = await resolveLiveEditable(cdp, tabId, initial.objectId);
      if ("code" in live) return live;
      finalObjectId = live.objectId;
      finalState = live.state;
      replacedNode ||= live.replaced || finalObjectId !== initial.objectId;
    }

    const applied = clearBefore
      ? finalState.value === value
      : value.length === 0 || finalState.value.includes(value);
    if (!finalState.supported || !applied) {
      return rpcError(
        "cdp_failed",
        "input_not_applied",
        "the page did not retain the requested input value",
        {
          expected_value_length: value.length,
          actual_value_length: finalState.value.length,
          phase: "readback",
          editable_replaced: replacedNode,
        },
      );
    }

    return { value: finalState.value, replacedNode };
  } catch (err) {
    return rpcError(
      "cdp_failed",
      "input_not_applied",
      err instanceof Error ? err.message : String(err),
      { phase: "edit_transaction" },
    );
  }
}
