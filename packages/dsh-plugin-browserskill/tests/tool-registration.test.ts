import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerBrowserTools } from "../src/browser-tools";
import { apply } from "../src/index";
import { memoryStartJournal } from "../src/start-journal";
import toolNames from "../src/tool-names.json";
import type { ToolDeps } from "../src/tools";

const names = Object.values(toolNames);

function registry() {
  const tools = new Map<string, ToolDefinition>();
  const released: string[] = [];
  const register = vi.fn((tool: ToolDefinition) => {
    if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    tools.set(tool.name, tool);
    return () => {
      released.push(tool.name);
      tools.delete(tool.name);
    };
  });
  // Operation bodies capture their services; registering schemas never uses them.
  const deps = { ctx: { tools: { register } } } as unknown as ToolDeps;
  return { tools, released, register, deps };
}

function foreignTool(name: string): ToolDefinition {
  return { name, description: "Foreign tool; must retain its identity" } as ToolDefinition;
}

describe("BrowserSkill suite registration", () => {
  it.each(names)("rolls back a collision at %s and can retry after its removal", (name) => {
    const h = registry();
    const foreign = foreignTool(name);
    h.tools.set(name, foreign);
    let failure: Error | undefined;
    try {
      registerBrowserTools(h.deps);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain(`Failed to register ${name}`);
    expect(failure?.cause).toMatchObject({ message: `duplicate tool: ${name}` });
    expect([...h.tools.values()]).toEqual([foreign]);
    expect(h.tools.get(name)).toBe(foreign);
    expect(h.released).toEqual(names.slice(0, names.indexOf(name)).reverse());

    h.tools.delete(name);
    h.released.length = 0;
    const dispose = registerBrowserTools(h.deps);
    expect([...h.tools.keys()]).toEqual(names);
    dispose();
    dispose();
    expect(h.tools.size).toBe(0);
    expect(h.released).toEqual([...names].reverse());
  });

  it.each(["before", "after"])("coexists with generic browser tools loaded %s", (order) => {
    const h = registry();
    const foreign = names.map((name) => foreignTool(name.replace(/^bsk_/, "browser_")));
    if (order === "before") for (const tool of foreign) h.tools.set(tool.name, tool);
    const dispose = registerBrowserTools(h.deps);
    if (order === "after") for (const tool of foreign) h.tools.set(tool.name, tool);
    expect(h.tools.size).toBe(12);
    dispose();
    expect([...h.tools.values()]).toEqual(foreign);
  });

  it.each([
    false,
    true,
  ])("attempts every release when a disposer throws (rollback=%s)", (rollback) => {
    const h = registry();
    const register = h.register.getMockImplementation()!;
    h.register.mockImplementation((tool) => {
      if (rollback && tool.name === toolNames.assist) throw new Error("registration failure");
      const dispose = register(tool);
      return () => {
        dispose();
        if (tool.name === toolNames.interact) throw new Error("disposal failure");
      };
    });
    if (rollback) {
      expect(() => registerBrowserTools(h.deps)).toThrow(/Failed to register bsk_assist/);
    } else {
      const dispose = registerBrowserTools(h.deps);
      expect(dispose).toThrow(AggregateError);
      expect(dispose).not.toThrow();
    }
    expect(h.tools.size).toBe(0);
    expect(h.released).toEqual((rollback ? names.slice(0, -1) : [...names]).reverse());
  });

  it("owns runner and journal cleanup before eager registration can fail", async () => {
    const h = registry();
    h.tools.set(toolNames.page, foreignTool(toolNames.page));
    const cleanups: (() => Promise<void>)[] = [];
    const runner = {
      run: vi.fn(),
      killAll: vi.fn(),
      killFor: () => 0,
    };
    const journal = memoryStartJournal();
    const release = vi.spyOn(journal, "release");
    const ctx = {
      tools: { register: h.register },
      get: () => undefined,
      on: () => () => {},
      effect: (factory: () => () => Promise<void>) => cleanups.push(factory()),
    };
    expect(() =>
      apply(
        ctx as never,
        { lazyTools: false, observationEnabled: false },
        {
          runnerFactory: () => runner,
          startJournal: journal,
        },
      ),
    ).toThrow(/Failed to register bsk_page/);
    expect(cleanups).toHaveLength(1);
    // Cordis unwinds the effect on failed apply; reproduce that lifecycle here.
    await cleanups[0]();
    await cleanups[0]();
    expect(runner.killAll).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect([...h.tools.keys()]).toEqual([toolNames.page]);
  });
});
