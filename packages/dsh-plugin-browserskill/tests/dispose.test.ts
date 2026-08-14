// Unload-cleanup ownership discipline: dispose must stop exactly the sessions
// this plugin created — never referenced/foreign sessions on the shared
// daemon — and a stale handle (already stopped elsewhere, daemon restarted)
// must not abort the remaining stops.

import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { apply } from "../src/index";
import type { BskRunOptions, BskRunResult } from "../src/runner";

interface FakeCall {
  args: string[];
}

function ok(payload: unknown): BskRunResult {
  return { code: 0, stdout: JSON.stringify(payload), stderr: "", timedOut: false, aborted: false };
}

function fail(message: string): BskRunResult {
  return {
    code: 4,
    stdout: JSON.stringify({ code: "session_not_found", message }),
    stderr: "",
    timedOut: false,
    aborted: false,
  };
}

function makeExec(): ToolRunContext {
  return {
    callId: "t",
    name: "t",
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

describe("dispose cleanup ownership", () => {
  it("stops only plugin-owned sessions and tolerates stale handles", async () => {
    const calls: FakeCall[] = [];
    const startReplies = [
      { session_id: "own1", browser_instance_id: "b1" },
      { session_id: "own2", browser_instance_id: "b1" },
    ];
    const runner = {
      async run(args: string[], _options: BskRunOptions = {}): Promise<BskRunResult> {
        calls.push({ args });
        const joined = args.join(" ");
        if (joined.startsWith("status")) return ok({});
        if (joined.startsWith("session start")) return ok(startReplies.shift());
        if (joined.startsWith("snapshot")) {
          return ok({ text: "x", ref_count: 1, tab_id: 7, truncated: false });
        }
        if (joined === "session stop own1") return ok({});
        if (joined === "session stop own2") {
          // Stale handle: already stopped by someone else / daemon restarted.
          return fail("session not found");
        }
        return fail(`unexpected command: ${joined}`);
      },
      killAll() {},
    };
    const tools = new Map<string, ToolDefinition>();
    const disposers: Array<() => Promise<void>> = [];
    const ctx = {
      tools: { register: (def: ToolDefinition) => tools.set(def.name, def) },
      get: () => undefined,
      effect: (fn: () => () => Promise<void>) => {
        disposers.push(fn());
      },
    };
    apply(ctx as never, { maxSessions: 5 }, { runnerFactory: () => runner });

    const start = tools.get("browser_session_start");
    const snapshot = tools.get("browser_snapshot");
    if (start === undefined || snapshot === undefined) throw new Error("tools not registered");
    await start.execute({}, makeExec());
    await start.execute({}, makeExec());
    // A foreign session gets referenced (current-pointer bookkeeping) but never owned.
    await snapshot.execute({ session: "ext9" }, makeExec());

    await Promise.all(disposers.map((dispose) => dispose()));

    const stops = calls
      .map((call) => call.args.join(" "))
      .filter((joined) => joined.startsWith("session stop"));
    expect(stops.sort()).toEqual(["session stop own1", "session stop own2"]);
    expect(stops.some((joined) => joined.includes("ext9"))).toBe(false);
  });
});
