import { Context } from "@deepseek-ai/cordis";
import { CallId, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";
import { armLazyTools } from "../src/lazy-tools";

describe("lazy tools with the DSH session lifecycle", () => {
  it("retries a failed reveal on a real turn boundary instead of each streamed chunk", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const session = sessions.ctx.sessions.create(SessionId("registration-retry"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        session.append("assistant/chunk", {
          turn: 0,
          step: 0,
          chunk: { type: "text-delta", index: 0, text: "x" },
        });
      }
      expect(registerSuite).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
      session.append("turn/start", { turn: 1 });
      expect(registerSuite).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.dispose();
      await sessions.dispose();
      warning.mockRestore();
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
        callId: CallId("skill"),
        name: "skill",
        arguments: '{"name":"browser-skill"}',
      });
      session.append(
        "tool/result",
        {
          turn: 0,
          step: 0,
          message: createToolResultMessage({
            callId: CallId("skill"),
            isError: false,
            content: [],
          }),
        },
        { surfaceOp: "append" },
      );
      // DSH also emits the live tool result; the reloaded plugin must recover
      // without receiving that notification a second time.
      root.emit(
        "tools/result",
        { name: "skill", arguments: { name: "browser-skill" } } as never,
        { isError: false } as never,
      );
      expect(registered).toBe(true);
      await mounted.dispose();
      expect(registered).toBe(false);

      const readHistory = vi.spyOn(session, "events", "get");
      mounted = root.plugin(plugin);
      await mounted;
      expect(registered).toBe(true);
      expect(registerSuite).toHaveBeenCalledTimes(2);
      expect(readHistory).toHaveBeenCalledTimes(1);
      // The restarted plugin needs no second skill call or new event to restore.
      expect(session.events.filter((event) => event.type === "tool/call")).toHaveLength(1);
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
      session.append("assistant/chunk", {
        turn: 0,
        step: 0,
        chunk: { type: "text-delta", index: 0, text: "x" },
      });
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
        callId: CallId("c"),
        name: "skill",
        arguments: '{"name":"browser-skill"}',
      });
      session.append(
        "tool/result",
        {
          turn: 0,
          step: 0,
          message: createToolResultMessage({ callId: CallId("c"), isError: false, content: [] }),
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
