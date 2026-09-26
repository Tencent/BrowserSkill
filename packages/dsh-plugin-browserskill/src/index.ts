/**
 * dsh-plugin-browserskill — a DeepSeek Harness bundle that registers
 * BrowserSkill (`bsk`) browser automation as model-visible tools.
 *
 * Each tool spawns `bsk <cmd> --json`, parses the structured output, and
 * returns a canonical JSON value. The plugin tracks the sessions it starts so
 * one agent conversation can drive several browsers at once; unloading the
 * plugin stops every tracked session and kills any in-flight bsk children.
 *
 * @module dsh-plugin-browserskill
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { armArchiveCleanup } from "./archive-cleanup";
import { registerBrowserTools } from "./browser-tools";
import { armLazyTools } from "./lazy-tools";
import { ObservationService } from "./observation";
import { registerObservationRoutes } from "./observation-http";
import { KeyedExecutor } from "./queue";
import { type BskRunner, createBskRunner, parseBskJson } from "./runner";
import { SessionStarts } from "./session-starts";
import { SessionRegistry } from "./sessions";
import { armAgentScopedBskSkill, registerBskSkill } from "./skill";
import { DiskStartJournal, defaultStartJournalDirectory, type StartJournal } from "./start-journal";
import type { PluginConfig, ToolDeps } from "./tools";

export const name = "@wxg-prc-cpg/browser-skill-dsh-plugin";
export const inject = ["tools"];

/** Runtime configuration schema (validated and defaulted by Cordis). */
export const Config = Schema.object({
  bskPath: Schema.string()
    .default("bsk")
    .description("Path to the bsk CLI binary (defaults to resolving `bsk` from PATH)."),
  sessionStateDirectory: Schema.string().description(
    "Directory for durable browser start recovery records; defaults to BSK_HOME/dsh-starts scoped by working directory and CLI.",
  ),
  defaultTimeoutMs: Schema.number()
    .default(120_000)
    .description(
      "Default command execution timeout in milliseconds. Collecting output after exit may take up to 2 additional seconds.",
    ),
  maxSessions: Schema.number()
    .default(5)
    .description("Maximum number of concurrent browser sessions started through this plugin."),
  observationEnabled: Schema.boolean()
    .default(true)
    .description("Track per-session observation state (action/url/thumbnail) for the PiP overlay."),
  thumbnailIntervalMs: Schema.number()
    .default(1500)
    .description("Thumbnail refresh cadence for active sessions (milliseconds)."),
  idleIntervalMs: Schema.number()
    .default(8000)
    .description("Thumbnail refresh cadence for idle sessions; also the recent-activity window."),
  lazyTools: Schema.boolean()
    .default(true)
    .description(
      "Reveal the browser_* tools only after the browser-skill skill is invoked (default true); " +
        "false registers the full suite at load.",
    ),
});

export type Config = PluginConfig;

/** Test seams: swap the process runner (unit tests never spawn a real bsk). */
export interface ApplyOptions {
  runnerFactory?: (bskPath: string) => BskRunner;
  startJournal?: StartJournal;
}

/** Renew this plugin instance's daemon leases and invalidate stale local handles. */
export async function renewSessionLeases(
  runner: BskRunner,
  registry: SessionRegistry,
  ownerId: string,
): Promise<string[]> {
  const result = await runner.run(["session", "lease", "--owner", ownerId, "--ttl-ms", "60000"], {
    timeoutMs: 10_000,
  });
  const reply = parseBskJson(result, "session lease");
  const sessionIds =
    typeof reply === "object" &&
    reply !== null &&
    "session_ids" in reply &&
    Array.isArray(reply.session_ids) &&
    reply.session_ids.every((id) => typeof id === "string")
      ? reply.session_ids
      : null;
  if (sessionIds === null) throw new Error("bsk session lease returned invalid session_ids");

  const renewed = new Set(sessionIds);
  const missing = registry.ownedIds().filter((sessionId) => !renewed.has(sessionId));
  for (const sessionId of missing) registry.markForCleanup(sessionId);
  return missing;
}

