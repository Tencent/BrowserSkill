function durationFor(result) {
  if (result.execution?.durationMs !== undefined) return result.execution.durationMs;
  return (result.steps ?? []).reduce((sum, step) => sum + step.durationMs, 0);
}

export function summarizeReports(reports) {
  const groups = new Map();
  for (const report of reports) {
    for (const result of report.results ?? []) {
      const adapter = result.adapter ?? report.adapter ?? "unknown";
      const variant = result.variant ?? report.variant ?? "unspecified";
      const key = `${adapter}\u0000${variant}`;
      if (!groups.has(key)) {
        groups.set(key, {
          adapter,
          variant,
          runs: 0,
          passed: 0,
          fullyVerified: 0,
          executionFailures: 0,
          errors: 0,
          durationMs: 0,
          toolCalls: 0,
          toolCallSamples: 0,
        });
      }
      const group = groups.get(key);
      group.runs += 1;
      group.durationMs += durationFor(result);
      group.errors += result.metrics?.errorCount ?? (result.executionError ? 1 : 0);
      if (result.metrics?.toolCallCount !== null && result.metrics?.toolCallCount !== undefined) {
        group.toolCalls += result.metrics.toolCallCount;
        group.toolCallSamples += 1;
      }
      const executionFailed =
        Boolean(result.executionError) ||
        result.execution?.timedOut ||
        (result.execution?.exitCode !== undefined && result.execution.exitCode !== 0);
      if (executionFailed) group.executionFailures += 1;
      if (result.verification?.status !== "failed" && !executionFailed) group.passed += 1;
      if (result.verification?.status === "passed" && !executionFailed) group.fullyVerified += 1;
    }
  }

  return [...groups.values()].map((group) => ({
    adapter: group.adapter,
    variant: group.variant,
    runs: group.runs,
    passRate: group.runs ? group.passed / group.runs : 0,
    fullyVerifiedRate: group.runs ? group.fullyVerified / group.runs : 0,
    executionFailures: group.executionFailures,
    errors: group.errors,
    averageToolCalls: group.toolCallSamples
      ? Math.round((group.toolCalls / group.toolCallSamples) * 10) / 10
      : null,
    averageDurationMs: group.runs ? Math.round(group.durationMs / group.runs) : 0,
  }));
}

export function printSummary(rows) {
  const printable = rows.map((row) => ({
    adapter: row.adapter,
    variant: row.variant,
    runs: row.runs,
    pass: `${Math.round(row.passRate * 100)}%`,
    verified: `${Math.round(row.fullyVerifiedRate * 100)}%`,
    exec_failures: row.executionFailures,
    errors: row.errors,
    avg_tools: row.averageToolCalls ?? "-",
    avg_ms: row.averageDurationMs,
  }));
  console.table(printable);
}
