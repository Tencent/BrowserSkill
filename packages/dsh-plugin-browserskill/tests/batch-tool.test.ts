import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerBatchTools } from "../src/batch-tool";
import type { PhaseOneRuntime } from "../src/phase-one-runtime";
import { BskError, parseBskJson } from "../src/runner";
import type { ToolDeps } from "../src/tools";

function fixture(run: PhaseOneRuntime["run"]) {
  const definitions = new Map<string, ToolDefinition>();
  const deps = {
    registry: { resolve: vi.fn(() => "owned-session"), assertUsable: vi.fn() },
    config: { defaultTimeoutMs: 120_000 },
  } as unknown as ToolDeps;
  const runtime = {
    run,
    commandLine: () => "bsk",
    presentTerminalResult: () => undefined,
  } as PhaseOneRuntime;
  registerBatchTools(deps, (definition) => definitions.set(definition.name, definition), runtime);
  const exec = { signal: new AbortController().signal } as ToolRunContext;
  return { definitions, deps, exec };
}

describe("batch agent interface", () => {
  it("sends one private plan, retains partial results, and gives single-action recovery instructions", async () => {
    let file = "";
    const receipt = {
      request_id: "r1",
      status: "stopped",
      steps: [
        { index: 0, action: "fill", status: "completed", effect_state: "committed" },
        { index: 1, action: "click", status: "not_run", effect_state: "none" },
      ],
      observation: { text: "new page refs", observation_id: "new" },
    };
    const run = vi.fn(async (_exec, args: string[]) => {
      file = args[args.indexOf("--file") + 1];
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        observation_id: "old",
        steps: [
          { action: "fill", target: "@e1", value: "private input", clear_before: false },
          { action: "click", target: "@e2" },
        ],
      });
      expect(args.join(" ")).not.toContain("private input");
      throw new BskError("batch stopped", { data: { batch: receipt } });
    });
    const f = fixture(run);
    const result = await f.definitions.get("interact.batch")!.execute(
      {
        observationId: "old",
        requestId: "r1",
        steps: [
          { action: "fill", target: "@e1", value: "private input", noClear: true },
          { action: "click", target: "@e2" },
        ],
      },
      f.exec,
    );
    expect(result).toMatchObject(receipt);
    expect(JSON.stringify(result)).toContain("single actions");
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
  });

  it("does not attempt batches on observations from older extensions", async () => {
    const run = vi.fn();
    const f = fixture(run);
    const result = await f.definitions
      .get("interact.batch")!
      .execute({ steps: [{ action: "click", target: "@e1" }] }, f.exec);
    expect(result).toMatchObject({ status: "not_started" });
    expect(JSON.stringify(result)).toContain("single actions");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a request id after transport failure and never retries the batch", async () => {
    const run = vi.fn().mockRejectedValue(new BskError("transport disconnected"));
    const f = fixture(run);
    const result = await f.definitions
      .get("interact.batch")!
      .execute(
        { observationId: "o1", requestId: "r1", steps: [{ action: "click", target: "@e1" }] },
        f.exec,
      );
    expect(result).toMatchObject({ status: "unconfirmed", request_id: "r1" });
    expect(JSON.stringify(result)).toContain("batch-status");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("queries status without joining the foreground action queue", async () => {
    const run = vi.fn().mockResolvedValue({ status: "running", steps: [] });
    const f = fixture(run);
    await f.definitions.get("interact.batch-status")!.execute({ requestId: "r1" }, f.exec);
    expect(run).toHaveBeenCalledWith(
      f.exec,
      ["batch-status", "--session", "owned-session", "--request-id", "r1"],
      "batch-status",
    );
    expect(f.deps.registry.assertUsable).toHaveBeenCalled();
  });

  it("the CLI parser retains structured recovery evidence on a nonzero exit", () => {
    const receipt = { status: "stopped", steps: [{ index: 0, status: "completed" }] };
    try {
      parseBskJson(
        {
          code: 1,
          stdout: JSON.stringify({
            code: "not_found",
            message: "stopped",
            data: { batch: receipt },
          }),
          stderr: "",
          aborted: false,
          timedOut: false,
        },
        "batch",
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BskError);
      expect((error as BskError).data).toEqual({ batch: receipt });
    }
  });
});
