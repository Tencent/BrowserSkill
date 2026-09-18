// @vitest-environment node
// Native IndexedDB coverage; uses an isolated Chrome profile, never the user's extension.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.BSK_CLICK_CHROME)("browser-local debug history", () => {
  it("survives reload, recovers interrupted checkpoints, expires and bounds records, and deletes atomically", async () => {
    const script = ts.transpileModule(
      readFileSync(new URL("../archive.ts", import.meta.url), "utf8"),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      },
    ).outputText;
    const server = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url === "/archive.js" ? "text/javascript" : "text/html",
      );
      response.end(
        request.url === "/archive.js"
          ? script
          : "<!doctype html><title>Debug history storage</title>",
      );
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
        async (send: (method: string, params?: object, sessionId?: string) => Promise<any>) => {
          const { targetId } = await send("Target.createTarget", { url });
          const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
          await send("Page.enable", {}, sessionId);
          await send("Page.navigate", { url }, sessionId);
          const evaluate = async (expression: string) => {
            const value = await send(
              "Runtime.evaluate",
              { expression, awaitPromise: true, returnByValue: true },
              sessionId,
            );
            expect(value.exceptionDetails).toBeUndefined();
            return value.result.value;
          };
          const result = await evaluate(`(async () => {
          const { LocalDebugArchive, HISTORY_AGE_MS } = await import('/archive.js');
          const now = Date.now();
          const record = (id, at = now, state = 'stopped') => ({ version: 1, saved_at: now,
            run: { id, session_id: 'old', tab_id: 7, name: 'Retained', url: 'https://site.test', started_at: at, stopped_at: at, state, requests: 1, operations: 1, errors: 0, dropped_requests: 0, dropped_operations: 0, dropped_console: 0, coverage: [], next_since: 1, saved_at: now },
            requests: [{ id: id+':n1', run_id: id, state: 'pending', request_body: {state:'available',text:'{"name":"Alice"}'}, response_body:{state:'pending'} }],
            operations: [{ id:id+':a1', state:'running' }], console:[], pages:[] });
          const archive = new LocalDebugArchive(undefined, () => now);
          await archive.put(record('dactive', now, 'capturing'));
          const recovered = new LocalDebugArchive(undefined, () => now);
          const saved = await recovered.get('dactive');
          if (saved.run.state !== 'stopped' || saved.run.stop_reason !== 'browser_restarted' || saved.requests[0].response_body.state !== 'unavailable' || saved.operations[0].state !== 'interrupted') throw Error('checkpoint recovery failed');
          await recovered.put(record('dexpired', now - HISTORY_AGE_MS - 1));
          if (await recovered.get('dexpired')) throw Error('expiry failed');
          for (let i=0;i<52;i++) await recovered.put(record('d'+i, now+i));
          const retained = await recovered.list();
          if (retained.length !== 50 || await recovered.get('d0')) throw Error('count bound failed');
          await recovered.delete('d51');
          if (await recovered.get('d51') || (await recovered.list()).some(r => r.id === 'd51')) throw Error('deletion failed');
          await recovered.put(record('dreload', now+100));
          return { records: (await recovered.list()).length, recovered: saved.run.stop_reason };
        })()`);
          expect(result).toEqual({ records: 50, recovered: "browser_restarted" });
          await send("Page.reload", {}, sessionId);
          // Navigation completion: importing after reload also verifies the database survives a new page context.
          let reloaded: unknown;
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              reloaded = await evaluate(
                `import('/archive.js').then(async ({LocalDebugArchive}) => (await new LocalDebugArchive().get('dreload'))?.requests[0].request_body.text)`,
              );
              if (reloaded) break;
            } catch {
              /* old execution context may disappear during the first probe */
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(reloaded).toBe('{"name":"Alice"}');
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60000);
});
