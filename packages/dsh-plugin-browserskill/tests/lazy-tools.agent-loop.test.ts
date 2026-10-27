import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import {
  createUserMessage,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmRuntime,
  type Message,
  type StreamChunk,
  type TextBlock,
  type ToolCallBlock,
  ToolCallId,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/index";
import { memoryStartJournal } from "../src/start-journal";
import toolNames from "../src/tool-names.json";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

function input(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function textOf(messages: readonly Pick<Message, "content">[]) {
  return messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function notices(agent: Agent) {
  return agent.session.snapshotEvents().flatMap((event) => {
    if (
      event.type !== "user/message" ||
      event.data.source.kind !== "plugin" ||
      event.data.source.form !== "notice"
    )
      return [];
    return [{ summary: event.data.source.summary, text: textOf([event.data]) }];
  });
}

function browserSchemas(request: GenerateOptions) {
  return (request.tools ?? []).map((tool) => tool.name).filter((name) => name.startsWith("bsk_"));
}

/** Real loop, prompt assembly, skill injection, tool execution and durable log;
 * only the model and browser subprocess boundary are fixtures. */
async function host() {
  const root = new Context();
  const requests: GenerateOptions[] = [];
  const responses: (TextBlock | ToolCallBlock)[] = [];
  const errors: unknown[] = [];
  let sequence = 0;
  root.on("agent/error", ({ error }) => errors.push(error));
  root.logger.exporter({ export() {} });
  async function* stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    requests.push(request);
    if (requests.length > 12) throw new Error("Unexpected unbounded fixture loop");
    const response = responses.shift() ?? { type: "text", text: "Complete." };
    yield { type: "block-start", index: 0, blockType: response.type };
    if (response.type === "text") yield { type: "text-delta", index: 0, text: response.text };
    else
      yield {
        type: "tool-call-delta",
        index: 0,
        id: response.id,
        name: response.name,
        argumentsDelta: response.arguments,
      };
    yield { type: "block-end", index: 0, block: response };
    yield { type: "finish", reason: { kind: response.type === "text" ? "stop" : "tool-calls" } };
  }
  root.provide("llm", {
    prepareCall: async (config: LlmCallConfig) => ({ config, stream }),
  } as unknown as LlmRuntime);
  for (const fiber of [
    root.plugin(SystemPrompt),
    root.plugin(ToolRuntime),
    root.plugin(AgentRegistry),
    root.plugin(SkillRegistry),
    root.plugin(SessionStore),
    root.plugin(SessionProjectionRegistry),
    root.plugin(ToolSkill),
    root.plugin(AgentLoop),
  ]) {
    cleanups.push(() => fiber.dispose());
    await fiber;
  }
  const register = (name: string, execute: () => void = () => {}) => {
    const dispose = root.tools.register(
      defineTool({
        name,
        description: "Agent loop fixture",
        parameters: {},
        output: { schema: { type: "json" }, render: () => [] },
        execute: async () => {
          execute();
          return {};
        },
      }),
    );
    cleanups.push(dispose);
    return dispose;
  };
  const mount = async () => {
    const plugin = root.plugin({
      name: "browser-skill-loop-fixture",
      inject: ["tools"],
      apply(ctx: Context) {
        apply(
          ctx,
          { observationEnabled: false, lazyTools: true },
          {
            startJournal: memoryStartJournal(),
            runnerFactory: () => ({
              async run(args) {
                expect(args).toEqual(["--version", "--json"]);
                return {
                  code: 0,
                  stdout: '{"version":"0.3.2"}',
                  stderr: "",
                  timedOut: false,
                  aborted: false,
                };
              },
              killAll() {},
              killFor: () => 0,
            }),
          },
        );
      },
    });
    cleanups.push(() => plugin.dispose());
    await plugin;
  };
  const turn = async (agent: Agent, message: string | UserMessage) => {
    agent.followup(typeof message === "string" ? input(message) : message);
    await agent.whenIdle();
    expect(errors).toEqual([]);
  };
  return {
    root,
    requests,
    responses,
    register,
    mount,
    turn,
    agent: () =>
      root.agentLoop.create(SessionId(`loop-${++sequence}`), {
        provider: "fixture",
        model: "local-stub",
      }),
    call: (name: string, args = {}): ToolCallBlock => ({
      type: "tool-call",
      id: ToolCallId(`call-${++sequence}`),
      name,
      arguments: JSON.stringify(args),
    }),
  };
}

describe("lazy activation at the model request boundary", () => {
  it.each([
    "before",
    "after",
  ])("includes schemas in the first slash request with foreign tools loaded %s", async (order) => {
    const h = await host();
    if (order === "before") h.register("browser_session");
    await h.mount();
    if (order === "after") h.register("browser_session");
    const foreign = h.root.tools.get("browser_session");
    const agent = await h.agent();
    expect(h.root.tools.get(toolNames.session)).toBeUndefined();
    await h.turn(agent, "Please use /browser-skill to inspect the fixture page");
    expect(h.requests).toHaveLength(1);
    expect(browserSchemas(h.requests[0])).toEqual(Object.values(toolNames).sort());
    expect(textOf(h.requests[0].messages)).toContain('<skill_content name="browser-skill">');
    expect(h.root.tools.get("browser_session")).toBe(foreign);
  });

  it.each([
    "/browser-skill-extra",
    "/browser-skill/path",
    "https://example.com/browser-skill",
  ])("keeps ordinary input lazy: %s", async (text) => {
    const h = await host();
    await h.mount();
    await h.turn(await h.agent(), text);
    expect(browserSchemas(h.requests[0])).toEqual([]);
  });

  it("ignores plugin-authored text and discarded inbox messages", async () => {
    const h = await host();
    await h.mount();
    const agent = await h.agent();
    agent.inbox.append("next-turn", input("/browser-skill discarded"));
    agent.inbox.clear();
    await h.turn(
      agent,
      createUserMessage({
        content: [{ type: "text", text: "/browser-skill" }],
        source: { kind: "plugin", plugin: "fixture", form: "notice", summary: "Fixture" },
      }),
    );
    expect(browserSchemas(h.requests[0])).toEqual([]);
  });

  it("attempts a failed slash activation once across claim, injection and append", async () => {
    const h = await host();
    h.register(toolNames.tabs);
    await h.mount();
    const register = vi.spyOn(h.root.tools, "register");
    const agent = await h.agent();
    await h.turn(agent, "/browser-skill inspect the fixture page");
    expect(register.mock.calls.filter(([tool]) => tool.name === toolNames.session)).toHaveLength(1);
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0].text).toContain("Failed to register bsk_tabs");
    register.mockRestore();
  });

  it("reports same-turn slash recovery with schemas already in that request", async () => {
    const h = await host();
    const occupied = h.register(toolNames.tabs);
    await h.mount();
    const agent = await h.agent();
    h.register("resolve_collision", () => {
      occupied();
      agent.inject(input("/browser-skill retry"));
      return {};
    });
    h.responses.push(h.call("resolve_collision"));
    await h.turn(agent, "/browser-skill inspect the fixture page");
    expect(h.requests).toHaveLength(2);
    expect(browserSchemas(h.requests[1])).toEqual(Object.values(toolNames).sort());
    expect(notices(agent).map((notice) => notice.summary)).toEqual([
      "BrowserSkill tools unavailable",
      "BrowserSkill tools available",
    ]);
    expect(notices(agent)[1].text).toContain("Use the bsk_* tools");
  });

  it("reports recovery after a first model load failure and requests the missing instructions", async () => {
    const h = await host();
    const occupied = h.register(toolNames.tabs);
    await h.mount();
    const agent = await h.agent();
    h.responses.push(h.call("skill", { name: "browser-skill" }));
    await h.turn(agent, "Use BrowserSkill");
    expect(notices(agent)).toEqual([]); // The blocked tool result already reports the failure.
    const results = JSON.stringify(
      agent.session.snapshotEvents().filter((event) => event.type === "tool/result"),
    );
    expect(results).toContain('"isError":true');
    expect(results).toContain("start a new turn to retry");
    expect(results).not.toContain("<skill_content");
    occupied();
    await h.turn(agent, "Continue");
    expect(browserSchemas(h.requests[2])).toEqual(Object.values(toolNames).sort());
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0].text).toContain('Call skill({ name: "browser-skill" })');
    await h.turn(agent, "Continue");
    expect(notices(agent)).toHaveLength(1);
    const other = await h.agent();
    await h.turn(other, "Unrelated task");
    expect(notices(other)).toEqual([]);
  });

  it("reports a changed failure on a new turn after the first model load failed", async () => {
    const h = await host();
    const occupied = h.register(toolNames.page);
    await h.mount();
    const agent = await h.agent();
    h.responses.push(h.call("skill", { name: "browser-skill" }));
    await h.turn(agent, "Use BrowserSkill");
    occupied();
    h.register(toolNames.tabs);
    await h.turn(agent, "Retry");
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0].text).toContain("Failed to register bsk_tabs");
    await h.turn(agent, "Retry");
    expect(notices(agent)).toHaveLength(1);
  });

  it("does not repeat a model retry error in the next step's notice", async () => {
    const h = await host();
    const occupied = h.register(toolNames.page);
    h.register("change_collision", () => {
      occupied();
      h.register(toolNames.tabs);
      return {};
    });
    await h.mount();
    const agent = await h.agent();
    h.responses.push(h.call("change_collision"), h.call("skill", { name: "browser-skill" }));
    await h.turn(agent, "/browser-skill inspect the fixture page");
    expect(h.requests).toHaveLength(3);
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0].text).toContain("Failed to register bsk_page");
    expect(JSON.stringify(h.requests[2].messages)).toContain("Failed to register bsk_tabs");
  });

  it("uses the successful skill body when a model retry recovers", async () => {
    const h = await host();
    const occupied = h.register(toolNames.tabs);
    h.register("resolve_collision", () => {
      occupied();
      return {};
    });
    await h.mount();
    const agent = await h.agent();
    h.responses.push(
      h.call("skill", { name: "browser-skill" }),
      h.call("resolve_collision"),
      h.call("skill", { name: "browser-skill" }),
    );
    await h.turn(agent, "Use BrowserSkill");
    expect(h.requests).toHaveLength(4);
    expect(browserSchemas(h.requests[3])).toEqual(Object.values(toolNames).sort());
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0].text).toContain("Use the bsk_* tools");
    expect(JSON.stringify(h.requests[3].messages)).toContain("<skill_content");
  });
});
