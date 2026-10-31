import type { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStepRuntime,
  STEP_CANCELLED,
  STEP_PARTIAL,
  STEP_SUCCESS,
  stepReply,
} from "./helpers/step-runtime";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});

async function host(...args: Parameters<typeof createStepRuntime>) {
  const runtime = await createStepRuntime(...args);
  cleanups.push(runtime.dispose);
  return runtime;
}

function receiptOf(result: ToolExecutionResult) {
  const block = result.content.at(-1);
  return block?.type === "text" ? JSON.parse(block.text) : undefined;
}

function contextReceipts(result: ToolExecutionResult) {
  return (result.additionalContexts ?? []).map((context) => {
    const block = context.content.at(-1);
    return block?.type === "text" ? JSON.parse(block.text) : undefined;
  });
}

type CodeRunRequest = Parameters<Context["codeRuntime"]["run"]>[0];
type CodeRunResult = Awaited<ReturnType<Context["codeRuntime"]["run"]>>;
type PtcFunctions = CodeRunRequest["bindings"][number]["functions"];

/** Only the code-execution substrate is a fixture: it runs a known test program
 * and stops on abort. ToolRuntime, run_code's binding/scheduler/error projection,
 * context forwarding and both policy boundaries are the real SDK implementation. */
function installPtcSubstrate(
  root: Context,
  program: (tools: PtcFunctions) => Promise<CodeRunResult["value"]>,
) {
  root.provide("codeRuntime", {
    language: "typescript",
    isolation: "test",
    async run(request: CodeRunRequest): Promise<CodeRunResult> {
      const body = (async (): Promise<CodeRunResult> => {
        try {
          return { logs: [], value: await program(request.bindings[0].functions) };
        } catch (error) {
          return {
            logs: [],
            error: { kind: "exception", message: (error as Error).message },
          };
        }
      })();
      let onAbort: () => void = () => {};
      const aborted = new Promise<CodeRunResult>((resolve) => {
        onAbort = () =>
          resolve({ logs: [], error: { kind: "abort", message: "test program interrupted" } });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) onAbort();
      });
      try {
        return await Promise.race([body, aborted]);
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  } as Context["codeRuntime"]);
}

function runCode(root: Context, controller = new AbortController()) {
  return root.tools.execute({
    name: "run_code",
    callId: ToolCallId("ptc-step"),
    arguments: { code: "known test program", description: "Inspect one browser step" },
    signal: controller.signal,
  });
}

const PTC_STEP_ARGS = {
  action: "step",
  stepAction: "click",
  params: '{"ref":"e1"}',
  session: "s1",
};

describe("step receipts through the real run_code PTC bridge", () => {
  it("makes an ordinary failure receipt readable to the catching program and the next model turn", async () => {
    const run = vi.fn(async () => stepReply(STEP_PARTIAL, 1));
    const runtime = await host(run, "ptc");
    installPtcSubstrate(runtime.root, async (tools) => {
      try {
        return await tools.bsk_interact(PTC_STEP_ARGS);
      } catch (error) {
        return { caught: (error as Error).message };
      }
    });
    const result = await runCode(runtime.root);
    expect(result.isError).toBe(false);
    if (!result.isError)
      expect((result.value as { result: { caught: string } }).result.caught).toContain(
        JSON.stringify(STEP_PARTIAL),
      );
    expect(contextReceipts(result)).toEqual([STEP_PARTIAL]);
    expect(result.additionalContexts?.[0].source).toEqual({
      kind: "plugin:@wxg-prc-cpg/browser-skill-dsh-plugin",
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("preserves the receipt when an uncaught step failure makes run_code fail", async () => {
    const runtime = await host(async () => stepReply(STEP_PARTIAL, 1), "ptc");
    installPtcSubstrate(runtime.root, (tools) => tools.bsk_interact(PTC_STEP_ARGS));
    const result = await runCode(runtime.root);
    expect(result.isError).toBe(true);
    expect(result.error?.message).toContain(JSON.stringify(STEP_PARTIAL));
    expect(contextReceipts(result)).toEqual([STEP_PARTIAL]);
  });

  it("retains cancellation evidence after the program aborts and the bridge discards its return", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return stepReply(STEP_CANCELLED, 2, { aborted: true });
    });
    const runtime = await host(run, "ptc");
    installPtcSubstrate(runtime.root, (tools) => tools.bsk_interact(PTC_STEP_ARGS));
    const result = await runCode(runtime.root, controller);
    expect(result.isError).toBe(true);
    expect(contextReceipts(result)).toEqual([STEP_CANCELLED]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("retains successful action evidence if cancellation arrives at nested post-execute", async () => {
    const controller = new AbortController();
    const runtime = await host(async () => stepReply(STEP_SUCCESS, 0), "ptc");
    installPtcSubstrate(runtime.root, (tools) => tools.bsk_interact(PTC_STEP_ARGS));
    runtime.root.on("tools/post-execute", async (exec, _result, next) => {
      if (exec.name === "bsk_interact") controller.abort();
      return next();
    });
    const result = await runCode(runtime.root, controller);
    expect(result.isError).toBe(true);
    expect(contextReceipts(result)).toEqual([STEP_SUCCESS]);
  });

  it.each([
    "bsk_interact",
    "run_code",
  ])("does not carry a receipt past a %s policy block", async (blockedName) => {
    const runtime = await host(async () => stepReply(STEP_PARTIAL, 1), "ptc");
    installPtcSubstrate(runtime.root, (tools) => tools.bsk_interact(PTC_STEP_ARGS));
    runtime.root.on("tools/post-execute", async (exec, _result, next) =>
      exec.name === blockedName
        ? { kind: "block", feedback: [{ type: "text", text: "policy withheld output" }] }
        : next(),
    );
    const result = await runCode(runtime.root);
    expect(result.isError).toBe(true);
    expect(contextReceipts(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("action_replayed");
  });

  it("keeps sequential nested receipts in call order with their execution identities", async () => {
    let calls = 0;
    const runtime = await host(
      async () => stepReply({ ...STEP_PARTIAL, marker: ++calls }, 1),
      "ptc",
    );
    installPtcSubstrate(runtime.root, async (tools) => {
      for (let i = 0; i < 2; i++) {
        try {
          await tools.bsk_interact(PTC_STEP_ARGS);
        } catch {}
      }
      return "done";
    });
    const result = await runCode(runtime.root);
    expect(result.isError).toBe(false);
    expect(contextReceipts(result)).toEqual([
      { ...STEP_PARTIAL, marker: 1 },
      { ...STEP_PARTIAL, marker: 2 },
    ]);
    expect(JSON.stringify(result.additionalContexts?.[0])).toContain("ptc-step:ptc:1");
    expect(JSON.stringify(result.additionalContexts?.[1])).toContain("ptc-step:ptc:2");
    expect(calls).toBe(2);
  });
});

describe("step receipts in the real ToolRuntime", () => {
  it("marks partial failure as an error while keeping action, readiness and post evidence", async () => {
    const run = vi.fn(async () => stepReply(STEP_PARTIAL, 1));
    const runtime = await host(run);
    const result = await runtime.execute();
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: "BSK_STEP_NEEDS_ATTENTION" } },
    });
    expect(receiptOf(result)).toEqual(STEP_PARTIAL);
    expect(contextReceipts(result)).toEqual([]);
    expect(result).not.toHaveProperty("value");
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps a post failure after input was already executed", async () => {
    const { post: _post, ...withoutPost } = STEP_SUCCESS;
    const receipt = {
      ...withoutPost,
      ok: false,
      phase: "needs_attention",
      post_error: { code: "cdp_failed", message: "snapshot failed", exit_code: 3 },
    };
    const run = vi.fn(async () => stepReply(receipt, 3));
    const runtime = await host(run);
    const result = await runtime.execute();
    expect(result.isError).toBe(true);
    expect(receiptOf(result)).toEqual(receipt);
    expect(run).toHaveBeenCalledOnce();
  });

  it("preserves the acknowledged cancellation receipt through the SDK abort check", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return stepReply(STEP_CANCELLED, 2, { aborted: true });
    });
    const runtime = await host(run);
    const result = await runtime.execute(controller);
    expect(result).toMatchObject({ isError: true, error: { info: { code: "ABORTED" } } });
    expect(receiptOf(result)).toEqual(STEP_CANCELLED);
    expect(result).not.toHaveProperty("value");
    expect(run).toHaveBeenCalledOnce();
  });

  it("retains a completed receipt if cancellation arrives in host post-execute", async () => {
    const controller = new AbortController();
    const runtime = await host(async () => stepReply(STEP_SUCCESS, 0));
    runtime.root.on("tools/post-execute", async () => {
      controller.abort();
      return { kind: "accept" };
    });
    const result = await runtime.execute(controller);
    expect(result).toMatchObject({ isError: true, error: { info: { code: "ABORTED" } } });
    expect(receiptOf(result)).toEqual(STEP_SUCCESS);
  });

  it("retains a normal exit receipt when the signal aborts before the SDK sees the return", async () => {
    const controller = new AbortController();
    const runtime = await host(async () => {
      controller.abort();
      return stepReply(STEP_SUCCESS, 0);
    });
    const result = await runtime.execute(controller);
    expect(result).toMatchObject({ isError: true, error: { info: { code: "ABORTED" } } });
    expect(receiptOf(result)).toEqual(STEP_SUCCESS);
  });

  it("keeps ordinary success successful without duplicating the receipt", async () => {
    const runtime = await host(async () => stepReply(STEP_SUCCESS, 0));
    const result = await runtime.execute();
    expect(result).toMatchObject({ isError: false, value: STEP_SUCCESS });
    expect(result.content).toHaveLength(1);
    expect(receiptOf(result)).toEqual(STEP_SUCCESS);
    expect(contextReceipts(result)).toEqual([]);
  });

  it("does not invent a receipt for cancellation without complete output", async () => {
    const controller = new AbortController();
    const runtime = await host(async () => {
      controller.abort();
      return stepReply(undefined, 2, { stdout: "", aborted: true });
    });
    const result = await runtime.execute(controller);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result.content)).not.toContain("action_replayed");
  });

  it("does not restore content blocked by host post-policy", async () => {
    const runtime = await host(async () => stepReply(STEP_PARTIAL, 1));
    runtime.root.on("tools/post-execute", async () => ({
      kind: "block",
      feedback: [{ type: "text", text: "policy blocked this result" }],
    }));
    const result = await runtime.execute();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "policy blocked this result" }]);
  });

  it("does not restore content after an unrelated host failure", async () => {
    const runtime = await host(async () => stepReply(STEP_PARTIAL, 1));
    runtime.root.on("tools/post-execute", () => {
      throw new Error("host post-execute failed");
    });
    const result = await runtime.execute();
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result.content)).not.toContain("action_replayed");
  });

  it("isolates simultaneous calls even when they reuse a call ID", async () => {
    const runtime = await host(async (args) => {
      const session = args[args.indexOf("--session") + 1];
      await Promise.resolve();
      return stepReply({ ...STEP_PARTIAL, marker: session }, 1);
    });
    const [first, second] = await Promise.all([
      runtime.execute(undefined, { session: "s1" }, "same-call"),
      runtime.execute(undefined, { session: "s2" }, "same-call"),
    ]);
    expect(receiptOf(first)).toMatchObject({ marker: "s1" });
    expect(receiptOf(second)).toMatchObject({ marker: "s2" });
  });

  it("does not reuse a receipt for a subsequent rejected call", async () => {
    const runtime = await host(async () => stepReply(STEP_PARTIAL, 1));
    let completed: Readonly<ToolExecution> | undefined;
    runtime.root.on("tools/result", (exec) => {
      completed = exec;
    });
    const first = await runtime.execute(undefined, {}, "same-call");
    expect(receiptOf(first)).toEqual(STEP_PARTIAL);
    expect(completed).toBeDefined();
    // Even a second finalization of the same SDK token has no retained entry.
    expect(
      runtime.root.tools.get("bsk_interact")!.finalizeContent?.(completed!, first),
    ).toBeUndefined();
    const rejected = await runtime.execute(undefined, { action: "invalid" }, "same-call");
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).not.toContain("action_replayed");
  });
});
