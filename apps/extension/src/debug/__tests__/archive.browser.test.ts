// @vitest-environment node
// Native IndexedDB coverage; uses an isolated Chrome profile, never the user's extension.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.BSK_CLICK_CHROME)("browser-local debug history", () => {
  it("survives reload, recovers interrupted checkpoints, expires and bounds records, and deletes atomically", async () => {
    const scripts = new Map(
      ["archive", "journal", "query", "capabilities", "evidence-model"].map((name) => [
        name,
        ts.transpileModule(readFileSync(new URL(`../${name}.ts`, import.meta.url), "utf8"), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        }).outputText,
      ]),
    );
    const server = createServer((request, response) => {
      const script = scripts.get(request.url?.slice(1).replace(/\.js$/, "") ?? "");
      response.setHeader("Content-Type", script ? "text/javascript" : "text/html");
      response.end(script ?? "<!doctype html><title>Debug history storage</title>");
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
          // Upgrade a real v1 database without deleting its old recording stores.
          const legacy = await new Promise((resolve,reject)=>{const r=indexedDB.open('bsk-debug-history',1);r.onupgradeneeded=()=>{r.result.createObjectStore('runs',{keyPath:'run.id'});r.result.createObjectStore('recordings',{keyPath:'run.id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const record = (id, at = now, state = 'stopped') => ({ version: 1, saved_at: now,
            run: { id, session_id: 'old', tab_id: 7, name: 'Retained', url: 'https://site.test', started_at: at, stopped_at: at, state, requests: 1, operations: 1, errors: 0, dropped_requests: 0, dropped_operations: 0, dropped_console: 0, coverage: [], next_since: 1, saved_at: now },
            requests: [{ id: id+':n1', run_id: id, state: 'pending', request_body: {state:'available',text:'{"name":"Alice"}'}, response_body:{state:'pending'} }],
            operations: [{ id:id+':a1', state:'running' }], console:[], pages:[] });
          await new Promise((resolve,reject)=>{const tx=legacy.transaction(['runs','recordings'],'readwrite');const old=record('dlegacy');tx.objectStore('runs').put({run:old.run,bytes:100});tx.objectStore('recordings').put(old);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
          legacy.close();
          const archive = new LocalDebugArchive(undefined, () => now);
          if (!(await archive.get('dlegacy'))?.requests[0].request_body.text.includes('Alice')) throw Error('v1 history migration failed');
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
          const journalRun = record('djournal', now+90).run;
          await recovered.put({...record('djournal', now+90), requests:[]});
          const entry = (n, text='saved-'+n) => ({ id: 'djournal:n'+n, run_id:'djournal', sequence:n+1, started_at:now+n, method:'GET', url:'https://site.test/api/'+n, resource_type:'Fetch', status:200, state:'complete', request_body:{state:'empty'}, response_body:{state:'available',text}, request_headers:{'x-test':'retained'} });
          await recovered.retain(journalRun, [entry(0), {...entry(-1),status:503}]);
          await recovered.pin('djournal', 'djournal:n0', true);
          await recovered.retain(journalRun, [{...entry(0), response_body:{state:'evicted',reason:'memory_limit'}}]);
          for (let i=1; i<310; i+=20) await recovered.retain(journalRun, Array.from({length:20}, (_,j)=>entry(i+j,'x'.repeat(8192))));
          await recovered.put({...record('djournal', now+90), requests:[]});
          const kept = await recovered.get('djournal');
          if (kept.requests.length < 300 || kept.requests.find(r=>r.id==='djournal:n0').response_body.text !== 'saved-0') throw Error('journal evidence erased by checkpoint/cache eviction');
          const page = await recovered.query('djournal',{action:'requests', session_id:'old', limit:3, url:'/api/2'});
          if (page.requests.length!==3 || page.requests.some(r=>r.response_body.text || r.request_headers)) throw Error('index query leaked bodies or failed filtering');
          const next = await recovered.query('djournal',{action:'requests', session_id:'old', limit:3, url:'/api/2', since:page.next_since});
          if (next.requests.some(r=>page.requests.some(p=>p.id===r.id))) throw Error('query cursor duplicated rows');
          for (let i=330; i<2100; i+=50) await recovered.retain(journalRun, Array.from({length:50}, (_,j)=>entry(i+j)));
          const bounded = await recovered.get('djournal');
          if (bounded.requests.length>2000 || bounded.run.storage.dropped===0 || !(await recovered.request('djournal','djournal:n0')).pinned) throw Error('journal count/pin bounds failed');
          for (let i=2200; i<2400; i+=10) await recovered.retain(journalRun, Array.from({length:10}, (_,j)=>entry(i+j,'中'.repeat(32768))));
          const byteBounded = await recovered.get('djournal');
          if (!(await recovered.request('djournal','djournal:n-1')) || byteBounded.run.storage.bytes>8*1024*1024 || !(await recovered.request('djournal','djournal:n0')).pinned || !byteBounded.run.coverage.includes('evidence_storage_limit')) throw Error('journal byte/pin bounds failed');
          await recovered.delete('djournal');
          if (await recovered.request('djournal','djournal:n0')) throw Error('journal deletion failed');
          const reloadRecord = {...record('dreload', now+100, 'capturing'), requests:[]};
          await recovered.put(reloadRecord);
          await recovered.retain(reloadRecord.run, [{...entry(1), id:'dreload:n1',run_id:'dreload',request_body:{state:'available',text:'{"name":"Alice"}'}}]);
          return { records: (await recovered.list()).length, recovered: saved.run.stop_reason };
        })()`);
          expect(result).toEqual({ records: 50, recovered: "browser_restarted" });
          await send("Page.reload", {}, sessionId);
          // Navigation completion: importing after reload also verifies the database survives a new page context.
          let reloaded: unknown;
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              reloaded = await evaluate(
                `import('/archive.js').then(async ({LocalDebugArchive}) => new LocalDebugArchive().get('dreload').then(record => record?.run.storage?.requests === 1 && record.run.state === 'stopped' && record.requests[0].request_body.text))`,
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
