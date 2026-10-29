import { HarnessError } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition, ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";

const STEP_NEEDS_ATTENTION = "BSK_STEP_NEEDS_ATTENTION";

/** Keep validated CLI evidence until the host has settled cancellation and policy. */
export function createStepReceiptHandler() {
  // Public action dispatch clones exec, so use the SDK's immutable execution token.
  // The SDK calls finalizeContent exactly once for every outcome, including errors;
  // each entry is deleted there and only in-flight executions retain a receipt.
  const receipts = new Map<ToolExecution["token"], string>();
  return {
    complete(exec: ToolRunContext, receipt: unknown): unknown {
      const value = receipt as { ok: boolean; cancelled?: boolean };
      // A direct invocation outside ToolRuntime has no SDK token or finalizer.
      if (typeof exec.token === "symbol") receipts.set(exec.token, JSON.stringify(receipt));
      if (value.ok === false) {
        const cancelled = value.cancelled === true || exec.signal.aborted;
        throw new HarnessError(
          `Browser step ${cancelled ? "was cancelled" : "needs attention"}. ` +
            "The action may already have completed; inspect the step receipt before continuing. " +
            "Do not replay the action automatically.",
          cancelled ? "ABORTED" : STEP_NEEDS_ATTENTION,
        );
      }
      return receipt;
    },
    finalizeContent: ((exec, result) => {
      const receipt = receipts.get(exec.token);
      receipts.delete(exec.token);
      if (receipt === undefined || !result.isError) return undefined;
      const code = result.error.info?.code;
      // Preserve explicit host policy blocks and unrelated failures. Restoring
      // evidence must not undo a policy decision to suppress tool output.
      if (code !== "ABORTED" && code !== STEP_NEEDS_ATTENTION) return undefined;
      return [...result.content, { type: "text", text: receipt }];
    }) satisfies NonNullable<ToolDefinition["finalizeContent"]>,
  };
}
