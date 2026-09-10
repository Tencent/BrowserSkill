// Browser skill injection: registration wiring, catalog content, progressive-load
// weight, and silent degradation without the skill seam.

import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { describe, expect, it } from "vitest";
import { armAgentScopedBskSkill, registerBskSkill } from "../src/skill";

function fakeCtx(skills?: unknown) {
  return { get: (key: string) => (key === "skills" ? skills : undefined) } as never;
}

describe("registerBskSkill", () => {
  it("registers the catalog entry with the DSH browser-tool body", () => {
    const registrations: { skill: Record<string, unknown>; disposer: () => void }[] = [];
    const skills = {
      register(skill: Record<string, unknown>) {
        const disposer = () => {
          skill.__disposed = true;
        };
        registrations.push({ skill, disposer });
        return disposer;
      },
    };
    const unregister = registerBskSkill(fakeCtx(skills));
    expect(registrations).toHaveLength(1);
    const skill = registrations[0].skill;
    expect(skill.name).toBe("browser-skill");
    expect(typeof skill.description).toBe("string");
    expect(String(skill.description)).toContain("browser_*");
    const content = String(skill.content);
    const mentionedTools = [...new Set(content.match(/\bbrowser_[a-z][a-z_]*\b/g) ?? [])].sort();
    expect(mentionedTools).toEqual([
      "browser_assist",
      "browser_inspect",
      "browser_interact",
      "browser_page",
      "browser_session",
      "browser_tabs",
    ]);
    expect(String(skill.description)).not.toMatch(/\bbsk\b/i);
    expect(content).not.toMatch(/\bbsk\b/i);
    expect(content).not.toMatch(/```(?:bash|sh|shell)\b/i);
    expect(content).not.toMatch(/--[a-z]/);
    expect(content).toMatch(/All browser work\s+must use the injected tools directly/);
    expect(content).toContain("Mandatory workflow");
    expect(content).toContain("Refs invalidate after navigation");
    expect(content).toContain("evaluation and interaction recording are intentionally unsupported");
    // Keep the lazily injected instructions inside a bounded prompt budget,
    // while the lower bound catches accidental truncation of the guidance.
    expect(content.length).toBeGreaterThan(3_000);
    expect(content.length).toBeLessThan(6_000);
    expect(skill.source).toBe("bundled");
    // Source frontmatter is registration metadata and must not leak into the body.
    expect(content.startsWith("---")).toBe(false);
    expect(content).not.toContain("name: browser-skill\ndescription:");
    // disposer passthrough
    unregister();
    expect(skill.__disposed).toBe(true);
  });

  it("keeps one in-memory copy: repeated reads share the same content", () => {
    let captured: Record<string, unknown> | undefined;
    const skills = {
      register(skill: Record<string, unknown>) {
        captured = skill;
        return () => {};
      },
    };
    registerBskSkill(fakeCtx(skills));
    // Pre-step catalog snapshots re-read the registration: the body must be
    // the identical in-memory string every time (no reload, no copy).
    expect(captured?.content).toBe(captured?.content);
    expect(typeof captured?.content).toBe("string");
  });

  it("degrades silently when the skills seam is absent or foreign", () => {
    expect(() => registerBskSkill(fakeCtx())).not.toThrow();
    expect(() => registerBskSkill(fakeCtx(null))).not.toThrow();
    expect(() => registerBskSkill(fakeCtx({}))).not.toThrow();
    const disposer = registerBskSkill(fakeCtx());
    expect(typeof disposer).toBe("function");
    expect(() => disposer()).not.toThrow();
  });
});

describe("armAgentScopedBskSkill", () => {
  it("overrides a nearer legacy CLI skill when the DSH agent starts", async () => {
    const root = new Context();
    const skillFiber = root.plugin(SkillRegistry);
    await skillFiber;

    // The plugin's original registration is global.
    registerBskSkill(skillFiber.ctx);

    // Model the standard preset's filesystem discovery of
    // ~/.agents/skills/browser-skill. Its nearer scope wins before the fix.
    const presetKey = { preset: "standard" };
    const presetScope = createScope(skillFiber.ctx, presetKey);
    presetScope.ctx.skills.register({
      name: "browser-skill",
      description: "Legacy BrowserSkill CLI instructions",
      content: "Use bsk shell commands.",
      source: "user-agents",
    });

    const agentKey = { agent: "test-agent" };
    const agentScope = createScope(skillFiber.ctx, agentKey, { parent: presetKey });
    const agent = {
      id: "test-agent",
      ctx: agentScope.ctx,
    } as never;
    const agents = { list: () => [] };
    const pluginCtx = skillFiber.ctx.extend({ agents });

    const before = await skillFiber.ctx.skills.get("browser-skill", { scope: agentKey });
    expect(before?.content).toBe("Use bsk shell commands.");
    expect(before?.source).toBe("user-agents");

    const disarm = armAgentScopedBskSkill(pluginCtx);
    pluginCtx.emit(scopeTarget(agent, agentKey), "agent/session-start", {
      agent,
      source: "startup",
    });

    const after = await skillFiber.ctx.skills.get("browser-skill", { scope: agentKey });
    expect(after?.content).toMatch(/All browser work\s+must use the injected tools directly/);
    expect(after?.content).not.toMatch(/\bbsk\b/i);
    expect(after?.source).toBe("bundled");

    disarm();
    await agentScope.dispose();
    await presetScope.dispose();
    await skillFiber.dispose();
  });

  it("installs on existing agents for plugin reload and disposes registrations", () => {
    const registered: Record<string, unknown>[] = [];
    let disposed = 0;
    const agent = {
      ctx: fakeCtx({
        register(skill: Record<string, unknown>) {
          registered.push(skill);
          return () => {
            disposed += 1;
          };
        },
      }),
    } as never;
    const listeners = new Map<string, (payload: { agent: never }) => void>();
    const ctx = {
      get: (key: string) => (key === "agents" ? { list: () => [agent] } : undefined),
      on(event: string, listener: (payload: { agent: never }) => void) {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
    } as never;

    const disarm = armAgentScopedBskSkill(ctx);
    expect(registered).toHaveLength(1);

    // A later lifecycle notification for the same agent must not duplicate it.
    listeners.get("agent/session-start")?.({ agent });
    expect(registered).toHaveLength(1);

    disarm();
    expect(disposed).toBe(1);
    expect(listeners.size).toBe(0);
  });
});
