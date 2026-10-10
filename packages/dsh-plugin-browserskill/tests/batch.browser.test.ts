import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { it } from "vitest";
import { ObservationService } from "../src/observation";
import { KeyedExecutor } from "../src/queue";
import { createBskRunner } from "../src/runner";
import { SessionRegistry } from "../src/sessions";
import { createBrowserOperationDefinitions, type ToolDeps } from "../src/tools";

function batchRunner({
  bskPath,
  env,
  sessionId,
}: {
  bskPath: string;
  env: Record<string, string>;
  sessionId: string;
}) {
  const runner = createBskRunner(bskPath, (command, args, options) =>
    spawn(command, args, { ...options, env: { ...process.env, ...options?.env, ...env } }),
  );
  const registry = new SessionRegistry(1);
  registry.completeStart({ sessionId, startedAtMs: Date.now() });
  const queue = new KeyedExecutor();
  const ctx = { get: () => undefined } as unknown as ToolDeps["ctx"];
  const observation = new ObservationService({
    ctx,
    runner,
    registry,
    queue,
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const deps: ToolDeps = {
    ctx,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath,
      defaultTimeoutMs: 120_000,
      maxSessions: 1,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  };
  const batch = createBrowserOperationDefinitions(deps).find(
    (tool) => tool.name === "interact.batch",
  )!;
  return async (args: object) => {
    try {
      return await batch.execute(
        args as never,
        { signal: new AbortController().signal } as ToolRunContext,
      );
    } finally {
      observation.dispose();
      runner.killAll();
    }
  };
}

/** Opt-in: the production CLI, daemon and loaded MV3 extension in a fresh browser. */
it.runIf(!!process.env.BSK_BATCH_CHROME)(
  "measures the three paths and verifies audited single-action recovery",
  async () => {
    const { runBenchmark } = await import(
      new URL("../../../evals/browser/benchmarks/known-actions.mjs", import.meta.url).href
    );
    await runBenchmark({
      chrome: process.env.BSK_BATCH_CHROME,
      bskCommand: process.env.BSK_BATCH_CLI,
      samples: Number(process.env.BSK_BATCH_SAMPLES ?? "20"),
      out: process.env.BSK_BATCH_OUT,
      createBatchRunner: batchRunner,
      async afterTrials({ send, bsk, bskPath, env, server, serverInfo }: any) {
        // Use the isolated extension's own page to enable and read its audit API.
        const { targetInfos } = await send("Target.getTargets");
        const worker = targetInfos.find(
          (target: any) =>
            target.type === "service_worker" &&
            target.url.startsWith("chrome-extension://") &&
            target.url.endsWith("/background.js"),
        );
        assert(worker, "extension service worker is available");
        // URL.origin for a non-special scheme is null; preserve scheme + host.
        const auditUrl = `chrome-extension://${new URL(worker.url).host}/audit.html`;
        const { sessionId: workerSession } = await send("Target.attachToTarget", {
          targetId: worker.targetId,
          flatten: true,
        });
        await send(
          "Runtime.evaluate",
          {
            expression: `chrome.tabs.create({url: ${JSON.stringify(auditUrl)}})`,
            awaitPromise: true,
          },
          workerSession,
        );
        const targets = await send("Target.getTargets");
        const { targetId } = targets.targetInfos.find((target: any) => target.url === auditUrl);
        await send("Target.detachFromTarget", { sessionId: workerSession });
        const { sessionId: cdpSession } = await send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const evaluate = async (expression: string) => {
          const result = await send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            cdpSession,
          );
          assert(!result.exceptionDetails, JSON.stringify(result));
          return result.result.value;
        };
        const deadline = Date.now() + 10_000;
        while (!(await evaluate("typeof chrome.runtime?.sendMessage === 'function'"))) {
          assert(
            Date.now() < deadline,
            `audit page loaded: ${await evaluate("location.href + document.body?.innerText")}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const audit = async (params: object) => {
          const response = await evaluate(
            `chrome.runtime.sendMessage(${JSON.stringify({ kind: "bsk_audit", ...params })})`,
          );
          assert(response.ok, JSON.stringify(response));
          return response.data;
        };
        await audit({ action: "configure", enabled: true });
        const session = await bsk([
          "session",
          "start",
          "--name",
          "batch recovery audit",
          "--no-focus",
        ]);
        const scoped = ["--session", session.session_id];
        try {
          await bsk(["navigate", `${serverInfo.baseUrl}/form?run=recovery`, ...scoped]);
          const observed = await bsk(["observe", ...scoped]);
          const ref = (text: string, name: string) => {
            const line = text
              .split("\n")
              .find((line) => /@e\d+ /.test(line) && line.includes(`"${name}`));
            assert(line, name);
            return line.match(/@e\d+/)![0];
          };
          // A removed control must fail through the original single-action path.
          await bsk([
            "evaluate",
            "document.querySelector('#notes').addEventListener('input', () => document.querySelector('#choice')?.remove())",
            ...scoped,
          ]);
          const run = batchRunner({ bskPath, env, sessionId: session.session_id });
          const result: any = await run({
            session: session.session_id,
            tabId: observed.tab_id,
            steps: [
              {
                action: "fill",
                target: ref(observed.text, "Text input"),
                value: "SYNTHETIC-PRIVATE-VALUE",
              },
              { action: "fill", target: ref(observed.text, "Textarea"), value: "recovered" },
              { action: "select", target: ref(observed.text, "Dropdown"), values: ["two"] },
              { action: "click", target: ref(observed.text, "Submit") },
            ],
          });
          assert.equal(result.status, "stopped", JSON.stringify(result));
          assert.deepEqual(
            result.steps.map((step: any) => step.status),
            ["completed", "completed", "failed", "not_run"],
          );
          assert.equal(
            server
              .snapshot("recovery")
              .events.filter((event: any) => event.type === "form.submitted").length,
            0,
          );
          // Repair only the synthetic fixture; keep both successfully filled values.
          await bsk([
            "evaluate",
            "document.querySelector('form').insertAdjacentHTML('beforeend', '<label>Restored choice<select name=choice><option value=one>One</option><option value=two>Two</option></select></label>')",
            ...scoped,
          ]);
          const fresh = await bsk(["observe", ...scoped]);
          await bsk(["select", ref(fresh.text, "Restored choice"), "--value", "two", ...scoped]);
          await bsk(["click", ref(fresh.text, "Submit"), ...scoped]);
          const submissions = server
            .snapshot("recovery")
            .events.filter((event: any) => event.type === "form.submitted");
          assert.equal(submissions.length, 1);
          assert.deepEqual(submissions[0].data, {
            text: "SYNTHETIC-PRIVATE-VALUE",
            notes: "recovered",
            choice: "two",
          });
          const list = await audit({ action: "list" });
          const detail = await audit({ action: "get", id: list.runs[0].id, limit: 500 });
          const events = detail.events as {
            kind: string;
            operation_id: string;
            data: Record<string, unknown>;
          }[];
          const actions = events.filter(
            (event) =>
              event.kind === "operation_started" &&
              ["tool.fill", "tool.select", "tool.click"].includes(String(event.data.method)),
          );
          assert.deepEqual(
            actions.map((event) => event.data.method),
            ["tool.fill", "tool.fill", "tool.select", "tool.select", "tool.click"],
          );
          assert.deepEqual(
            actions.map(
              (action) =>
                events.find(
                  (event) =>
                    event.operation_id === action.operation_id &&
                    event.kind === "operation_finished",
                )?.data.status,
            ),
            ["completed", "completed", "error", "completed", "completed"],
          );
          for (const action of actions) {
            assert(action.data.target, "observed ref is recorded");
            assert(
              events.some(
                (event) =>
                  event.operation_id === action.operation_id &&
                  event.kind === "context" &&
                  event.data.target,
              ),
              "cached element name is recorded",
            );
            assert(
              events.some(
                (event) =>
                  event.operation_id === action.operation_id &&
                  event.kind === "operation_finished" &&
                  event.data.status,
              ),
              "outcome is recorded",
            );
          }
          assert(
            !JSON.stringify(events).includes("SYNTHETIC-PRIVATE-VALUE"),
            "input values never reach audit storage",
          );
          await send("Page.navigate", { url: `${auditUrl}?id=${detail.run.id}` }, cdpSession);
          const uiDeadline = Date.now() + 10_000;
          while (true) {
            const text = String(await evaluate("document.body?.innerText ?? ''"));
            if (
              ["Text input", "Textarea", "Dropdown", "Restored choice", "Submit"].every((name) =>
                text.includes(name),
              )
            ) {
              assert(!text.includes("tool.fill"), "audit uses the existing localized method names");
              break;
            }
            assert(Date.now() < uiDeadline, `audited steps visible: ${text}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          console.log(
            "Recovery/audit: two completed fills retained, removed select stopped batch, single actions submitted once; five action records with refs, names and statuses; inputs redacted.",
          );
        } finally {
          await bsk(["session", "stop", session.session_id]);
        }
        if (process.env.BSK_BATCH_SMOKE === "1") {
          const { runProcess } = await import(
            new URL("../../../evals/browser/lib/process.mjs", import.meta.url).href
          );
          const root = fileURLToPath(new URL("../../../", import.meta.url));
          for (const suite of ["core", "matrix"]) {
            const result = await runProcess(
              process.execPath,
              [
                "evals/browser/cli.mjs",
                "smoke",
                "--suite",
                suite,
                "--bsk",
                bskPath,
                ...(suite === "matrix" ? ["--seed", "4,7,14"] : []),
              ],
              { cwd: root, env },
            );
            assert.equal(result.exitCode, 0, result.stdout + result.stderr);
            console.log(result.stdout);
          }
        }
      },
    });
  },
  600_000,
);
