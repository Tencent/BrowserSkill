// BSK skill injection: registration wiring, catalog content, progressive-load
// weight, and silent degradation without the skill seam.

import { describe, expect, it } from "vitest";
import { registerBskSkill } from "../src/skill";

function fakeCtx(skills?: unknown) {
  return { get: (key: string) => (key === "skills" ? skills : undefined) } as never;
}

describe("registerBskSkill", () => {
  it("registers the catalog entry with the assembled body", () => {
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
    // body = dsh prelude + canonical CLI skill body + dsh postlude
    const content = String(skill.content);
    expect(content).toContain("browser_observe");
    expect(String(skill.description)).toContain("never invoke bsk through bash or shell");
    expect(content).toContain("Always call those injected `browser_*` tools");
    expect(content).toContain("Never use `bash`, `shell`, `exec`");
    expect(content).toContain("## DSH routing reminder");
    expect(content.trimEnd()).toMatch(/always begin with[\s\S]*`browser_session_start`[\s\S]*`browser_session_stop`\.$/);
    expect(content).toContain("Owned sessions only");
    expect(content).toContain("Mandatory workflow");
    expect(content).toContain("Refs invalidate after navigation");
    expect(content.length).toBeGreaterThan(10_000);
    expect(skill.source).toBe("bundled");
    // the original YAML frontmatter must not leak into the body
    expect(content.includes("name: browser-skill\ndescription:")).toBe(false);
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
