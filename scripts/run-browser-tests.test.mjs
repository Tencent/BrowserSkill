import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeTargetArgs, validateVitestReport } from "./run-browser-tests.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "run-browser-tests.mjs");

function collectBrowserSuites(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectBrowserSuites(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".browser.test.ts")) {
      results.push(`src/${path.relative(baseDir, fullPath).split(path.sep).join("/")}`);
    }
  }
  return results.sort();
}

test("fails fast when BSK_TEST_CHROME is unset or missing", () => {
  const unsetEnv = { ...process.env };
  delete unsetEnv.BSK_TEST_CHROME;
  const unsetResult = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: unsetEnv,
    encoding: "utf8",
  });
  assert.notEqual(unsetResult.status, 0);
  assert.match(unsetResult.stderr, /BSK_TEST_CHROME must be set/);

  const missingResult = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: { ...process.env, BSK_TEST_CHROME: "/nonexistent/bsk-chrome-binary" },
    encoding: "utf8",
  });
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /BSK_TEST_CHROME does not exist/);
});

test("normalizes apps/extension prefixes, -- separator, and --output-json flag", () => {
  const parsed = normalizeTargetArgs([
    "--",
    "--output-json",
    "artifacts/report.json",
    "apps/extension/src/video/capture.browser.test.ts",
    path.join(REPO_ROOT, "apps", "extension", "src/tools/__tests__/wheel.browser.test.ts"),
  ]);
  assert.equal(parsed.outputJson, "artifacts/report.json");
  assert.deepEqual(parsed.targets, [
    "src/video/capture.browser.test.ts",
    "src/tools/__tests__/wheel.browser.test.ts",
  ]);
  assert.deepEqual(
    normalizeTargetArgs([
      ".",
      "./",
      "apps/extension",
      "./apps/extension/",
      path.join(REPO_ROOT, "apps", "extension"),
    ]).targets,
    [".", ".", ".", ".", "."],
  );
});

test("enforces zero-skip, non-empty suite assertions, and per-target coverage on Vitest JSON output", () => {
  validateVitestReport(
    {
      success: true,
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: path.join(
            REPO_ROOT,
            "apps",
            "extension",
            "src/tools/__tests__/wheel.browser.test.ts",
          ),
          assertionResults: [
            { fullName: "wheel > scrolls element", status: "passed" },
            { fullName: "wheel > respects zoom", status: "passed" },
          ],
        },
      ],
    },
    [".", "src/tools/__tests__/wheel.browser.test.ts"],
  );

  assert.throws(
    () =>
      validateVitestReport(
        {
          success: true,
          numTotalTests: 1,
          numPassedTests: 1,
          numFailedTests: 0,
          numFailedTestSuites: 0,
          numPendingTests: 0,
          numTodoTests: 0,
          testResults: [
            {
              name: path.join(
                REPO_ROOT,
                "apps",
                "extension",
                "src/tools/__tests__/not-wheel.browser.test.ts",
              ),
              assertionResults: [{ fullName: "other > runs", status: "passed" }],
            },
          ],
        },
        ["src/tools/__tests__/not-wheel.browser.test.ts", "wheel.browser.test.ts"],
      ),
    /Target\(s\) matched zero executed browser test suites: wheel\.browser\.test\.ts/,
  );

  assert.throws(
    () =>
      validateVitestReport({
        success: true,
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        numPendingTests: 1,
        numTodoTests: 0,
        testResults: [
          {
            name: "src/long-screenshot/long-screenshot.browser.test.ts",
            assertionResults: [
              { fullName: "captures local page", status: "passed" },
              { fullName: "captures reported url", status: "pending" },
            ],
          },
        ],
      }),
    /Zero-skip browser gate violated/,
  );

  assert.throws(
    () =>
      validateVitestReport({
        success: true,
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          {
            name: "src/tools/__tests__/wheel.browser.test.ts",
            assertionResults: [{ fullName: "wheel > scrolls", status: "passed" }],
          },
          {
            name: "src/tools/__tests__/silent-if-guard.browser.test.ts",
            assertionResults: [],
          },
        ],
      }),
    /Suite executed 0 assertions/,
  );
});

test("CI workflow executes every .browser.test.ts suite through run-browser-tests.mjs", () => {
  const diskSuites = collectBrowserSuites(path.join(REPO_ROOT, "apps", "extension", "src"));
  assert.ok(diskSuites.length > 0, "expected browser suites under apps/extension/src");

  const ciWorkflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const referencedSuites = [
    ...new Set(ciWorkflow.match(/src\/[A-Za-z0-9_./-]+\.browser\.test\.ts/g) ?? []),
  ].sort();

  const missingInCi = diskSuites.filter((suite) => !referencedSuites.includes(suite));
  const staleInCi = referencedSuites.filter((suite) => !diskSuites.includes(suite));

  assert.deepEqual(
    missingInCi,
    [],
    `Every .browser.test.ts must be wired into .github/workflows/ci.yml; missing: ${missingInCi.join(", ")}`,
  );
  assert.deepEqual(
    staleInCi,
    [],
    `Stale .browser.test.ts paths in .github/workflows/ci.yml: ${staleInCi.join(", ")}`,
  );
  assert.doesNotMatch(
    ciWorkflow,
    /\bBSK_(?!TEST_CHROME\b)[A-Z0-9_]+_CHROME\b/,
    "CI workflow must use BSK_TEST_CHROME rather than legacy per-suite Chrome env vars",
  );
  assert.doesNotMatch(
    ciWorkflow,
    /\bvitest\s+run\b[^\n]*\.browser\.test\.ts/,
    "CI workflow must invoke scripts/run-browser-tests.mjs instead of raw vitest run for browser tests",
  );

  const extPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "apps", "extension", "package.json"), "utf8"),
  );
  assert.match(
    extPkg.scripts?.["test:browser"] ?? "",
    /run-browser-tests\.mjs/,
    "apps/extension test:browser script must route through scripts/run-browser-tests.mjs",
  );
});
