// Lazy tool-schema injection: suite hidden before a successful skill
// invocation, revealed by the model trigger / user gesture / session history,
// idempotent on repeats, and torn down cleanly. Plus the apply-level
// lazyTools two-state wiring.

import { createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/index";
import { armLazyTools, hasSuccessfulSkillInvocation } from "../src/lazy-tools";
import type { BskRunResult } from "../src/runner";
import { memoryStartJournal } from "../src/start-journal";

function fakeEventCtx(sessions?: {
  list(): { events?: readonly unknown[]; snapshotEvents?(): readonly unknown[] }[];
}) {
  const listeners = new Map<string, (...args: never[]) => void>();
  let onSessionsReady: ((ctx: unknown) => void) | undefined;
  const ctx = {
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    get: (key: string) => (key === "sessions" ? sessions : undefined),
    inject: (_deps: string[], callback: (ctx: unknown) => void) => {
      onSessionsReady = callback;
      return {
        dispose: () => {
          onSessionsReady = undefined;
        },
      };
    },
  };
  return {
    ctx: ctx as never,
    listeners,
    provideSessions(value: NonNullable<typeof sessions>) {
      sessions = value;
      onSessionsReady?.(ctx);
    },
  };
}

const skillCall = (callId = "skill-1") => ({
  type: "tool/call",
  data: { callId, name: "skill", arguments: '{"name":"browser-skill"}' },
});
const skillResult = (isError = false, callId = "skill-1") => ({
  type: "tool/result",
  data: {
    message: createToolResultMessage({
      callId: callId as never,
      content: [{ type: "text", text: isError ? "skill unavailable" : "skill instructions" }],
      isError,
    }),
  },
});

function callListeners(
  listeners: Map<string, (...args: never[]) => void>,
  event: string,
  ...args: unknown[]
): void {
  (listeners.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
}

describe("armLazyTools", () => {
  it("keeps the suite hidden until a successful skill invocation reveals it", () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(registerSuite).not.toHaveBeenCalled();

    // wrong tool
    callListeners(listeners, "tools/result", { name: "bash", arguments: {} }, { isError: false });
    // wrong skill name
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: { name: "other-skill" } },
      { isError: false },
    );
    // failed invocation
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: true },
    );
    expect(registerSuite).not.toHaveBeenCalled();

    // the real trigger (arguments may arrive as a raw JSON string)
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: '{"name":"browser-skill"}' },
      { isError: false },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across repeated invocations", () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    for (let i = 0; i < 3; i++) {
      callListeners(
        listeners,
        "tools/result",
        { name: "skill", arguments: { name: "browser-skill" } },
        { isError: false },
      );
    }
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("reveals on a /browser-skill user gesture (skill-invocation message)", () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    callListeners(
      listeners,
      "session/event",
      { events: [] },
      {
        type: "user/message",
        data: { source: { kind: "skill-invocation", name: "browser-skill" } },
      },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("restores from session history: hit at boot, on session entry, and miss", () => {
    const hitEvents = [
      {
        type: "tool/call",
        data: { callId: "c1", name: "skill", arguments: '{"name":"browser-skill"}' },
      },
      { type: "tool/result", data: { message: { callId: "c1", isError: false } } },
    ];
    // boot-time live sessions are scanned
    const boot = fakeEventCtx({ list: () => [{ events: hitEvents }] });
    const bootRegister = vi.fn(() => () => {});
    armLazyTools(boot.ctx, bootRegister);
    expect(bootRegister).toHaveBeenCalledTimes(1);

    // a session entered later with the same proof
    const { ctx, listeners } = fakeEventCtx({ list: () => [] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    callListeners(listeners, "session/created", { events: hitEvents });
    expect(registerSuite).toHaveBeenCalledTimes(1);

    // miss: failed result proves nothing
    const miss = fakeEventCtx({
      list: () => [
        {
          events: [
            {
              type: "tool/call",
              data: { callId: "c1", name: "skill", arguments: '{"name":"browser-skill"}' },
            },
            { type: "tool/result", data: { message: { callId: "c1", isError: true } } },
          ],
        },
      ],
    });
    const missRegister = vi.fn(() => () => {});
    armLazyTools(miss.ctx, missRegister);
    expect(missRegister).not.toHaveBeenCalled();
  });

  it("re-arms from history on a later event when the boot scan could not see the session", () => {
    const hitEvents = [
      {
        type: "tool/call",
        data: { callId: "c1", name: "skill", arguments: '{"name":"browser-skill"}' },
      },
      { type: "tool/result", data: { message: { callId: "c1", isError: false } } },
    ];
    // After a plugin reload the sessions service may not be registered yet, so
    // ctx.get("sessions") yields nothing and the boot scan covers nothing; the
    // session already exists, so session/created never fires for it either.
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(registerSuite).not.toHaveBeenCalled();

    // An ordinary event carrying no invocation of its own still hands over the
    // session, whose durable history proves the skill already ran.
    callListeners(listeners, "session/event", { events: hitEvents }, { type: "message/append" });
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("does not reveal from an event whose session has no proof", () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    callListeners(
      listeners,
      "session/event",
      { events: [{ type: "message/append", data: {} }] },
      { type: "message/append" },
    );
    expect(registerSuite).not.toHaveBeenCalled();
  });

  it("stops scanning session history once the suite is revealed", () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: false },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);

    // The implementation catches read failures, so assert the getter call count.
    const readHistory = vi.fn(() => {
      throw new Error("session history must not be read after the reveal");
    });
    const exploding = {
      get events(): never {
        return readHistory();
      },
    };
    callListeners(listeners, "session/event", exploding, { type: "message/append" });
    callListeners(listeners, "session/created", exploding);
    expect(readHistory).not.toHaveBeenCalled();
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("disposes listeners and the revealed suite", () => {
    const { ctx, listeners } = fakeEventCtx();
    const suiteDispose = vi.fn();
    const disarm = armLazyTools(ctx, () => suiteDispose);
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: false },
    );
    disarm();
    disarm();
    expect(suiteDispose).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("restores current DSH history when a missed session later emits an ordinary event", () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    const session = { events: [skillCall(), skillResult()] };
    callListeners(listeners, "session/event", session, { type: "turn/start", data: {} });
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("restores as soon as a late sessions service becomes available", () => {
    const host = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    const disarm = armLazyTools(host.ctx, registerSuite);
    host.provideSessions({ list: () => [{ events: [skillCall(), skillResult()] }] });
    expect(registerSuite).toHaveBeenCalledTimes(1);
    disarm();
    host.provideSessions({ list: () => [{ events: [skillCall(), skillResult()] }] });
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("restores from the newer DSH snapshotEvents API", () => {
    const session = { snapshotEvents: vi.fn(() => [skillCall(), skillResult()]) };
    const { ctx } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(session.snapshotEvents).toHaveBeenCalledTimes(1);
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("consumes new events without taking another snapshot on newer DSH", () => {
    const session = { snapshotEvents: vi.fn(() => [skillCall()]) };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    for (let i = 0; i < 20_000; i++) {
      callListeners(listeners, "session/event", session, { type: "assistant/chunk" });
    }
    expect(registerSuite).not.toHaveBeenCalled();
    callListeners(listeners, "session/event", session, skillResult());
    expect(registerSuite).toHaveBeenCalledTimes(1);
    expect(session.snapshotEvents).toHaveBeenCalledTimes(1);
  });

  it("scans a long uninvoked session once and then consumes live call/results", () => {
    const session = Session.create(SessionId("streaming"));
    const readHistory = vi.spyOn(session, "snapshotEvents");
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    for (let i = 0; i < 20_000; i++) {
      const event = session.append("step/end", { turn: 0, step: i });
      callListeners(listeners, "session/event", session, event);
    }
    callListeners(listeners, "session/created", session);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(registerSuite).not.toHaveBeenCalled();

    callListeners(listeners, "session/event", session, skillCall());
    callListeners(listeners, "session/event", session, skillResult(true));
    // A failed call is settled; a later result alone cannot turn it into proof.
    callListeners(listeners, "session/event", session, skillResult());
    expect(registerSuite).not.toHaveBeenCalled();
    callListeners(listeners, "session/event", session, skillCall("retry"));
    callListeners(listeners, "session/event", session, skillResult(false, "retry"));
    expect(registerSuite).toHaveBeenCalledTimes(1);
    expect(readHistory).toHaveBeenCalledTimes(1);
    readHistory.mockRestore();
  });

  it("pairs a result arriving after the first scan with an earlier pending call", () => {
    const session = { events: [skillCall()] };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(registerSuite).not.toHaveBeenCalled();
    callListeners(listeners, "session/event", session, skillResult());
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("keeps call correlation local to each session object", () => {
    const first = { events: [skillCall()] };
    const second = { events: [] };
    const { ctx, listeners } = fakeEventCtx({ list: () => [first, second] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    callListeners(listeners, "session/event", second, skillResult());
    expect(registerSuite).not.toHaveBeenCalled();
    callListeners(listeners, "session/event", first, skillResult());
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("retries unreadable history without caching the failure as an empty scan", () => {
    const history = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("history not ready");
      })
      .mockReturnValue([skillCall(), skillResult()]);
    const session = {
      get events() {
        return history();
      },
    };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(registerSuite).not.toHaveBeenCalled();
    callListeners(listeners, "session/event", session, { type: "turn/start" });
    expect(history).toHaveBeenCalledTimes(2);
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("recovers after a startup registry failure", () => {
    const { ctx, listeners } = fakeEventCtx({
      list() {
        throw new Error("registry unavailable");
      },
    });
    const registerSuite = vi.fn(() => () => {});
    expect(() => armLazyTools(ctx, registerSuite)).not.toThrow();
    callListeners(
      listeners,
      "session/event",
      { events: [skillCall(), skillResult()] },
      { type: "turn/start" },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("retries registration on the next turn without re-reading successful history", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const history = vi.fn(() => [skillCall(), skillResult()]);
    const session = {
      get events() {
        return history();
      },
    };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("registration failed");
      })
      .mockReturnValue(() => {});
    try {
      armLazyTools(ctx, registerSuite);
      callListeners(listeners, "session/event", session, { type: "turn/start" });
      expect(registerSuite).toHaveBeenCalledTimes(2);
      expect(history).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    "startup",
    "service injection",
  ] as const)("attempts registration once per session batch discovered through %s", (trigger) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      snapshotEvents: vi.fn(() => (index === 3 ? [skillCall(), skillResult()] : [])),
    }));
    const registry = { list: vi.fn(() => sessions) };
    const host = fakeEventCtx(trigger === "startup" ? registry : undefined);
    let available = false;
    const suiteDispose = vi.fn();
    const registerSuite = vi.fn(() => {
      if (!available) throw new Error("registration unavailable");
      return suiteDispose;
    });
    const disarm = armLazyTools(host.ctx, registerSuite);
    try {
      if (trigger === "service injection") host.provideSessions(registry);
      expect(registerSuite).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
      for (const [index, session] of sessions.entries()) {
        expect(session.snapshotEvents).toHaveBeenCalledTimes(index <= 3 ? 1 : 0);
      }

      // Pending recovery is global: one later batch means one retry,
      // without enumerating or scanning the remaining sessions.
      host.provideSessions(registry);
      expect(registerSuite).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(registry.list).toHaveBeenCalledTimes(1);

      // The successful invocation proof survives repeated failures even
      // when the next discovery no longer lists the original session.
      available = true;
      const emptyRegistry = { list: vi.fn(() => []) };
      host.provideSessions(emptyRegistry);
      expect(registerSuite).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(emptyRegistry.list).not.toHaveBeenCalled();
      host.provideSessions(registry);
      expect(registerSuite).toHaveBeenCalledTimes(3);
      for (const [index, session] of sessions.entries()) {
        expect(session.snapshotEvents).toHaveBeenCalledTimes(index <= 3 ? 1 : 0);
      }
    } finally {
      disarm();
      warning.mockRestore();
    }
    expect(suiteDispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    "history",
    "tool result",
    "gesture",
  ] as const)("defers failed registration from %s during streaming and recovers on the next turn", (trigger) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const history = vi.fn(() => (trigger === "history" ? [skillCall(), skillResult()] : []));
    const session = {
      get events() {
        return history();
      },
    };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    let available = false;
    const registerSuite = vi.fn(() => {
      if (!available) throw new Error("registration unavailable");
      return () => {};
    });
    const disarm = armLazyTools(ctx, registerSuite);
    try {
      if (trigger === "tool result") {
        callListeners(
          listeners,
          "tools/result",
          { name: "skill", arguments: { name: "browser-skill" } },
          { isError: false },
        );
      } else if (trigger === "gesture") {
        callListeners(listeners, "session/event", session, {
          type: "user/message",
          data: { source: { kind: "skill-invocation", name: "browser-skill" } },
        });
      }
      expect(registerSuite).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 20_000; i++) {
        callListeners(listeners, "session/event", session, { type: "assistant/chunk" });
      }
      expect(registerSuite).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledTimes(1);

      // A live result/gesture may not be in the first snapshot. Keep its
      // successful invocation proof, without retrying registration per token.
      available = true;
      callListeners(listeners, "session/event", session, { type: "turn/start" });
      expect(registerSuite).toHaveBeenCalledTimes(2);
      callListeners(listeners, "session/event", session, { type: "assistant/chunk" });
      expect(registerSuite).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledTimes(1);
    } finally {
      disarm();
      warning.mockRestore();
    }
  });
});

describe("hasSuccessfulSkillInvocation", () => {
  it("recognizes official DSH result messages and requires successful matching calls", () => {
    expect(hasSuccessfulSkillInvocation([skillCall(), skillResult()])).toBe(true);
    expect(hasSuccessfulSkillInvocation([skillCall(), skillResult(true)])).toBe(false);
    expect(hasSuccessfulSkillInvocation([skillCall(), skillResult(false, "other")])).toBe(false);
    expect(hasSuccessfulSkillInvocation([skillResult(), skillCall()])).toBe(false);
    expect(hasSuccessfulSkillInvocation([skillResult()])).toBe(false);
  });

  it("rejects missing identities and inconsistent modern result blocks", () => {
    expect(
      hasSuccessfulSkillInvocation([
        { type: "tool/call", data: { name: "skill", arguments: { name: "browser-skill" } } },
        { type: "tool/result", data: { message: { isError: false } } },
      ]),
    ).toBe(false);
    const message = structuredClone(skillResult().data.message);
    message.content[0].toolCallId = "different" as never;
    expect(
      hasSuccessfulSkillInvocation([skillCall(), { type: "tool/result", data: { message } }]),
    ).toBe(false);
  });

  it("pairs call and result by callId and honors gestures", () => {
    expect(hasSuccessfulSkillInvocation([])).toBe(false);
    expect(
      hasSuccessfulSkillInvocation([
        {
          type: "tool/call",
          data: { callId: "x", name: "skill", arguments: { name: "browser-skill" } },
        },
        { type: "tool/result", data: { message: { callId: "x", isError: false } } },
      ]),
    ).toBe(true);
    // result for an unrelated call id does not count
    expect(
      hasSuccessfulSkillInvocation([
        {
          type: "tool/call",
          data: { callId: "x", name: "skill", arguments: { name: "browser-skill" } },
        },
        { type: "tool/result", data: { message: { callId: "y", isError: false } } },
      ]),
    ).toBe(false);
    expect(
      hasSuccessfulSkillInvocation([
        {
          type: "user/message",
          data: { source: { kind: "skill-invocation", name: "browser-skill" } },
        },
      ]),
    ).toBe(true);
  });
});

describe("lazyTools wiring in apply()", () => {
  function applyHarness(config: Record<string, unknown>, skills?: unknown) {
    const tools = new Map<string, ToolDefinition>();
    const listeners = new Map<string, (...args: never[]) => void>();
    const ctx = {
      tools: { register: (def: ToolDefinition) => tools.set(def.name, def) },
      get: (key: string) => (key === "skills" ? skills : undefined),
      inject: () => ({ dispose() {} }),
      effect: () => {},
      on: (event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    };
    const runner = {
      async run(): Promise<BskRunResult> {
        return { code: 0, stdout: "{}", stderr: "", timedOut: false, aborted: false };
      },
      killAll() {},
      killFor: () => 0,
    };
    apply(ctx as never, config, {
      runnerFactory: () => runner as never,
      startJournal: memoryStartJournal(),
    });
    return { tools, listeners };
  }

  it("lazyTools: false registers the suite at apply time", () => {
    const { tools } = applyHarness({ lazyTools: false });
    expect([...tools.keys()].sort()).toEqual([
      "browser_assist",
      "browser_inspect",
      "browser_interact",
      "browser_page",
      "browser_session",
      "browser_tabs",
    ]);
  });

  it("keeps eager tools available when skill registration fails", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { tools } = applyHarness(
        { lazyTools: false },
        {
          register() {
            throw new Error("incompatible SDK");
          },
        },
      );
      expect([...tools.keys()].sort()).toEqual([
        "browser_assist",
        "browser_inspect",
        "browser_interact",
        "browser_page",
        "browser_session",
        "browser_tabs",
      ]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("incompatible SDK"));
    } finally {
      warning.mockRestore();
    }
  });

  it("lazyTools: true hides the suite until the skill fires", () => {
    const { tools, listeners } = applyHarness({ lazyTools: true });
    expect(tools.has("browser_session")).toBe(false);
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: false },
    );
    expect(tools.has("browser_session")).toBe(true);
  });
});
