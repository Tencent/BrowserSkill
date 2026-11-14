#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = path.join(REPO_ROOT, "apps", "extension");

export function resolveChromeExecutable(rawValue, envPath = process.env.PATH ?? "") {
  const value = rawValue?.trim();
  if (!value) {
    throw new Error(
      "BSK_TEST_CHROME must be set to a Chrome or Chrome for Testing executable path.",
    );
  }
  if (value.includes("/") || value.includes("\\")) {
    const resolved = path.resolve(value);
    if (!existsSync(resolved)) {
      throw new Error(`BSK_TEST_CHROME does not exist: ${resolved}`);
    }
    return resolved;
  }
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const entry of envPath.split(path.delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `${value}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`BSK_TEST_CHROME command not found on PATH: ${value}`);
}

export function normalizeTargetArgs(rawArgs) {
  let outputJson = null;
  const targets = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--output-json") {
      outputJson = rawArgs[i + 1];
      if (!outputJson) throw new Error("--output-json requires a file path");
      i += 1;
      continue;
    }
    if (arg.startsWith("--output-json=")) {
      outputJson = arg.slice("--output-json=".length);
      if (!outputJson) throw new Error("--output-json requires a file path");
      continue;
    }
    if (path.isAbsolute(arg)) {
      if (path.resolve(arg) === REPO_ROOT) {
        targets.push(".");
        continue;
      }
      const rel = path.relative(EXT_DIR, arg).replaceAll("\\", "/");
      if (!rel.startsWith("../") && rel !== "..") {
        const cleaned = rel.replace(/^\.\//, "").replace(/\/+$/, "");
        targets.push(cleaned || ".");
        continue;
      }
    }
    const normalized = arg.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized || normalized === "." || normalized === "apps/extension") {
      targets.push(".");
      continue;
    }
    targets.push(
      normalized.startsWith("apps/extension/")
        ? normalized.slice("apps/extension/".length)
        : normalized,
    );
  }
  return { outputJson, targets };
}

function toSuiteRelativePath(rawName) {
  if (typeof rawName !== "string" || !rawName) return "";
  if (path.isAbsolute(rawName)) {
    const rel = path.relative(EXT_DIR, rawName).replaceAll("\\", "/");
    if (!rel.startsWith("../") && rel !== "..") {
      return rel;
    }
  }
  const stripped = rawName.replaceAll("\\", "/").replace(/^\.\//, "");
  return stripped.startsWith("apps/extension/")
    ? stripped.slice("apps/extension/".length)
    : stripped;
}

function targetMatchesSuite(target, suitePath) {
  if (target === ".") return Boolean(suitePath);
  const cleanTarget = target.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleanTarget || !suitePath) return false;
  return (
    suitePath === cleanTarget ||
    suitePath.endsWith(`/${cleanTarget}`) ||
    suitePath.startsWith(`${cleanTarget}/`)
  );
}

export function validateVitestReport(report, targets = []) {
  if (!report || typeof report !== "object") {
    throw new Error("Vitest did not produce a valid JSON report.");
  }
  const suites = Array.isArray(report.testResults) ? report.testResults : [];
  if (suites.length === 0 || !(report.numTotalTests > 0)) {
    throw new Error("Zero browser tests ran; check target paths and test discovery.");
  }
  if (report.success !== true || report.numFailedTests > 0 || report.numFailedTestSuites > 0) {
    throw new Error(
      `Browser test failures detected (failedTests=${report.numFailedTests}, failedSuites=${report.numFailedTestSuites}).`,
    );
  }
  const skippedCount = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  if (skippedCount > 0) {
    throw new Error(
      `Zero-skip browser gate violated: ${skippedCount} test(s) were skipped or marked todo.`,
    );
  }
  if (!(report.numPassedTests > 0)) {
    throw new Error("Zero browser tests passed; check target paths and test discovery.");
  }
  const suitePaths = [];
  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    if (assertions.length === 0) {
      throw new Error(`Suite executed 0 assertions (silent skip): ${suite.name ?? "<unknown>"}`);
    }
    const nonPassing = assertions.filter((item) => item.status !== "passed");
    if (nonPassing.length > 0) {
      const summary = nonPassing.map((item) => `${item.fullName} [${item.status}]`).join(", ");
      throw new Error(`Zero-skip browser gate violated in ${suite.name}: ${summary}`);
    }
    suitePaths.push(toSuiteRelativePath(suite.name));
  }
  if (targets.length > 0) {
    const unmatched = targets.filter(
      (target) => !suitePaths.some((suitePath) => targetMatchesSuite(target, suitePath)),
    );
    if (unmatched.length > 0) {
      throw new Error(
        `Target(s) matched zero executed browser test suites: ${unmatched.join(", ")}`,
      );
    }
  }
}

function main() {
  const chromePath = resolveChromeExecutable(process.env.BSK_TEST_CHROME);
  const { outputJson, targets } = normalizeTargetArgs(process.argv.slice(2));
  const extRequire = createRequire(path.join(EXT_DIR, "package.json"));
  const vitestCli = path.join(
    path.dirname(extRequire.resolve("vitest/package.json")),
    "vitest.mjs",
  );

  const tempDir = outputJson ? null : mkdtempSync(path.join(tmpdir(), "bsk-vitest-browser-"));
  const reportPath = outputJson
    ? path.resolve(outputJson)
    : path.join(tempDir, "vitest-browser-report.json");
  mkdirSync(path.dirname(reportPath), { recursive: true });

  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestCli,
        "run",
        "--config",
        "vitest.browser.config.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
        ...targets.filter((target) => target !== "."),
      ],
      {
        cwd: EXT_DIR,
        env: { ...process.env, BSK_TEST_CHROME: chromePath },
        stdio: "inherit",
      },
    );
    if (!existsSync(reportPath)) {
      process.exit(result.status || 1);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    validateVitestReport(report, targets);
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[run-browser-tests] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
