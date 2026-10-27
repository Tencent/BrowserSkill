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
  const warning = vi.fn();
  const ctx = {
    logger: { error: warning },
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
    warning,
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

async function callListeners(
  listeners: Map<string, (...args: never[]) => void>,
  event: string,
  ...args: unknown[]
): Promise<unknown> {
  if (event === "tools/post-execute") {
    args[0] = { signal: new AbortController().signal, ...(args[0] as object) };
    args.push(async () => ({ kind: "accept" }));
  }
  return (listeners.get(event) as ((...a: unknown[]) => unknown) | undefined)?.(...args);
}

describe("armLazyTools", () => {
  it("keeps the suite hidden until a successful skill invocation reveals it", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(registerSuite).not.toHaveBeenCalled();

    // wrong tool
    await callListeners(
      listeners,
      "tools/post-execute",
      { name: "bash", arguments: {} },
      { isError: false },
    );
    // wrong skill name
    await callListeners(
      listeners,
      "tools/post-execute",
      { name: "skill", arguments: { name: "other-skill" } },
      { isError: false },
    );
    // failed invocation
    await callListeners(
      listeners,
      "tools/post-execute",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: true },
    );
    expect(registerSuite).not.toHaveBeenCalled();

    // the real trigger (arguments may arrive as a raw JSON string)
    await callListeners(
      listeners,
      "tools/post-execute",
      { name: "skill", arguments: '{"name":"browser-skill"}' },
      { isError: false },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across repeated invocations", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    for (let i = 0; i < 3; i++) {
      await callListeners(
        listeners,
        "tools/post-execute",
        { name: "skill", arguments: { name: "browser-skill" } },
        { isError: false },
      );
    }
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("reveals on a /browser-skill user gesture (skill-invocation message)", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    await callListeners(
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

  it("restores from session history: hit at boot, on session entry, and miss", async () => {
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
    await callListeners(listeners, "session/created", { events: hitEvents });
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

  it("re-arms from history on a later event when the boot scan could not see the session", async () => {
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
    await callListeners(
      listeners,
      "session/event",
      { events: hitEvents },
      { type: "message/append" },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("does not reveal from an event whose session has no proof", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    await callListeners(
      listeners,
      "session/event",
      { events: [{ type: "message/append", data: {} }] },
      { type: "message/append" },
    );
    expect(registerSuite).not.toHaveBeenCalled();
  });

  it("stops scanning session history once the suite is revealed", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    await callListeners(
      listeners,
      "tools/post-execute",
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
    await callListeners(listeners, "session/event", exploding, { type: "message/append" });
    await callListeners(listeners, "session/created", exploding);
    expect(readHistory).not.toHaveBeenCalled();
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("disposes listeners and the revealed suite", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const suiteDispose = vi.fn();
    const disarm = armLazyTools(ctx, () => suiteDispose);
    await callListeners(
      listeners,
      "tools/post-execute",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: false },
    );
    disarm();
    disarm();
    expect(suiteDispose).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("restores current DSH history when a missed session later emits an ordinary event", async () => {
    const { ctx, listeners } = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    const session = { events: [skillCall(), skillResult()] };
    await callListeners(listeners, "session/event", session, { type: "turn/start", data: {} });
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("restores as soon as a late sessions service becomes available", async () => {
    const host = fakeEventCtx();
    const registerSuite = vi.fn(() => () => {});
    const disarm = armLazyTools(host.ctx, registerSuite);
    host.provideSessions({ list: () => [{ events: [skillCall(), skillResult()] }] });
    expect(registerSuite).toHaveBeenCalledTimes(1);
    disarm();
    host.provideSessions({ list: () => [{ events: [skillCall(), skillResult()] }] });
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("restores from the newer DSH snapshotEvents API", async () => {
    const session = { snapshotEvents: vi.fn(() => [skillCall(), skillResult()]) };
    const { ctx } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(session.snapshotEvents).toHaveBeenCalledTimes(1);
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("consumes new events without taking another snapshot on newer DSH", async () => {
    const session = { snapshotEvents: vi.fn(() => [skillCall()]) };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    for (let i = 0; i < 20_000; i++) {
      await callListeners(listeners, "session/event", session, { type: "assistant/chunk" });
    }
    expect(registerSuite).not.toHaveBeenCalled();
    await callListeners(listeners, "session/event", session, skillResult());
    expect(registerSuite).toHaveBeenCalledTimes(1);
    expect(session.snapshotEvents).toHaveBeenCalledTimes(1);
  });

  it("scans a long uninvoked session once and then consumes live call/results", async () => {
    const session = Session.create(SessionId("streaming"));
    const readHistory = vi.spyOn(session, "snapshotEvents");
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    for (let i = 0; i < 20_000; i++) {
      const event = session.append("step/end", { turn: 0, step: i });
      await callListeners(listeners, "session/event", session, event);
    }
    await callListeners(listeners, "session/created", session);
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(registerSuite).not.toHaveBeenCalled();

    await callListeners(listeners, "session/event", session, skillCall());
    await callListeners(listeners, "session/event", session, skillResult(true));
    // A failed call is settled; a later result alone cannot turn it into proof.
    await callListeners(listeners, "session/event", session, skillResult());
    expect(registerSuite).not.toHaveBeenCalled();
    await callListeners(listeners, "session/event", session, skillCall("retry"));
    await callListeners(listeners, "session/event", session, skillResult(false, "retry"));
    expect(registerSuite).toHaveBeenCalledTimes(1);
    expect(readHistory).toHaveBeenCalledTimes(1);
    readHistory.mockRestore();
  });

  it("pairs a result arriving after the first scan with an earlier pending call", async () => {
    const session = { events: [skillCall()] };
    const { ctx, listeners } = fakeEventCtx({ list: () => [session] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    expect(registerSuite).not.toHaveBeenCalled();
    await callListeners(listeners, "session/event", session, skillResult());
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("keeps call correlation local to each session object", async () => {
    const first = { events: [skillCall()] };
    const second = { events: [] };
    const { ctx, listeners } = fakeEventCtx({ list: () => [first, second] });
    const registerSuite = vi.fn(() => () => {});
    armLazyTools(ctx, registerSuite);
    await callListeners(listeners, "session/event", second, skillResult());
    expect(registerSuite).not.toHaveBeenCalled();
    await callListeners(listeners, "session/event", first, skillResult());
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("retries unreadable history without caching the failure as an empty scan", async () => {
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
    await callListeners(listeners, "session/event", session, { type: "turn/start" });
    expect(history).toHaveBeenCalledTimes(2);
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("recovers after a startup registry failure", async () => {
    const { ctx, listeners } = fakeEventCtx({
      list() {
        throw new Error("registry unavailable");
      },
    });
    const registerSuite = vi.fn(() => () => {});
    expect(() => armLazyTools(ctx, registerSuite)).not.toThrow();
    await callListeners(
      listeners,
      "session/event",
      { events: [skillCall(), skillResult()] },
      { type: "turn/start" },
    );
    expect(registerSuite).toHaveBeenCalledTimes(1);
  });

  it("retries registration on the next turn without re-reading successful history", async () => {
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
    armLazyTools(ctx, registerSuite);
    await callListeners(listeners, "session/event", session, { type: "turn/start" });
    expect(registerSuite).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it.each([
    "startup",
    "service injection",
  ] as const)("attempts registration once per session batch discovered through %s", async (trigger) => {
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      snapshotEvents: vi.fn(() => (index === 3 ? [skillCall(), skillResult()] : [])),
    }));
    const registry = { list: vi.fn(() => sessions) };
    const host = fakeEventCtx(trigger === "startup" ? registry : undefined);
    const warning = host.warning;
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
      expect(warning).toHaveBeenCalledTimes(1);
      expect(registry.list).toHaveBeenCalledTimes(1);

      // The successful invocation proof survives repeated failures even
      // when the next discovery no longer lists the original session.
      available = true;
      const emptyRegistry = { list: vi.fn(() => []) };
      host.provideSessions(emptyRegistry);
      expect(registerSuite).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(emptyRegistry.list).not.toHaveBeenCalled();
      host.provideSessions(registry);
      expect(registerSuite).toHaveBeenCalledTimes(3);
      for (const [index, session] of sessions.entries()) {
        expect(session.snapshotEvents).toHaveBeenCalledTimes(index <= 3 ? 1 : 0);
      }
    } finally {
      disarm();
    }
    expect(suiteDispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    "history",
    "tool result",
    "gesture",
  ] as const)("defers failed registration from %s during streaming and recovers on the next turn", async (trigger) => {
    const history = vi.fn(() => (trigger === "history" ? [skillCall(), skillResult()] : []));
    const session = {
      get events() {
        return history();
      },
    };
    const { ctx, listeners, warning } = fakeEventCtx({ list: () => [session] });
    let available = false;
    const registerSuite = vi.fn(() => {
      if (!available) throw new Error("registration unavailable");
      return () => {};
    });
    const disarm = armLazyTools(ctx, registerSuite);
    try {
      if (trigger === "tool result") {
        await callListeners(
          listeners,
          "tools/post-execute",
          { name: "skill", arguments: { name: "browser-skill" } },
          { isError: false },
        );
      } else if (trigger === "gesture") {
        await callListeners(listeners, "session/event", session, {
          type: "user/message",
          data: { source: { kind: "skill-invocation", name: "browser-skill" } },
        });
      }
      expect(registerSuite).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 20_000; i++) {
        await callListeners(listeners, "session/event", session, { type: "assistant/chunk" });
      }
      expect(registerSuite).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledTimes(1);

      // A live result/gesture may not be in the first snapshot. Keep its
      // successful invocation proof, without retrying registration per token.
      available = true;
      await callListeners(listeners, "session/event", session, { type: "turn/start" });
      expect(registerSuite).toHaveBeenCalledTimes(2);
      await callListeners(listeners, "session/event", session, { type: "assistant/chunk" });
      expect(registerSuite).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledTimes(1);
    } finally {
      disarm();
    }
  });
});

describe("hasSuccessfulSkillInvocation", () => {
  it("recognizes official DSH result messages and requires successful matching calls", async () => {
    expect(hasSuccessfulSkillInvocation([skillCall(), skillResult()])).toBe(true);
    expect(hasSuccessfulSkillInvocation([skillCall(), skillResult(true)])).toBe(false);
    expect(hasSuccessfulSkillInvocation([skillCall(), skillResult(false, "other")])).toBe(false);
    expect(hasSuccessfulSkillInvocation([skillResult(), skillCall()])).toBe(false);
    expect(hasSuccessfulSkillInvocation([skillResult()])).toBe(false);
  });

  it("rejects missing identities and inconsistent modern result blocks", async () => {
    expect(
      hasSuccessfulSkillInvocation([
        { type: "tool/call", data: { name: "skill", arguments: { name: "browser-skill" } } },
        { type: "tool/result", data: { message: { isError: false } } },
      ]),
    ).toBe(false);
    const message = {
      source: { kind: "tool", callId: "skill-1" },
      content: [{ type: "tool-result", toolCallId: "different", isError: false }],
    };
    expect(
      hasSuccessfulSkillInvocation([skillCall(), { type: "tool/result", data: { message } }]),
    ).toBe(false);
  });

  it("restores DSH 0.2 results with matching envelope identities and a successful outcome", async () => {
    const message = {
      role: "tool",
      source: { kind: "tool", callId: "skill-1" },
      toolCallId: "skill-1",
      content: [{ type: "text", text: "skill instructions" }],
      isError: false,
    };
    const result = { type: "tool/result", data: { message } };
    expect(hasSuccessfulSkillInvocation([skillCall(), result])).toBe(true);
    expect(hasSuccessfulSkillInvocation([result])).toBe(false);
    expect(hasSuccessfulSkillInvocation([result, skillCall()])).toBe(false);

    for (const invalid of [
      { ...message, isError: true },
      { ...message, isError: undefined },
      { ...message, role: "assistant" },
      { ...message, toolCallId: "different" },
      { ...message, source: { kind: "tool", callId: "different" } },
      { ...message, source: { kind: "tool" } },
    ]) {
      expect(
        hasSuccessfulSkillInvocation([
          skillCall(),
          { type: "tool/result", data: { message: invalid } },
        ]),
      ).toBe(false);
    }
  });

  it("pairs call and result by callId and honors gestures", async () => {
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
  function applyHarness(config: Record<string, unknown>) {
    const tools = new Map<string, ToolDefinition>();
    const listeners = new Map<string, (...args: never[]) => void>();
    const ctx = {
      logger: { error: vi.fn() },
      tools: {
        register: (def: ToolDefinition) => {
          tools.set(def.name, def);
          return () => {
            tools.delete(def.name);
          };
        },
      },
      get: () => undefined,
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

  it("lazyTools: false registers the suite at apply time", async () => {
    const { tools } = applyHarness({ lazyTools: false });
    expect([...tools.keys()].sort()).toEqual([
      "bsk_assist",
      "bsk_inspect",
      "bsk_interact",
      "bsk_page",
      "bsk_session",
      "bsk_tabs",
    ]);
  });

  it("lazyTools: true hides the suite until the skill fires", async () => {
    const { tools, listeners } = applyHarness({ lazyTools: true });
    expect(tools.has("bsk_session")).toBe(false);
    await callListeners(
      listeners,
      "tools/post-execute",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: false },
    );
    expect(tools.has("bsk_session")).toBe(true);
  });
});

describe("lazy activation diagnostics", () => {
  async function finish(
    host: ReturnType<typeof fakeEventCtx>,
    overrides: { name?: string; arguments?: unknown; signal?: AbortSignal } = {},
    result = { isError: false },
    decision: unknown = { kind: "accept" },
  ) {
    const hook = host.listeners.get("tools/post-execute") as (...args: unknown[]) => unknown;
    return hook(
      {
        name: "skill",
        arguments: { name: "browser-skill" },
        signal: new AbortController().signal,
        ...overrides,
      },
      result,
      async () => decision,
    );
  }

  async function preStep(
    host: ReturnType<typeof fakeEventCtx>,
    session: object,
    messages: unknown[] = [],
    rejected = false,
    signal = new AbortController().signal,
  ) {
    const hook = host.listeners.get("agent/pre-step") as (...args: unknown[]) => unknown;
    return hook({ agent: { session }, signal }, async () =>
      rejected ? { kind: "reject" } : { kind: "enter", messages },
    );
  }

  it("returns an actionable skill error and deduplicates host logs until recovery", async () => {
    const host = fakeEventCtx();
    let available = false;
    const register = vi.fn(() => {
      if (!available) throw new Error("Failed to register bsk_session: duplicate tool");
      return () => {};
    });
    armLazyTools(host.ctx, register);
    const first = await finish(host);
    expect(first).toMatchObject({
      kind: "block",
      feedback: [{ type: "text", text: expect.stringContaining("bsk_session") }],
    });
    expect(JSON.stringify(first)).toContain("invoke browser-skill again");
    expect(await finish(host)).toEqual(first);
    expect(host.warning).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(2);
    available = true;
    expect(await finish(host)).toEqual({ kind: "accept" });
    expect(register).toHaveBeenCalledTimes(3);
    expect(await finish(host)).toEqual({ kind: "accept" });
    expect(register).toHaveBeenCalledTimes(3);
  });

  it("preserves other skills, errors, blocked decisions, and cancelled calls", async () => {
    const host = fakeEventCtx();
    const register = vi.fn(() => () => {});
    armLazyTools(host.ctx, register);
    const accept = { kind: "accept", content: [{ type: "text", text: "existing projection" }] };
    const block = { kind: "block", feedback: [{ type: "text", text: "existing denial" }] };
    expect(await finish(host, { name: "other" }, undefined, accept)).toBe(accept);
    expect(await finish(host, { arguments: { name: "other-skill" } }, undefined, accept)).toBe(
      accept,
    );
    expect(await finish(host, {}, { isError: true }, accept)).toBe(accept);
    expect(await finish(host, {}, undefined, block)).toBe(block);
    expect(await finish(host, { signal: AbortSignal.abort() }, undefined, accept)).toBe(accept);
    expect(register).not.toHaveBeenCalled();
  });

  it("reports a gesture failure only in its conversation, then reports recovery once", async () => {
    const host = fakeEventCtx();
    const session = { events: [] };
    const unrelated = { events: [] };
    const register = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("duplicate bsk_tabs");
      })
      .mockReturnValue(() => {});
    armLazyTools(host.ctx, register);
    const gesture = {
      id: "gesture-1",
      source: { kind: "skill-invocation", name: "browser-skill", form: "instructions" },
    };
    const decision = await preStep(host, session, [gesture]);
    expect(decision).toMatchObject({
      kind: "enter",
      messages: [
        gesture,
        { source: { form: "notice", summary: "BrowserSkill tools unavailable" } },
      ],
    });
    // The same admitted message later reaches the durable append feed.
    await callListeners(host.listeners, "session/event", session, {
      type: "user/message",
      data: { ...gesture },
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(await preStep(host, unrelated)).toEqual({ kind: "enter", messages: [] });
    expect(await preStep(host, session)).toEqual({ kind: "enter", messages: [] });
    await callListeners(host.listeners, "session/event", session, { type: "turn/start" });
    expect(register).toHaveBeenCalledTimes(2);
    expect(await preStep(host, session)).toMatchObject({
      messages: [{ source: { summary: "BrowserSkill tools available" } }],
    });
    expect(await preStep(host, session)).toEqual({ kind: "enter", messages: [] });
  });

  it("reports failed history restore without interrupting rejected or cancelled steps", async () => {
    const session = { events: [skillCall(), skillResult()] };
    const host = fakeEventCtx({ list: () => [session] });
    const register = vi.fn(() => {
      throw new Error("duplicate bsk_inspect");
    });
    armLazyTools(host.ctx, register);
    expect(await preStep(host, session, [], true)).toEqual({ kind: "reject" });
    expect(await preStep(host, session, [], false, AbortSignal.abort())).toEqual({
      kind: "enter",
      messages: [],
    });
    expect(await preStep(host, session)).toMatchObject({
      messages: [{ content: [{ text: expect.stringContaining("bsk_inspect") }] }],
    });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("ignores an in-flight skill result after the plugin is disposed", async () => {
    const host = fakeEventCtx();
    const register = vi.fn(() => () => {});
    const disarm = armLazyTools(host.ctx, register);
    const hook = host.listeners.get("tools/post-execute") as (...args: unknown[]) => unknown;
    let resolve!: (value: unknown) => void;
    const pending = hook(
      { name: "skill", arguments: { name: "browser-skill" }, signal: new AbortController().signal },
      { isError: false },
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    disarm();
    resolve({ kind: "accept" });
    expect(await pending).toEqual({ kind: "accept" });
    expect(register).not.toHaveBeenCalled();
    expect(host.listeners.size).toBe(0);
  });
});
