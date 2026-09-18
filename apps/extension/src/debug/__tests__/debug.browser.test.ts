// @vitest-environment node
// Opt in with BSK_CLICK_CHROME. Owns its browser, profile and local fixture server.

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "@/tools/interaction";
import { DebugManager } from "../manager";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Event = { sessionId?: string; method: string; params?: Record<string, unknown> };
type Listener = (source: CdpDebuggee, method: string, params: unknown) => void;

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser website debugging", () => {
  it("captures and verifies an HTTP 200 business failure, redirects, iframe requests and cleanup", async () => {
    let fixed = false;
    const server = createServer((request, response) => {
      const route = request.url?.split("?")[0];
      if (route === "/slow") {
        response.setHeader("Content-Type", "application/json");
        setTimeout(() => response.end('{"name":"Bob","success":true}'), 2000);
        return;
      }
      if (route === "/api/save") {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", "session_id=private; Path=/");
        response.end(
          JSON.stringify({
            ok: fixed,
            code: fixed ? "SAVED" : "VALIDATION_FAILED",
            token: "private-response",
          }),
        );
        return;
      }
      if (route === "/redirect") {
        response.writeHead(302, { Location: "/api/save" });
        response.end();
        return;
      }
      if (route === "/frame-api") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"frame":true}');
        return;
      }
      if (route === "/frame") {
        response.setHeader("Content-Type", "text/html");
        response.end("<p>Frame ready</p>");
        return;
      }
      if (route === "/large") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ value: "x".repeat(80000) }));
        return;
      }
      if (route === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Debug fixture</title><label for="name">Nickname</label><input id="name" name="name" value="Alice"><input id="password" type="password" value="manual-private"><button id="save">Save</button><p role="status" id="result">Ready</p><iframe src="http://localhost:${(server.address() as { port: number }).port}/frame"></iframe><script>
        if(performance.getEntriesByType('navigation')[0]?.type==='reload') { document.querySelector('#name').value=''; setTimeout(()=>{document.querySelector('#name').value='Alice'},800); }
        document.querySelector('#save').onclick=async()=>{
          if(document.querySelector('#name').value==='Bob') {
            await new Promise(resolve=>setTimeout(resolve,2000));
            await fetch('/slow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Bob'})}).then(r=>r.json());
            document.querySelector('#result').textContent='Delayed saved'; return;
          }
          const data=await fetch('/api/save?token=private-query',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer private-header'},body:JSON.stringify({name:'Alice',password:'private-input'})}).then(r=>r.json());
          document.querySelector('#result').textContent=data.ok?'Saved':'Save failed';
          if(!data.ok) console.error('Save failed:',data.code);
        };
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
      let onEvent: ((event: Event) => void) | undefined;
      await withChrome(
        {
          executable: process.env.BSK_CLICK_CHROME,
          deviceScale: 1,
          zoom: 1,
          startupTimeout: 30000,
          onEvent: (event: Event) => onEvent?.(event),
        },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: "about:blank",
          });
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          const listeners = new Set<Listener>();
          const children = new Set<string>();
          onEvent = (event) => {
            if (
              event.sessionId !== sessionId &&
              (!event.sessionId || !children.has(event.sessionId))
            )
              return;
            if (event.method === "Target.attachedToTarget")
              children.add(event.params?.sessionId as string);
            const source = {
              tabId: 7,
              ...(event.sessionId !== sessionId ? { sessionId: event.sessionId } : {}),
            };
            for (const listener of listeners) listener(source, event.method, event.params);
          };
          const api: CdpDebuggerApi = {
            attach: async () => {},
            detach: async () => {
              await send("Target.detachFromTarget", { sessionId });
            },
            sendCommand: (target, method, params) =>
              send(method, params, target.sessionId ?? sessionId),
            onEvent: {
              addListener: (fn: Listener) => listeners.add(fn),
              removeListener: (fn: Listener) => listeners.delete(fn),
            } as unknown as CdpDebuggerApi["onEvent"],
            onDetach: {
              addListener: () => {},
              removeListener: () => {},
            } as unknown as CdpDebuggerApi["onDetach"],
          };
          const cdp = new ChromiumCdp(api);
          const sessions = new SessionManager({
            agentWindow: {
              create: async () => 100,
              remove: async () => {},
              ensureActiveTab: async () => 7,
            },
          });
          await sessions.start("website-debug");
          const tab = {
            id: 7,
            windowId: 100,
            active: true,
            url,
            title: "Debug fixture",
          } as chrome.tabs.Tab;
          const tabs = { get: async () => tab, query: async () => [tab] };
          const debug = new DebugManager(sessions, cdp, tabs);
          const evaluate = async (expression: string, targetSession = sessionId) => {
            const value = await send<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              targetSession,
            );
            expect(value.exceptionDetails).toBeUndefined();
            return value.result.value;
          };
          try {
            await debug.start("website-debug", 7, "Save fails");
            const navigation = await debug.before({
              id: "nav",
              method: "tool.navigate",
              params: { session_id: "website-debug", tab_id: 7 },
            });
            await cdp.send(7, "Page.navigate", { url });
            debug.after(navigation);
            await vi.waitFor(
              async () => expect(await evaluate("!!document.querySelector('#save')")).toBe(true),
              { timeout: 5000 },
            );
            const click = async (id: string) => {
              const ticket = await debug.before({
                id,
                method: "tool.click",
                params: { session_id: "website-debug", tab_id: 7, selector: "#save" },
              });
              const result = await handleClick(
                sessions,
                { session_id: "website-debug", tab_id: 7, selector: "#save" },
                { cdp, tabsApi: tabs },
              );
              expect(result, JSON.stringify(result)).not.toHaveProperty("code");
              debug.after(ticket);
              return ticket!;
            };
            const first = await click("before");
            await vi.waitFor(
              async () => {
                const result = await debug.read({
                  action: "operation",
                  session_id: "website-debug",
                  id: first.operation.id,
                });
                expect(result.operation?.after?.text).toContain("Save failed");
                expect(result.console?.length).toBeGreaterThan(0);
                expect(
                  result.requests?.some(
                    (entry) =>
                      entry.url.includes("/api/save") && entry.response_body.state === "available",
                  ),
                ).toBe(true);
              },
              { timeout: 5000 },
            );
            const firstEvidence = await debug.read({
              action: "operation",
              session_id: "website-debug",
              id: first.operation.id,
            });
            const request = firstEvidence.requests!.find((entry) =>
              entry.url.includes("/api/save"),
            )!;
            expect(request.status).toBe(200);
            expect(request.url).not.toContain("private-query");
            const body = await debug.read({
              action: "request",
              session_id: "website-debug",
              id: request.id,
              part: "response",
              pointer: "/ok",
            });
            expect(body.request?.response_body.text).toBe("false");
            const headers = await debug.read({
              action: "request",
              session_id: "website-debug",
              id: request.id,
              part: "headers",
            });
            expect(headers.request?.request_headers?.authorization).toBe("[redacted]");
            expect(headers.request?.response_headers?.["set-cookie"]).toBe("[redacted]");
            expect(
              (
                await debug.read({
                  action: "request",
                  session_id: "website-debug",
                  id: request.id,
                  part: "request",
                })
              ).request?.request_body.text,
            ).toContain('"name": "Alice"');
            fixed = true;
            const second = await click("after");
            await vi.waitFor(
              async () =>
                expect(
                  (
                    await debug.read({
                      action: "operation",
                      session_id: "website-debug",
                      id: second.operation.id,
                    })
                  ).operation?.after?.text,
                ).toContain("Saved"),
              { timeout: 5000 },
            );
            const recording = (await debug.read({ action: "export", session_id: "website-debug" }))
              .recording!;
            expect(recording.version).toBe(1);
            expect(
              recording.operations.find((item) => item.id === first.operation.id)?.after?.text,
            ).toContain("Save failed");
            expect(
              recording.operations.find((item) => item.id === second.operation.id)?.after?.text,
            ).toContain("Saved");
            expect(
              recording.requests.some((item) =>
                item.response_body.text?.includes("VALIDATION_FAILED"),
              ),
            ).toBe(true);
            await evaluate("Promise.all([fetch('/redirect'),fetch('/large')]).then(()=>true)");
            await vi.waitFor(
              async () => {
                const result = await debug.read({
                  action: "requests",
                  session_id: "website-debug",
                  limit: 100,
                });
                expect(
                  result.requests?.some(
                    (entry) => entry.state === "redirected" && entry.status === 302,
                  ),
                ).toBe(true);
                expect(
                  result.requests?.find((entry) => entry.url.endsWith("/large"))?.response_body
                    .state,
                ).toBe("truncated");
              },
              { timeout: 5000 },
            );
            await vi.waitFor(() => expect(children.size).toBeGreaterThan(0), { timeout: 5000 });
            await evaluate("fetch('/frame-api').then(r=>r.json())", [...children][0]);
            await vi.waitFor(
              async () =>
                expect(
                  (
                    await debug.read({
                      action: "requests",
                      session_id: "website-debug",
                      limit: 100,
                    })
                  ).requests?.some(
                    (entry) =>
                      entry.url.includes("/frame-api") && entry.response_body.state === "available",
                  ),
                ).toBe(true),
              { timeout: 5000 },
            );
            // Native input without DebugManager.before models a person reproducing a bug.
            const beforeManual = (
              await debug.read({ action: "operations", session_id: "website-debug" })
            ).operations!;
            expect(beforeManual.every((item) => item.source === "agent")).toBe(true);
            await evaluate(
              "document.querySelector('#name').focus();document.querySelector('#name').select();true",
            );
            await send("Input.insertText", { text: "Bob" }, sessionId);
            await handleClick(
              sessions,
              { session_id: "website-debug", tab_id: 7, selector: "#save" },
              { cdp, tabsApi: tabs },
            );
            let manualId = "";
            await vi.waitFor(
              async () => {
                const operations = (
                  await debug.read({ action: "operations", session_id: "website-debug" })
                ).operations!;
                expect(
                  operations.some((item) => item.source === "human" && item.method === "tool.fill"),
                ).toBe(true);
                manualId = operations.findLast(
                  (item) => item.source === "human" && item.method === "tool.click",
                )!.id;
                const detail = await debug.read({
                  action: "operation",
                  session_id: "website-debug",
                  id: manualId,
                });
                expect(
                  detail.evidence?.fields.find((field) => field.label === "Nickname"),
                ).toMatchObject({
                  before: { value: "Alice" },
                  input: { value: "Bob" },
                  submitted: [{ value: "Bob" }],
                  response: [{ value: "Bob" }],
                });
                expect(detail.evidence?.links.some((link) => link.relation === "delayed")).toBe(
                  true,
                );
                expect(detail.operation?.after?.text).toContain("Delayed saved");
              },
              { timeout: 9000 },
            );
            await send("Page.reload", {}, sessionId);
            await vi.waitFor(
              async () => {
                const detail = await debug.read({
                  action: "operation",
                  session_id: "website-debug",
                  id: manualId,
                });
                expect(
                  detail.evidence?.fields.find((field) => field.label === "Nickname")?.later,
                  JSON.stringify(
                    (await debug.read({ action: "export", session_id: "website-debug" })).recording
                      ?.pages,
                  ),
                ).toMatchObject({ value: "Alice", source: "page:reload" });
              },
              { timeout: 5000 },
            );
            const exported = await debug.read({ action: "export", session_id: "website-debug" });
            expect(JSON.stringify(exported)).not.toContain("manual-private");
            expect(
              exported.recording?.operations.some(
                (item) => item.source === "human" && item.method === "tool.reload",
              ),
            ).toBe(true);
            await evaluate(
              "document.querySelector('#name').focus();document.querySelector('#name').select();true",
            );
            await send("Input.insertText", { text: "Pending edit" }, sessionId);
            await debug.read({ action: "stop", session_id: "website-debug" });
            const finalRecord = (
              await debug.read({ action: "export", session_id: "website-debug" })
            ).recording!;
            expect(finalRecord.operations.at(-1)).toMatchObject({
              source: "human",
              method: "tool.fill",
              state: "completed",
            });
            expect(
              finalRecord.operations.at(-1)?.after?.fields?.find((field) => field.name === "name")
                ?.value,
            ).toBe("Pending edit");
            if (process.env.BSK_DEBUG_RECORD_PATH) {
              const details = await Promise.all(
                finalRecord.operations.map((operation) =>
                  debug.read({
                    action: "operation",
                    session_id: "website-debug",
                    id: operation.id,
                  }),
                ),
              );
              await writeFile(
                process.env.BSK_DEBUG_RECORD_PATH,
                JSON.stringify({ recording: finalRecord, details, selectedOperation: manualId }),
              );
            }
            const stopped = (await debug.read({ action: "status", session_id: "website-debug" }))
              .runs![0];
            await evaluate("fetch('/frame-api?after-stop').then(r=>r.text())");
            expect(
              (await debug.read({ action: "status", session_id: "website-debug" })).runs![0]
                .requests,
            ).toBe(stopped.requests);
            debug.releaseSession("website-debug");
            expect(
              (await debug.read({ action: "status", session_id: "website-debug" })).runs,
            ).toEqual([]);
            console.log(
              "WEBSITE-DEBUG",
              JSON.stringify({
                businessFailure: request.id,
                before: first.operation.id,
                after: second.operation.id,
                requests: stopped.requests,
                iframeTargets: children.size,
              }),
            );
          } finally {
            debug.dispose();
            cdp.dispose();
            onEvent = undefined;
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
