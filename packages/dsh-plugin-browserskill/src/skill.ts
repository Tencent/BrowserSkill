/**
 * Progressive disclosure of the BrowserSkill agent skill through the harness's
 * official skill seam (`ctx.skills`). The catalog entry (name + description)
 * is resident; the body is loaded only when the model invokes the `skill`
 * tool. The dedicated DeepSeek Harness markdown is embedded into a static
 * module at build time, so registration and every pre-step catalog snapshot
 * are pure in-memory reads — no disk, no process, no daemon. The CLI-oriented
 * repository skill is intentionally a separate interface.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  BSK_SKILL_DESCRIPTION,
  BSK_SKILL_MARKDOWN,
  BSK_SKILL_NAME,
} from "./skill-content.generated";

/** Structural view of the skill registry seam (absent in bare compositions). */
interface SkillsLike {
  register(skill: {
    name: string;
    description: string;
    content: string;
    source?: string;
  }): () => void;
}

/** Structural view of the live-agent registry (absent in bare compositions). */
interface AgentsLike {
  list(): Agent[];
}

/**
 * Publish the browser skill as an embedded runtime skill. Returns the unregistration
 * disposer. A composition without the `skills` service (or with dsh-tool-skill
 * retired) leaves the rest of the plugin unaffected — the no-op is silent.
 */
export function registerBskSkill(ctx: Context): () => void {
  const skills = ctx.get("skills") as SkillsLike | undefined | null;
  if (skills == null || typeof skills.register !== "function") {
    return () => {};
  }
  return skills.register({
    name: BSK_SKILL_NAME,
    description: BSK_SKILL_DESCRIPTION,
    content: BSK_SKILL_MARKDOWN,
    // Prompt-visible origin bucket: packaged with a plugin, not user/project files.
    source: "bundled",
  });
}

/**
 * Install the DSH-specific browser skill into every exact agent scope.
 *
 * DSH merges skill layers nearest-first (`agent -> preset -> global`). A legacy
 * CLI skill installed at `~/.agents/skills/browser-skill` is discovered by the
 * preset filesystem provider and therefore shadows a plugin-level registration.
 * Registering the embedded skill through `agent.ctx` makes the DSH protocol
 * contract authoritative for that agent without touching the shared CLI skill.
 *
 * New agents are handled at `agent/session-start`, the first supported startup
 * injection point and still before the first prompt assembly. Existing agents
 * are registered immediately so plugin reloads take effect without recreating
 * the conversation. Returns a disposer for all plugin-owned registrations.
 */
export function armAgentScopedBskSkill(ctx: Context): () => void {
  const registrations = new Map<Agent, () => void>();
  let active = true;

  const registerForAgent = (agent: Agent): void => {
    if (!active || registrations.has(agent)) return;
    registrations.set(agent, registerBskSkill(agent.ctx));
  };

  let stopSessionStart = () => {};
  let stopDisposed = () => {};
  if (typeof ctx.on === "function") {
    stopSessionStart = ctx.on("agent/session-start", ({ agent }) => {
      registerForAgent(agent);
    });
    stopDisposed = ctx.on("agent/disposed", ({ agent }) => {
      // Agent-scoped effects have already unwound at this lifecycle edge. Drop
      // the retained disposer without invoking it against a disposed context.
      registrations.delete(agent);
    });
  }

  const agents = ctx.get("agents") as AgentsLike | undefined | null;
  if (agents != null && typeof agents.list === "function") {
    for (const agent of agents.list()) registerForAgent(agent);
  }

  return () => {
    if (!active) return;
    active = false;
    stopDisposed();
    stopSessionStart();
    for (const unregister of [...registrations.values()].reverse()) unregister();
    registrations.clear();
  };
}
