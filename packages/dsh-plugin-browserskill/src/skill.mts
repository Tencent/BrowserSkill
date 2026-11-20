/**
 * Progressive disclosure of the unified BrowserSkill CLI skill through DeepSeek
 * Harness's official skill registry (`ctx.skills`), paired with on-demand
 * `bsk` CLI setup guidance when `bsk` is not yet installed on the host.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { resolveBskExecutable } from "./env.mjs";
import {
  BSK_SKILL_DESCRIPTION,
  BSK_SKILL_MARKDOWN,
  BSK_SKILL_NAME,
} from "./skill-content.generated.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_DIRECTORY = join(PACKAGE_ROOT, "skill");
const INSTALLER_SCRIPT = join(PACKAGE_ROOT, "bin", "install-bsk.mjs");
const AGENT_INSTALL_GUIDE = join(PACKAGE_ROOT, "AGENT_INSTALL.md");

/** Structural view of the DSH skill registry seam (`@deepseek-ai/dsh-skill`). */
interface SkillsLike {
  register(skill: {
    name: string;
    description: string;
    content: string;
    source?: string;
    resourceBase?: { kind: "directory"; path: string };
  }): () => void;
}

/** Structural view of a live DSH agent and the agent registry seam. */
interface AgentLike {
  ctx: Context;
}

interface AgentsLike {
  list(): AgentLike[];
}

/**
 * Render the skill markdown for DSH. When `bsk` is already installed, returns
 * the canonical `SKILL.md` body unchanged (zero extra token overhead). When
 * `bsk` is missing, prepends concise on-demand setup instructions pointing to
 * the bundled local installer and `AGENT_INSTALL.md`.
 */
export function buildDshSkillContent(bskPath?: string): string {
  if (resolveBskExecutable(bskPath) !== null) {
    return BSK_SKILL_MARKDOWN;
  }
  return (
    "## First-time setup (`bsk` CLI not detected)\n\n" +
    "`bsk` was not found on this machine. Complete on-demand setup before running browser commands:\n\n" +
    `1. Install the \`bsk\` CLI (never use \`sudo\`): \`node ${JSON.stringify(INSTALLER_SCRIPT)}\`\n` +
    `2. Follow \`${AGENT_INSTALL_GUIDE}\` (Steps 3-5): run \`bsk doctor\`, ask the user to install and enable the Chrome or Edge extension if \`extension connected\` fails, re-run \`bsk doctor\`, then proceed with the task.\n\n` +
    BSK_SKILL_MARKDOWN
  );
}

/**
 * Register `browser-skill` into the given Cordis context's `skills` service.
 * Degrades silently when the composition omits the `skills` service.
 */
export function registerBskSkill(ctx: Context, bskPath?: string): () => void {
  const skills = (ctx as { get?: (name: string) => unknown }).get?.("skills") as
    | SkillsLike
    | undefined
    | null;
  if (skills == null || typeof skills.register !== "function") {
    return () => {};
  }
  return skills.register({
    name: BSK_SKILL_NAME,
    description: BSK_SKILL_DESCRIPTION,
    content: buildDshSkillContent(bskPath),
    source: "bundled",
    resourceBase: {
      kind: "directory",
      path: SKILL_DIRECTORY,
    },
  });
}

/**
 * Register `browser-skill` into every exact agent scope so stale filesystem
 * copies in `~/.agents/skills/browser-skill` do not shadow the plugin, and so
 * new conversations automatically drop the first-time setup banner once `bsk`
 * has been installed on demand.
 */
export function armAgentScopedBskSkill(ctx: Context, bskPath?: string): () => void {
  const registrations = new Map<AgentLike, () => void>();
  let active = true;

  const registerForAgent = (agent: AgentLike): void => {
    if (!active || registrations.has(agent)) return;
    registrations.set(agent, registerBskSkill(agent.ctx, bskPath));
  };

  const syncExistingAgents = (targetCtx: Context): void => {
    const agents = (targetCtx as { get?: (name: string) => unknown }).get?.("agents") as
      | AgentsLike
      | undefined
      | null;
    if (agents != null && typeof agents.list === "function") {
      for (const agent of agents.list()) {
        registerForAgent(agent);
      }
    }
  };

  let stopCreated = () => {};
  let stopDisposed = () => {};
  const eventCtx = ctx as unknown as {
    on?: (event: string, listener: (payload: { agent: AgentLike }) => undefined) => () => void;
  };
  if (typeof eventCtx.on === "function") {
    stopCreated = eventCtx.on("agent/created", ({ agent }) => {
      registerForAgent(agent);
      return undefined;
    });
    stopDisposed = eventCtx.on("agent/disposed", ({ agent }) => {
      registrations.delete(agent);
      return undefined;
    });
  }

  syncExistingAgents(ctx);
  if (typeof (ctx as { inject?: unknown }).inject === "function") {
    ctx.inject(["agents"], (injected) => {
      syncExistingAgents(injected);
    });
  }

  return () => {
    if (!active) return;
    active = false;
    stopDisposed();
    stopCreated();
    for (const unregister of [...registrations.values()].reverse()) {
      unregister();
    }
    registrations.clear();
  };
}
