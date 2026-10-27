import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBskSmokeTask } from "../lib/bsk-runner.mjs";
import { validateCaseManifest } from "../lib/case-loader.mjs";

const manifest = JSON.parse(
  await readFile(
    new URL("../cases/regression/fill-editor-roots/fill-editor-roots.case.json", import.meta.url),
    "utf8",
  ),
);

test("fill manifests permit empty/whitespace values and validate rejection options", () => {
  for (const value of ["", " ", "\n"]) {
    const copy = structuredClone(manifest);
    copy.smoke.steps = [{ action: "fill", selector: "#editor", value, noClear: true }];
    assert.deepEqual(validateCaseManifest(copy), []);
  }
  for (const step of [
    { action: "fill", selector: "#editor", value: 1 },
    { action: "fill", selector: "#editor", value: "", noClear: "true" },
    { action: "fill", selector: "#editor", value: "", expectError: { code: "invalid_params" } },
    {
      action: "click",
      selector: "#editor",
      expectError: { code: "invalid_params", reason: "target_not_fillable" },
    },
  ]) {
    const copy = structuredClone(manifest);
    copy.smoke.steps = [step];
    assert.notDeepEqual(validateCaseManifest(copy), []);
  }
});

for (const mode of [
  "expected",
  "wrong-code",
  "wrong-reason",
  "success",
  "timeout",
  "spawn-error",
  "malformed",
]) {
  test(`fill rejection workflow: ${mode}`, async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "fill-workflow-"));
    const calls = [];
    try {
      const report = await runBskSmokeTask({
        bskCommand: "bsk",
        outputDirectory,
        server: { reset() {}, snapshot: () => ({ events: [] }) },
        serverInfo: { baseUrl: "http://localhost:4173" },
        runId: "fill-test",
        task: {
          id: "fill-test",
          suite: "regression",
          tags: [],
          startPath: "/fill-editor-roots",
          siteAssertions: [],
          responseAssertions: [],
          adapterAssertions: [],
          smokeSteps: [
            {
              action: "fill",
              selector: "#editor",
              value: "",
              noClear: true,
              expectError: { code: "invalid_params", reason: "target_not_fillable" },
              evidence: "rejected",
            },
          ],
        },
        executeProcess: async (_command, args) => {
          calls.push(args);
          let response = {};
          if (args[0] === "session" && args[1] === "start") response = { session_id: "test" };
          if (args[0] === "session" && args[1] === "stop") response = { stopped: ["test"] };
          if (args[0] !== "fill")
            return { exitCode: 0, stdout: JSON.stringify(response), stderr: "" };
          assert.equal(args[args.indexOf("--value") + 1], "");
          assert.ok(args.includes("--no-clear"));
          return {
            exitCode: mode === "success" ? 0 : 1,
            stdout: "{}",
            timedOut: mode === "timeout",
            error: mode === "spawn-error" ? "spawn failed" : undefined,
            stderr:
              mode === "malformed"
                ? "not JSON"
                : JSON.stringify({
                    code: mode === "wrong-code" ? "cdp_failed" : "invalid_params",
                    data: {
                      reason: mode === "wrong-reason" ? "fill_failed" : "target_not_fillable",
                    },
                  }),
          };
        },
      });
      assert.equal(report.executionError === undefined, mode === "expected");
      assert.equal(report.evidence.rejected === true, mode === "expected");
      assert.equal(report.evidence.sessionStopped, true);
      assert.ok(calls.some((args) => args[0] === "session" && args[1] === "stop"));
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
}
