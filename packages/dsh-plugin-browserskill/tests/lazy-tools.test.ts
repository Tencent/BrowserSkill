// Lazy tool-schema injection: suite hidden before a successful skill
// invocation, revealed by the model trigger / user gesture / session history,
// idempotent on repeats, and torn down cleanly. Plus the apply-level
// lazyTools two-state wiring.

import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { apply } from "../src/index";
import { armLazyTools, hasSuccessfulSkillInvocation } from "../src/lazy-tools";
import type { BskRunOptions, BskRunResult } from "../src/runner";

function fakeEventCtx(sessions?: { list(): { events: unknown[] }[] }) {
  const listeners = new Map<string, (...args: never[]) => void>();
  const ctx = {
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    get: (key: string) => (key === "sessions" ? sessions : undefined),
  };
  return { ctx: ctx as never, listeners };
}

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
    expect(suiteDispose).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

describe("hasSuccessfulSkillInvocation", () => {
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
  function applyHarness(config: Record<string, unknown>) {
    const tools = new Map<string, ToolDefinition>();
    const listeners = new Map<string, (...args: never[]) => void>();
    const ctx = {
      tools: { register: (def: ToolDefinition) => tools.set(def.name, def) },
      get: () => undefined,
      inject: () => {},
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
    apply(ctx as never, config, { runnerFactory: () => runner as never });
    return { tools, listeners };
  }

  it("lazyTools: false registers the suite at apply time", () => {
    const { tools } = applyHarness({ lazyTools: false });
    expect(tools.has("browser_session_start")).toBe(true);
    expect(tools.has("browser_emulate")).toBe(true);
  });

  it("lazyTools: true hides the suite until the skill fires", () => {
    const { tools, listeners } = applyHarness({ lazyTools: true });
    expect(tools.has("browser_session_start")).toBe(false);
    callListeners(
      listeners,
      "tools/result",
      { name: "skill", arguments: { name: "browser-skill" } },
      { isError: false },
    );
    expect(tools.has("browser_session_start")).toBe(true);
  });
});
