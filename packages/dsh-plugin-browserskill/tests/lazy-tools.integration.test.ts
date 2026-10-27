import { Context } from "@deepseek-ai/cordis";
import { createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/index";
import { armLazyTools } from "../src/lazy-tools";
import { memoryStartJournal } from "../src/start-journal";
import toolNames from "../src/tool-names.json";

describe("lazy tools with the DSH session lifecycle", () => {
  it("retries a failed reveal on a real turn boundary instead of each session event", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const session = sessions.ctx.sessions.create(SessionId("registration-retry"));
    const warning = vi.fn();
    root.logger.exporter({ export: warning });
    const registerSuite = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("registration unavailable");
      })
      .mockReturnValue(() => {});
    const mounted = root.plugin((ctx) => {
      const disarm = armLazyTools(ctx, registerSuite);
      ctx.effect(() => disarm);
    });
    await mounted;
    try {
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "skill instructions" }],
          source: { kind: "skill-invocation", name: "browser-skill", form: "instructions" },
        }),
        { surfaceOp: "append" },
      );
      for (let i = 0; i < 20_000; i++) {
        session.append("step/end", { turn: 0, step: i });
      }
      expect(registerSuite).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
      session.append("turn/start", { turn: 1 });
      expect(registerSuite).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.dispose();
      await sessions.dispose();
    }
  });

  it("restores a successful model invocation after a real Cordis plugin unload/reload", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const session = sessions.ctx.sessions.create(SessionId("reload"));
    let registered = false;
    const registerSuite = vi.fn(() => {
      registered = true;
      return () => {
        registered = false;
      };
    });
    const plugin = (ctx: Context) => {
      const disarm = armLazyTools(ctx, registerSuite);
      ctx.effect(() => disarm);
    };
    let mounted = root.plugin(plugin);
    await mounted;
    try {
      expect(registered).toBe(false);
      session.append("tool/call", {
        turn: 0,
        step: 0,
        callId: ToolCallId("skill"),
        name: "skill",
        arguments: '{"name":"browser-skill"}',
      });
      session.append(
        "tool/result",
        {
          turn: 0,
          step: 0,
          message: createToolResultMessage({
            callId: ToolCallId("skill"),
            isError: false,
            content: [],
          }),
        },
        { surfaceOp: "append" },
      );
      expect(registered).toBe(true);
      await mounted.dispose();
      expect(registered).toBe(false);

      const readHistory = vi.spyOn(session, "snapshotEvents");
      mounted = root.plugin(plugin);
      await mounted;
      expect(registered).toBe(true);
      expect(registerSuite).toHaveBeenCalledTimes(2);
      expect(readHistory).toHaveBeenCalledTimes(1);
      // The restarted plugin needs no second skill call or new event to restore.
      expect(session.snapshotEvents().filter((event) => event.type === "tool/call")).toHaveLength(
        1,
      );
      readHistory.mockRestore();
    } finally {
      await mounted.dispose();
      await sessions.dispose();
    }
  });

  it("restores a missed session through the real append feed", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const session = sessions.ctx.sessions.create(SessionId("missed"));
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "skill instructions" }],
        source: { kind: "skill-invocation", name: "browser-skill", form: "instructions" },
      }),
      { surfaceOp: "append" },
    );
    const registerSuite = vi.fn(() => () => {});
    // Suppress only startup discovery; publication still uses real Cordis events.
    const disarm = armLazyTools(
      {
        get: () => undefined,
        on: root.on.bind(root),
        inject: () => ({ dispose() {} }),
      } as unknown as Context,
      registerSuite,
    );
    try {
      expect(registerSuite).not.toHaveBeenCalled();
      session.append("step/start", { turn: 0, step: 0 });
      expect(registerSuite).toHaveBeenCalledTimes(1);
    } finally {
      disarm();
      await sessions.dispose();
    }
  });

  it("watches a sessions service that is mounted after the browser plugin", async () => {
    const root = new Context();
    const registerSuite = vi.fn(() => () => {});
    const mounted = root.plugin((ctx) => {
      const disarm = armLazyTools(ctx, registerSuite);
      ctx.effect(() => disarm);
    });
    await mounted;
    const sessions = root.plugin(SessionStore);
    await sessions;
    try {
      const session = sessions.ctx.sessions.create(SessionId("late"));
      session.append("tool/call", {
        turn: 0,
        step: 0,
        callId: ToolCallId("c"),
        name: "skill",
        arguments: '{"name":"browser-skill"}',
      });
      session.append(
        "tool/result",
        {
          turn: 0,
          step: 0,
          message: createToolResultMessage({
            callId: ToolCallId("c"),
            isError: false,
            content: [],
          }),
        },
        { surfaceOp: "append" },
      );
      expect(registerSuite).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.dispose();
      await sessions.dispose();
    }
  });
});

describe("lazy activation through the DSH execution pipeline", () => {
  it.each([
    "before",
    "after",
  ])("keeps foreign tools loaded %s and materializes activation failures", async (order) => {
    const root = new Context();
    // Only prompt assembly is absent in this headless composition. Registry,
    // validation, middleware, result materialization, and disposal are real DSH.
    root.provide("systemPrompt", { tools: () => () => {} });
    const runtime = root.plugin(ToolRuntime);
    await runtime;
    const tool = (name: string) =>
      defineTool({
        name,
        description: "Execution pipeline fixture",
        parameters: { name: { type: "string" } },
        output: {
          schema: { type: "json" },
          render: () => [{ type: "text", text: "instructions" }],
        },
        execute: async () => ({ source: name }),
      });
    root.tools.register(tool("skill"));
    const occupied = root.tools.register(tool(toolNames.tabs));
    const foreign = tool("browser_session");
    if (order === "before") root.tools.register(foreign);
    const plugin = root.plugin({
      name: "browser-activation-test",
      inject: ["tools"],
      apply(ctx) {
        apply(
          ctx,
          { observationEnabled: false },
          {
            runnerFactory: () => ({
              run: async () => ({
                code: 0,
                stdout: "{}",
                stderr: "",
                timedOut: false,
                aborted: false,
              }),
              killAll() {},
              killFor: () => 0,
            }),
            startJournal: memoryStartJournal(),
          },
        );
      },
    });
    await plugin;
    if (order === "after") root.tools.register(foreign);
    let call = 0;
    const invoke = (name: string, args: Record<string, unknown>) =>
      root.tools.execute({
        callId: ToolCallId(`pipeline-${++call}`),
        name,
        arguments: args,
        signal: new AbortController().signal,
      });
    const active = () =>
      Object.values(toolNames).filter((name) => root.tools.get(name) !== undefined);
    try {
      const failed = await invoke("skill", { name: "browser-skill" });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain("Failed to register bsk_tabs");
      expect(active()).toEqual([toolNames.tabs]);
      expect(root.tools.get("browser_session")).toBe(foreign);
      occupied();
      expect((await invoke("skill", { name: "browser-skill" })).isError).toBe(false);
      expect(active()).toEqual(Object.values(toolNames));
      expect((await invoke(toolNames.session, { action: "list" })).isError).toBe(false);
      expect(await invoke("browser_session", {})).toMatchObject({
        isError: false,
        value: { source: "browser_session" },
      });
      await plugin.dispose();
      expect(active()).toEqual([]);
      expect(root.tools.get("browser_session")).toBe(foreign);
    } finally {
      await plugin.dispose();
      occupied();
      await runtime.dispose();
    }
  });
});
