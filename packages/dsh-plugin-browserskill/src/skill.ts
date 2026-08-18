/**
 * Progressive disclosure of the BrowserSkill agent skill through the harness's
 * official skill seam (`ctx.skills`). The catalog entry (name + description)
 * is resident; the body is loaded only when the model invokes the `skill`
 * tool. The markdown is build-time assembled into a static module (dsh
 * prelude + the canonical CLI skill body verbatim), so registration and every
 * pre-step catalog snapshot are pure in-memory reads — no disk, no process,
 * no daemon.
 */

import type { Context } from "@deepseek-ai/cordis";
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

/**
 * Publish the BSK skill as an embedded runtime skill. Returns the unregistration
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
