import {
  type ExtensionToolMethod,
  methods,
  type ParamsOf,
  type ResultOf,
} from "./generated/methods";
import { normalizers } from "./generated/normalizers";
import * as validators from "./generated/validators.js";
import type { CancelParams, HandshakeResult, RequestFrame, RpcError } from "./types";

export type ToolRequest<M extends ExtensionToolMethod = ExtensionToolMethod> = {
  id: string;
  method: M;
  params: ParamsOf<M>;
};

export type ToolHandlerMap = {
  [M in ExtensionToolMethod]: (
    params: ParamsOf<M>,
    signal: AbortSignal,
    onInputSent?: (tabId: number) => void,
  ) => Promise<ResultOf<M> | RpcError>;
};

const extensionMethods = new Map(
  methods.filter((method) => method.owner === "extension").map((method) => [method.method, method]),
);

export function isExtensionToolMethod(method: string): method is ExtensionToolMethod {
  return extensionMethods.has(method as ExtensionToolMethod);
}

function describe(validator: validators.Validator): string {
  const issue = validator.errors?.[0];
  return issue
    ? `${issue.instancePath || "/"} ${issue.message ?? issue.keyword}`
    : "invalid payload";
}

export function validateCancelParams(value: unknown): value is CancelParams {
  return validators.wire_CancelParams(value);
}

export function decodeHandshakeResult(value: unknown): HandshakeResult {
  if (!validators.wire_HandshakeResponse(value)) {
    throw new Error(
      `[handshake] invalid daemon response: ${describe(validators.wire_HandshakeResponse)}`,
    );
  }
  const result = normalizers.HandshakeResponse(value);
  if (!validators.canonical_HandshakeResponse(result)) {
    throw new Error(
      `[handshake] invalid normalized response: ${describe(validators.canonical_HandshakeResponse)}`,
    );
  }
  return result as HandshakeResult;
}

export function decodeToolRequest(
  frame: RequestFrame,
): { ok: true; request: ToolRequest } | { ok: false; error: RpcError } {
  if (!isExtensionToolMethod(frame.method)) {
    return {
      ok: false,
      error: { code: "unknown_method", message: `${frame.method} not implemented in extension` },
    };
  }
  const definition = extensionMethods.get(frame.method)!;
  const wire = validators[`wire_${definition.params}`];
  if (!wire(frame.params)) {
    return {
      ok: false,
      error: { code: "invalid_params", message: `${frame.method}: ${describe(wire)}` },
    };
  }
  const params = normalizers[definition.params](frame.params);
  const canonical = validators[`canonical_${definition.params}`];
  if (!canonical(params)) {
    return {
      ok: false,
      error: { code: "invalid_params", message: `${frame.method}: ${describe(canonical)}` },
    };
  }
  // The only raw-JSON assertion in tool dispatch follows both wire validation
  // and normalization. Method and parameter schemas come from the same catalog.
  return { ok: true, request: { id: frame.id, method: frame.method, params } as ToolRequest };
}

export function validateToolResult(
  method: ExtensionToolMethod,
  result: unknown,
): RpcError | undefined {
  const definition = extensionMethods.get(method)!;
  const validator = validators[`canonical_${definition.result}`];
  if (validator(result)) return;
  return {
    code: "protocol_error",
    message: `${method} returned an invalid result: ${describe(validator)}`,
    data: { phase: "result_validation", effect_state: "unknown" },
  };
}
