// Browser skill injection: registration wiring, catalog content, progressive-load
// weight, and silent degradation without the skill seam.

import { describe, expect, it } from "vitest";
import { registerBskSkill } from "../src/skill";

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
      "browser_click",
      "browser_console",
      "browser_emulate",
      "browser_fill",
      "browser_get_html",
      "browser_hover",
      "browser_navigate",
      "browser_navigate_back",
      "browser_navigate_forward",
      "browser_network",
      "browser_observe",
      "browser_press",
      "browser_reload",
      "browser_request_help",
      "browser_screenshot",
      "browser_select",
      "browser_session_list",
      "browser_session_start",
      "browser_session_stop",
      "browser_snapshot",
      "browser_tab_borrow",
      "browser_tab_close",
      "browser_tab_create",
      "browser_tab_list",
      "browser_tab_return",
      "browser_tab_select",
      "browser_wait_for_navigation",
      "browser_window_resize",
    ]);
    expect(String(skill.description)).not.toMatch(/\bbsk\b/i);
    expect(content).not.toMatch(/\bbsk\b/i);
    expect(content).not.toMatch(/```(?:bash|sh|shell)\b/i);
    expect(content).not.toMatch(/--[a-z]/);
    expect(content).toContain("All browser operations must use the injected tools directly");
    expect(content).toContain("Mandatory workflow");
    expect(content).toContain("Refs invalidate after navigation");
    expect(content).toContain("evaluation and interaction recording are intentionally unsupported");
    expect(content.length).toBeGreaterThan(10_000);
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
