import type { ToolDefinition, ToolResult, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { ToolDeps } from "./tools";

export type ToolRegistrar = (definition: ToolDefinition) => void;

type TerminalPresentation = { card: "terminal"; output: string; exitCode: number } | undefined;

/** Existing tool runtime seams reused by the phase-one capability modules. */
export interface PhaseOneRuntime {
  run(
    exec: ToolRunContext,
    args: string[],
    label: string,
    observeSession?: string,
    runnerTimeoutMs?: number,
  ): Promise<unknown>;
  commandLine(args: string[]): string;
  presentTerminalResult: (_args: never, result: ToolResult) => TerminalPresentation;
}

export function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}

export function requirePositive(value: number | undefined, name: string): void {
  if (value !== undefined && value <= 0) throw new Error(`${name} must be greater than zero`);
}

/** CLI positional target detection is shared by hover/select/request-help. */
export function isSnapshotRef(target: string): boolean {
  return /^@?e\d+$/.test(target);
}

/**
 * Give the child enough time to honour a command-level timeout plus IPC
 * settlement slack, without shortening the plugin's configured default.
 */
export function runnerTimeout(deps: ToolDeps, commandTimeoutMs: number | undefined): number {
  if (commandTimeoutMs === undefined) return deps.config.defaultTimeoutMs;
  return Math.max(deps.config.defaultTimeoutMs, commandTimeoutMs + 15_000);
}

export function appendTarget(args: string[], target: string): void {
  args.push(target);
}

export function appendTabId(args: string[], tabId: number | undefined): void {
  if (tabId !== undefined) args.push("--tab-id", String(tabId));
}

export function appendWaitOptions(
  args: string[],
  waitUntil: string | undefined,
  timeoutMs: number | undefined,
): void {
  if (waitUntil !== undefined) args.push("--wait-until", waitUntil);
  if (timeoutMs !== undefined) args.push("--timeout", `${timeoutMs}ms`);
}