export function apply(
  ctx: Context,
  config: Partial<PluginConfig> = {},
  options: ApplyOptions = {},
): void {
  const resolved: PluginConfig = {
    bskPath: config.bskPath ?? "bsk",
    sessionStateDirectory: config.sessionStateDirectory,
    defaultTimeoutMs: config.defaultTimeoutMs ?? 120_000,
    maxSessions: config.maxSessions ?? 5,
    observationEnabled: config.observationEnabled ?? true,
    thumbnailIntervalMs: config.thumbnailIntervalMs ?? 1500,
    idleIntervalMs: config.idleIntervalMs ?? 8000,
    lazyTools: config.lazyTools ?? true,
  };
  const runner = options.runnerFactory?.(resolved.bskPath) ?? createBskRunner(resolved.bskPath);
  const registry = new SessionRegistry(resolved.maxSessions);
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx,
    runner,
    registry,
    queue,
    options: {
      enabled: resolved.observationEnabled,
      thumbnailIntervalMs: resolved.thumbnailIntervalMs,
      idleIntervalMs: resolved.idleIntervalMs,
    },
  });

  const leaseOwnerId = `dsh:${process.pid}:${randomUUID()}`;
  const deps: ToolDeps = {
    ctx,
    runner,
    registry,
    config: resolved,
    observation,
    queue,
    leaseOwnerId,
  };
  const journal =
    options.startJournal ??
    new DiskStartJournal(
      resolved.sessionStateDirectory ?? defaultStartJournalDirectory(resolved.bskPath),
    );
  if (journal instanceof DiskStartJournal) journal.recover();
  const starts = (deps.starts = new SessionStarts(deps, journal));
  void starts.reconcile().catch((error) => console.warn("Browser start recovery failed", error));
  let leaseRenewalWarningActive = false;
  const leaseTimer = setInterval(() => {
    if (registry.size() === 0) {
      leaseRenewalWarningActive = false;
      return;
    }
    void renewSessionLeases(runner, registry, leaseOwnerId)
      .then((missing) => {
        if (missing.length > 0) {
          if (!leaseRenewalWarningActive) {
            console.warn(
              `Browser session lease renewal no longer recognizes ${missing.join(", ")}; ` +
                "marked unavailable until cleanup",
            );
          }
          leaseRenewalWarningActive = true;
          return;
        }
        leaseRenewalWarningActive = false;
      })
      .catch((error) => {
        // Avoid a warning storm while still leaving a diagnostic breadcrumb.
        // A successful retry clears the guard and makes a later outage visible.
        if (!leaseRenewalWarningActive) {
          leaseRenewalWarningActive = true;
          console.warn("Browser session lease renewal failed; retrying in 20s", error);
        }
      });
  }, 20_000);
  leaseTimer.unref();
  const stopDisposed =
    typeof ctx.on === "function"
      ? ctx.on("agent/disposed", ({ agent }) => {
          starts.archive(agent.id);
        })
      : () => {};

  // Progressive disclosure of the BSK agent skill (catalog entry resident,
  // body on demand) through the official skill seam; silent no-op when the
  // composition lacks it. With lazyTools on, the skill entry is initially the
  // ONLY model-visible advertisement — the tool suite reveals itself on a
  // successful skill invocation (or a session whose history already has one).
  const unregisterSkill = registerBskSkill(ctx);
  // A same-name CLI skill left in ~/.agents is discovered in the nearer preset
  // layer and shadows the global registration above. Re-register through every
  // exact agent context at startup so DSH always loads the browser_* protocol
  // instructions; the shared CLI skill remains untouched for other agents.
  const disarmAgentSkill = armAgentScopedBskSkill(ctx);
  const registerSuite = () => registerBrowserTools(deps);
  const removeSuite = resolved.lazyTools ? armLazyTools(ctx, registerSuite) : registerSuite();
  // Route registration rides ctx.inject: the webServer service may be provided
  // AFTER this plugin loads, and in headless compositions it never appears (the
  // callback simply never runs, leaving the rest of the plugin unaffected).
  let removeRoutes: () => void = () => {};
  ctx.inject(["webServer"], (injected) => {
    removeRoutes = registerObservationRoutes(injected, observation, starts);
    return () => removeRoutes();
  });
  // Reap a conversation's browsers when the conversation itself is archived:
  // archived sessions are hidden from every surface, so their Agent Windows
  // would otherwise linger unreachable until idle timeout or unload.
  const disarmArchiveCleanup = armArchiveCleanup(ctx, starts);

  // Non-blocking install probe: warn early when bsk is missing instead of
  // failing the first tool call with a bare spawn error. Uses --version on
  // purpose — it answers without starting the daemon (`bsk status` would
  // ensure-spawn one, an expensive side effect for a probe).
  runner.run(["--version"], { timeoutMs: 10_000 }).then(
    () => {},
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[${name}] bsk probe failed (${detail}); browser tools will report install guidance until the bsk CLI is available`,
      );
    },
  );

  // Unload cleanup: kill in-flight children, then stop every session this
  // plugin OWNS (created via browser_session action=start). Referenced or unknown
  // sessions belonging to other programs on the shared daemon are never
  // touched; per-stop failures (already stopped externally, daemon restart)
  // are swallowed so one stale handle cannot abort the rest.
  ctx.effect(() => {
    return () => {
      removeSuite();
      clearInterval(leaseTimer);
      stopDisposed();
      disarmAgentSkill();
      unregisterSkill();
      removeRoutes();
      disarmArchiveCleanup();
      return starts.dispose().then(() => observation.dispose());
    };
  });
}

export { armArchiveCleanup, ownerSessionIds } from "./archive-cleanup";
export { registerBrowserTools } from "./browser-tools";
export type { ObservationEvent, ObservationOptions, SessionObservation } from "./observation";
export { ObservationService } from "./observation";
export { registerObservationRoutes } from "./observation-http";
export { KeyedExecutor } from "./queue";
export type { BskRunner, BskRunResult, SpawnImpl } from "./runner";
export { BskError, createBskRunner } from "./runner";
export { SessionRegistry } from "./sessions";
export type { PluginConfig, ToolDeps } from "./tools";
