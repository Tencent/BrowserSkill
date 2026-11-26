/**
 * Lightweight DeepSeek Harness plugin for BrowserSkill (`@wxg-prc-cpg/browser-skill-dsh-plugin`).
 *
 * Registers the canonical BrowserSkill CLI skill (`crates/bsk-cli/skill`),
 * heals `PATH` for default/configured `bsk` installations, and guides on-demand
 * `bsk` CLI + browser extension setup when `bsk` is not yet installed.
 * Browser execution uses the exact same `bsk` CLI + daemon (`DSH_SESSION_ID`
 * implicit scoping) + browser extension architecture as every other agent.
 * On Windows hosts whose Job Object forbids process breakaway (DSH Desktop /
 * Electron) the plugin also supervises its own foreground daemon.
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { type DaemonHandle, ensureManagedDaemon } from "./daemon.mjs";
import { ensureBskInPath, resolveBskExecutable } from "./env.mjs";
import { armAgentScopedBskSkill, buildDshSkillContent, registerBskSkill } from "./skill.mjs";

export const name = "@wxg-prc-cpg/browser-skill-dsh-plugin";

export interface PluginConfig {
  bskPath?: string;
  manageDaemon?: boolean;
}

/** Runtime configuration schema exposed to Cordis and DSH settings UI. */
export const Config = Schema.object({
  bskPath: Schema.string()
    .default("bsk")
    .description(
      "Path to the bsk CLI executable or directory (defaults to resolving `bsk` from PATH or ~/.local/bin).",
    ),
  manageDaemon: Schema.boolean()
    .default(process.platform === "win32")
    .description(
      "Supervise a foreground `bsk daemon start --foreground` child when no daemon is already running. " +
        "Defaults to true on Windows, where DSH Desktop runs inside a Job Object that forbids the " +
        "breakaway `bsk` needs for its detached auto-start (`os error 5`), and false elsewhere, " +
        "where `bsk` can start its own daemon.",
    ),
});

export type Config = PluginConfig;

/**
 * Keep a foreground daemon alive when `bsk` cannot detach one.
 *
 * DSH Desktop (Electron) runs inside a Windows Job Object that does not allow
 * breakaway, so `bsk`'s own background auto-start fails with `os error 5`.
 * This plugin is a long-lived Cordis host, i.e. exactly the persistent task the
 * foreground daemon needs (`docs/sandboxed-agents.md#windows-gui-hosts`).
 * Supervision is best effort: a missing binary or a failed start only logs, and
 * disposal stops only a child this plugin started.
 */
function superviseManagedDaemon(ctx: Context, bskPath: string, enabled: boolean): () => void {
  if (!enabled) {
    return () => {};
  }
  const executable = resolveBskExecutable(bskPath);
  if (executable === null) {
    ctx.logger.info("browser-skill: bsk not found; foreground daemon supervision skipped");
    return () => {};
  }

  let disposed = false;
  let handle: DaemonHandle | null = null;
  void ensureManagedDaemon({
    executable,
    log: (message) => ctx.logger.info(message),
  })
    .then((started) => {
      // The plugin may be disposed while the daemon is still starting up.
      if (disposed) {
        started.dispose();
        return;
      }
      handle = started;
    })
    .catch((error: unknown) => {
      ctx.logger.info(
        `browser-skill: foreground daemon supervision failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

  return () => {
    disposed = true;
    handle?.dispose();
    handle = null;
  };
}

export function apply(ctx: Context, config: Partial<PluginConfig> = {}): void {
  const bskPath = config.bskPath ?? "bsk";
  const manageDaemon = config.manageDaemon ?? process.platform === "win32";
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
  disposers.push(superviseManagedDaemon(ctx, bskPath, manageDaemon));
}

export {
  armAgentScopedBskSkill,
  buildDshSkillContent,
  ensureBskInPath,
  registerBskSkill,
  resolveBskExecutable,
};
