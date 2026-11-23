/**
 * Lightweight DeepSeek Harness plugin for BrowserSkill (`@wxg-prc-cpg/browser-skill-dsh-plugin`).
 *
 * Registers the canonical BrowserSkill CLI skill (`crates/bsk-cli/skill`),
 * heals `PATH` for default/configured `bsk` installations, and guides on-demand
 * `bsk` CLI + browser extension setup when `bsk` is not yet installed.
 * Browser execution uses the exact same `bsk` CLI + daemon (`DSH_SESSION_ID`
 * implicit scoping) + browser extension architecture as every other agent.
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { ensureBskInPath, resolveBskExecutable } from "./env.mjs";
import { armAgentScopedBskSkill, buildDshSkillContent, registerBskSkill } from "./skill.mjs";

export const name = "@wxg-prc-cpg/browser-skill-dsh-plugin";

export interface PluginConfig {
  bskPath?: string;
}

/** Runtime configuration schema exposed to Cordis and DSH settings UI. */
export const Config = Schema.object({
  bskPath: Schema.string()
    .default("bsk")
    .description(
      "Path to the bsk CLI executable or directory (defaults to resolving `bsk` from PATH or ~/.local/bin).",
    ),
});

export type Config = PluginConfig;

export function apply(ctx: Context, config: Partial<PluginConfig> = {}): void {
  const bskPath = config.bskPath ?? "bsk";
  const restorePath = ensureBskInPath(bskPath);
  const disposers: (() => void)[] = [restorePath];

  if (typeof (ctx as { effect?: unknown }).effect === "function") {
    ctx.effect(() => () => {
      for (const dispose of [...disposers].reverse()) {
        dispose();
      }
      disposers.length = 0;
    });
  }

  if (typeof (ctx as { inject?: unknown }).inject === "function") {
    ctx.inject(["skills"], (injected) => {
      injected.effect(() => registerBskSkill(injected, bskPath));
    });
  } else {
    disposers.push(registerBskSkill(ctx, bskPath));
  }

  disposers.push(armAgentScopedBskSkill(ctx, bskPath));
}

export {
  armAgentScopedBskSkill,
  buildDshSkillContent,
  ensureBskInPath,
  registerBskSkill,
  resolveBskExecutable,
};
