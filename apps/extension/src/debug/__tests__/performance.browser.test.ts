// @vitest-environment node
// Owns its Chrome profile and local server; never operates user tabs.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { installPerformance } from "../performance-observer";
import type { DebugPerformance } from "../types";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  session?: string,
) => Promise<T>;
describe.skipIf(!process.env.BSK_CLICK_CHROME)("native performance capture", () => {
  it("installs before navigation, captures browser metrics, survives reload and reports hidden/late capture", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Performance fixture</title><h1>Page ready</h1><p id="content">Visible content for paint timing</p><script>
        setTimeout(()=>{const until=performance.now()+90;while(performance.now()<until){};document.querySelector('h1').style.marginTop='180px';},1200);
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_CLICK_CHROME,
          deviceScale: 1,
          zoom: 1,
          startupTimeout: 30000,
        },
        async (send: Send) => {
          const create = async (background = false) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: "about:blank",
              background,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            await send("Page.enable", {}, sessionId);
            return { targetId, sessionId };
          };
          const world = "bsk-performance-test";
          const script = (early: boolean) =>
            `globalThis.__capture=(${installPerformance.toString()})(()=>{},${early});`;
          const read = async (session: string, expression = "globalThis.__capture.snapshot()") => {
            const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>(
              "Page.getFrameTree",
              {},
              session,
            );
            const { executionContextId } = await send<{ executionContextId: number }>(
              "Page.createIsolatedWorld",
              { frameId: frameTree.frame.id, worldName: world },
              session,
            );
            const result = await send<{
              result: { value: DebugPerformance };
              exceptionDetails?: unknown;
            }>(
              "Runtime.evaluate",
              { expression, contextId: executionContextId, returnByValue: true },
              session,
            );
            expect(result.exceptionDetails).toBeUndefined();
            return result.result.value;
          };
          const front = await create();
          await send("Target.activateTarget", { targetId: front.targetId });
          await send(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: script(true), worldName: world },
            front.sessionId,
          );
          await send("Page.navigate", { url }, front.sessionId);
          let visible!: DebugPerformance;
          await vi.waitFor(
            async () => {
              visible = await read(front.sessionId);
              expect(visible.metrics.load_ms.value).toBeGreaterThan(0);
              expect(visible.metrics.fcp_ms.value).toBeGreaterThan(0);
              expect(visible.metrics.lcp_ms.value).toBeGreaterThan(0);
              expect(visible.metrics.long_task_count.value).toBeGreaterThan(0);
              expect(visible.metrics.cls.value).toBeGreaterThan(0);
            },
            { timeout: 7000, interval: 100 },
          );
          expect(visible.early).toBe(true);
          expect(visible.metrics.cls.state).toBe("provisional");
          const key = visible.document_key;
          await send("Page.reload", {}, front.sessionId);
          await vi.waitFor(
            async () => {
              const reloaded = await read(front.sessionId);
              expect(reloaded.document_key).not.toBe(key);
              expect(reloaded.navigation).toBe("reload");
              expect(reloaded.metrics.load_ms.value).toBeGreaterThan(0);
            },
            { timeout: 5000 },
          );
          await read(
            front.sessionId,
            `globalThis.__capture.dispose();${script(false)};globalThis.__capture.snapshot()`,
          );
          const late = await read(front.sessionId);
          expect(late.early).toBe(false);
          expect(late.coverage).toContain("visibility_before_capture_unknown");
          expect(late.metrics.cls.state).toBe("partial");
          const back = await create(true);
          await send(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: script(true), worldName: world },
            back.sessionId,
          );
          await send("Page.navigate", { url }, back.sessionId);
          await vi.waitFor(
            async () =>
              expect((await read(back.sessionId)).metrics.load_ms.value).toBeGreaterThan(0),
            { timeout: 5000 },
          );
          const hidden = await read(back.sessionId);
          expect(hidden.visibility[0].state).toBe("hidden");
          expect(hidden.metrics.fcp_ms).toMatchObject({
            state: "unavailable",
            reasons: ["initially_hidden"],
          });
          await send("Target.activateTarget", { targetId: back.targetId });
          await vi.waitFor(async () =>
            expect((await read(back.sessionId)).visibility.at(-1)?.state).toBe("visible"),
          );
          const finished = await read(back.sessionId, "globalThis.__capture.finish()");
          expect(finished.state).toBe("completed");
          expect(finished.metrics.cls.state).toBe("partial");
          await read(back.sessionId, "globalThis.__capture.dispose();({})");
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30000);
});
