import type { CdpRunner } from "../shared";
import { isAbortError, throwIfAborted } from "./capture-abort";
import type { CapturedNode } from "./capture-types";

interface RuntimeEvaluateReply {
  result?: { deepSerializedValue?: DeepSerializedValue };
}
const MAX_FORM_ENRICH_CONTROLS = 250;

interface CapturedFormState {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  state?: "empty" | "filled" | "default";
  sensitive?: boolean;
}

interface DeepSerializedValue {
  type: string;
  value?: unknown;
}

function formStateBatchExpression(maxControls: number): string {
  return `(() => {
    const maxControls = ${JSON.stringify(maxControls)};
    let remaining = maxControls;
    const controlSelector = "input,textarea,select";
    const controlState = (el) => {
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? String(el.type || "text").toLowerCase() : tag;
      const sensitive = type === "password" || type === "credit-card";
      const rawValue = typeof el.value === "string" ? el.value : "";
      const defaultValue = typeof el.defaultValue === "string" ? el.defaultValue : "";
      const placeholder = typeof el.placeholder === "string" ? el.placeholder : "";
      const state = rawValue === "" ? "empty" : rawValue === defaultValue ? "default" : "filled";
      return {
        state,
        sensitive,
        placeholder,
        ...(sensitive ? {} : { value: rawValue, defaultValue }),
      };
    };
    const controls = [];
    const collect = (doc) => {
      for (const el of Array.from(doc.querySelectorAll(controlSelector))) {
        if (remaining <= 0) break;
        // Deep serialization supplies the node's backend id. Keep the
        // state as JSON so decoding needs no general-purpose V8 deserializer.
        controls.push([el, JSON.stringify(controlState(el))]);
        remaining -= 1;
      }
      for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
        if (remaining <= 0) break;
        let childDoc = null;
        try { childDoc = frame.contentDocument; } catch { childDoc = null; }
        if (childDoc) collect(childDoc);
      }
    };
    collect(document);
    return controls;
  })()`;
}

function formStatesByBackendId(result: RuntimeEvaluateReply): Map<number, CapturedFormState> {
  const states = new Map<number, CapturedFormState>();
  const serialized = result.result?.deepSerializedValue;
  if (serialized?.type !== "array" || !Array.isArray(serialized.value)) return states;
  for (const entry of serialized.value as DeepSerializedValue[]) {
    if (entry?.type !== "array" || !Array.isArray(entry.value)) continue;
    const [element, json] = entry.value as DeepSerializedValue[];
    if (element?.type !== "node" || json?.type !== "string" || typeof json.value !== "string") {
      continue;
    }
    const backendNodeId = (element.value as { backendNodeId?: number } | undefined)?.backendNodeId;
    if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId)) continue;
    try {
      const state = JSON.parse(json.value) as CapturedFormState | null;
      if (
        !state ||
        !["empty", "filled", "default"].includes(state.state ?? "") ||
        typeof state.sensitive !== "boolean" ||
        typeof state.placeholder !== "string" ||
        (!state.sensitive &&
          (typeof state.value !== "string" || typeof state.defaultValue !== "string"))
      ) {
        continue;
      }
      states.set(backendNodeId, state);
    } catch {
      // A malformed entry must not overwrite the snapshot's own state.
    }
  }
  return states;
}

function applyFormStates(nodes: CapturedNode[], states: Map<number, CapturedFormState>): void {
  for (const node of nodes) {
    if (!["input", "textarea", "select"].includes(node.tag)) continue;
    const state = states.get(node.backendNodeId);
    if (!state) continue;
    node.formState = state.state;
    node.formPlaceholder = state.placeholder ?? "";
    if (
      state.sensitive ||
      (node.tag === "input" && (node.attrs.type ?? "").toLowerCase() === "password")
    ) {
      delete node.formValue;
      delete node.formDefaultValue;
      delete node.attrs.value;
    } else {
      node.formDefaultValue = state.defaultValue ?? "";
      if (state.value !== undefined) node.formValue = state.value;
    }
  }
}

export async function enrichFormControlStates(
  cdp: CdpRunner,
  tabId: number,
  frameNodeGroups: CapturedNode[][],
  signal?: AbortSignal,
): Promise<boolean> {
  const hasControls = frameNodeGroups.some((nodes) =>
    nodes.some((node) => ["input", "textarea", "select"].includes(node.tag)),
  );
  if (!hasControls) return true;
  const objectGroup = `bsk-vom-forms-${crypto.randomUUID()}`;
  try {
    throwIfAborted(signal);
    const result = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
      expression: formStateBatchExpression(MAX_FORM_ENRICH_CONTROLS),
      objectGroup,
      serializationOptions: {
        serialization: "deep",
        maxDepth: 3,
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
      },
    });
    throwIfAborted(signal);
    // Backend ids are scoped to this capture's CDP target. OOPIF targets
    // have separate enrichment calls and never share this lookup.
    const states = formStatesByBackendId(result);
    for (const nodes of frameNodeGroups) {
      applyFormStates(nodes, states);
    }
    return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Best-effort enrichment. DOMSnapshot/AX data still carries the nodes.
    return false;
  } finally {
    await cdp.send(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    throwIfAborted(signal);
  }
}
