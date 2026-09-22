// @vitest-environment node
// Opt-in isolated Chrome and fixture server; never touches the user's browser.

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggee, type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { DebugManager } from "../manager";
import type { DebugRuleSpec } from "../types";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Event = { sessionId?: string; method: string; params?: Record<string, unknown> };
type Listener = (source: CdpDebuggee, method: string, params: unknown) => void;
describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser network controls", () => {
  it("modifies actual traffic, mocks/blocks without server hits, links replay once and cleans up pending rules", async () => {
    const hits: { url: string; body: string; header?: string }[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><title>Network controls</title><h1>Profile</h1><p id="state">Ready</p>',
        );
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        hits.push({ url: req.url!, body, header: req.headers["x-test"] as string | undefined });
        res.setHeader("Content-Type", "application/json");
        // Echo JSON tokens verbatim so the fixture itself does not round 64-bit IDs.
        res.end(`{"source":"server","body":${body || "null"}}`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
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
            for (const listener of listeners)
              listener(
                {
                  tabId: 7,
                  ...(event.sessionId !== sessionId ? { sessionId: event.sessionId } : {}),
                },
                event.method,
                event.params,
              );
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
              create: async () => ({ windowId: 100, initialTabIds: [7] }),
              remove: async () => {},
              ensureActiveTab: async () => 7,
            },
          });
          await sessions.start("network-controls");
          const tab = {
            id: 7,
            windowId: 100,
            active: true,
            url,
            title: "Network controls",
          } as chrome.tabs.Tab;
          const debug = new DebugManager(sessions, cdp, {
            get: async () => tab,
            query: async () => [tab],
          });
          const evaluate = async (expression: string, targetSession = sessionId) => {
            const reply = await send<{ result: { value?: unknown }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              targetSession,
            );
            expect(reply.exceptionDetails, JSON.stringify(reply)).toBeUndefined();
            return reply.result.value;
          };
          const read = (action: "requests" | "rules" | "stop" | "export") =>
            debug.read({ session_id: "network-controls", action, limit: 100 });
          const add = (rule: DebugRuleSpec) =>
            debug.read({ session_id: "network-controls", action: "rule_add", rule });
          const fetch = (path: string, body?: object) =>
            evaluate(
              `fetch(${JSON.stringify(url + path)},${JSON.stringify(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})}).then(async r=>({status:r.status,data:await r.json()})).catch(()=>({error:true}))`,
            );
          try {
            await debug.start("network-controls", 7, "Request control verification");
            await cdp.send(7, "Page.navigate", { url });
            await vi.waitFor(async () =>
              expect(await evaluate("document.title")).toBe("Network controls"),
            );
            const largeBody = JSON.stringify({ data: "x".repeat(65537) });
            await add({
              match: { url: `${url}/large`, method: "POST" },
              effect: { type: "modify", headers: { "x-test": "large-header-only" } },
            });
            expect(
              await evaluate(`fetch(${JSON.stringify(`${url}/large`)}, {
              method: "POST", headers: {"content-type":"application/json"},
              body: ${JSON.stringify(largeBody)}
            }).then(r => r.status)`),
            ).toBe(200);
            expect(hits.find((hit) => hit.url === "/large")).toEqual({
              url: "/large",
              body: largeBody,
              header: "large-header-only",
            });
            await add({
              name: "Correct nickname field",
              match: { url: `${url}/save`, method: "POST" },
              effect: {
                type: "modify",
                headers: { "x-test": "changed" },
                json: { rename: { displayName: "name" } },
              },
            });
            expect(await fetch("/save", { displayName: "张三", keep: 1 })).toMatchObject({
              data: { body: { name: "张三", keep: 1 } },
            });
            expect(hits.find((hit) => hit.url === "/save")).toMatchObject({
              header: "changed",
              body: '{"keep":1,"name":"张三"}',
            });
            await vi.waitFor(async () =>
              expect(
                (await read("requests")).requests?.find((item) => item.url.endsWith("/save"))
                  ?.response_body.state,
              ).toBe("available"),
            );
            const saved = (await read("export")).recording!.requests.find((item) =>
              item.url.endsWith("/save"),
            )!;
            expect(saved.intervention).toMatchObject({ type: "modify", state: "applied" });
            expect(JSON.parse(saved.request_body.text!)).toEqual({ keep: 1, name: "张三" });
            expect(saved.request_headers?.["x-test"]).toBe("changed");
            expect((await read("rules")).rules?.[0].state).toBe("exhausted");
            expect(await fetch("/save", { displayName: "unchanged" })).toMatchObject({
              data: { body: { displayName: "unchanged" } },
            });

            await add({
              name: "Mock backend failure",
              match: { url: `${url}/mock` },
              effect: {
                type: "mock",
                status: 503,
                body: '{"source":"mock","message":"稍后重试"}',
                delay_ms: 100,
              },
            });
            expect(await fetch("/mock")).toMatchObject({
              status: 503,
              data: { source: "mock", message: "稍后重试" },
            });
            expect(hits.some((hit) => hit.url === "/mock")).toBe(false);
            await add({ match: { url: `${url}/blocked` }, effect: { type: "block" } });
            expect(await fetch("/blocked")).toEqual({ error: true });
            expect(hits.some((hit) => hit.url === "/blocked")).toBe(false);

            const beforeReplay = hits.filter((hit) => hit.url === "/save").length;
            const replayParams = {
              session_id: "network-controls",
              action: "replay" as const,
              id: saved.id,
              replay: { key: "one-attempt", body: '{"name":"Replay"}' },
            };
            const [first, again] = await Promise.all([
              debug.read(replayParams),
              debug.read(replayParams),
            ]);
            expect(first.replay).toMatchObject({ state: "complete", source_request_id: saved.id });
            expect(again.replay?.id).toBe(first.replay?.id);
            expect(hits.filter((hit) => hit.url === "/save")).toHaveLength(beforeReplay + 1);
            await vi.waitFor(async () => {
              const replayed = (await read("requests")).requests?.find(
                (item) => item.replay_from === saved.id,
              );
              expect(replayed?.id).toBe(first.replay?.request_id);
              expect(replayed?.response_body.state).toBe("available");
            });

            const original = '{"orderId":9007199254740993,"action":"cancel"}';
            await evaluate(
              `fetch('${url}/precision',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(original)}}).then(r=>r.text())`,
            );
            await vi.waitFor(async () =>
              expect(
                (await read("requests")).requests?.find((item) => item.url.endsWith("/precision"))
                  ?.response_body.state,
              ).toBe("available"),
            );
            const precise = (await read("export")).recording!.requests.find((item) =>
              item.url.endsWith("/precision"),
            )!;
            expect(precise.request_body).toMatchObject({ text: original, replay_safe: true });
            expect(precise.response_body.text).toContain("9007199254740993");
            await debug.read({
              session_id: "network-controls",
              action: "replay",
              id: precise.id,
              replay: { key: "precision" },
            });
            expect(hits.filter((hit) => hit.url === "/precision").map((hit) => hit.body)).toEqual([
              original,
              original,
            ]);

            await add({
              match: { url: `${url}/precision-edit` },
              effect: { type: "modify", json: { set: { action: "inspect" } } },
            });
            await evaluate(
              `fetch('${url}/precision-edit',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(original)}}).then(r=>r.text())`,
            );
            expect(hits.find((hit) => hit.url === "/precision-edit")?.body).toBe(
              '{"orderId":9007199254740993,"action":"inspect"}',
            );

            const longPath = `/long?q=${"x".repeat(2200)}&mode=dry-run`;
            await fetch(longPath);
            await vi.waitFor(async () =>
              expect(
                (await read("requests")).requests?.find((item) =>
                  item.url.startsWith(`${url}/long?`),
                )?.response_body.state,
              ).toBe("available"),
            );
            const longRequest = (await read("requests")).requests!.find((item) =>
              item.url.startsWith(`${url}/long?`),
            )!;
            const longReplay = {
              session_id: "network-controls",
              action: "replay" as const,
              id: longRequest.id,
              replay: { key: "long-url" },
            };
            await expect(debug.read(longReplay)).rejects.toThrow("replacement URL");
            expect(hits.filter((hit) => hit.url.startsWith("/long?"))).toHaveLength(1);
            await debug.read({
              ...longReplay,
              replay: { ...longReplay.replay, url: url + longPath },
            });
            expect(
              hits.filter((hit) => hit.url.startsWith("/long?")).map((hit) => hit.url),
            ).toEqual([longPath, longPath]);

            // Existing child targets receive the same bounded rule configuration.
            await evaluate(
              `const frame=document.createElement('iframe');frame.src=${JSON.stringify(url.replace("127.0.0.1", "localhost") + "/frame")};document.body.append(frame);0`,
            );
            await vi.waitFor(() => expect(children.size).toBeGreaterThan(0));
            const childSession = [...children][0];
            await vi.waitFor(async () =>
              expect(await evaluate("location.hostname", childSession)).toBe("localhost"),
            );
            const frameUrl = url.replace("127.0.0.1", "localhost") + "/frame-api";
            await add({
              match: { url: frameUrl },
              effect: { type: "mock", status: 200, body: '{"source":"iframe-mock"}' },
            });
            expect(
              await evaluate(`fetch(${JSON.stringify(frameUrl)}).then(r=>r.json())`, childSession),
            ).toMatchObject({ source: "iframe-mock" });
            expect(hits.some((hit) => hit.url === "/frame-api")).toBe(false);

            // A second target has no controls even when its URL matches an active rule.
            await add({
              match: { url: `${url}/isolated` },
              effect: { type: "mock", status: 200, body: '{"source":"mock"}' },
              times: 0,
            });
            const second = await send<{ targetId: string }>("Target.createTarget", { url });
            const other = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: second.targetId,
              flatten: true,
            });
            await vi.waitFor(async () =>
              expect(await evaluate("document.title", other.sessionId)).toBe("Network controls"),
            );
            expect(
              await evaluate(`fetch('${url}/isolated').then(r=>r.json())`, other.sessionId),
            ).toMatchObject({ source: "server" });
            await send("Target.closeTarget", { targetId: second.targetId });
            expect(await fetch("/isolated")).toMatchObject({ data: { source: "mock" } });

            await add({
              name: "Pending mock",
              match: { url: `${url}/pending` },
              effect: { type: "mock", status: 200, body: '{"source":"mock"}', delay_ms: 10000 },
            });
            await evaluate(
              `globalThis.pendingResult=null;fetch('${url}/pending').then(()=>pendingResult='fulfilled').catch(()=>pendingResult='aborted');0`,
            );
            await vi.waitFor(async () => expect((await read("rules")).rules?.at(-1)?.hits).toBe(1));
            if (process.env.BSK_CONTROL_FIXTURE_OUT)
              await writeFile(
                process.env.BSK_CONTROL_FIXTURE_OUT,
                JSON.stringify((await read("export")).recording),
              );
            await read("stop");
            await vi.waitFor(async () => expect(await evaluate("pendingResult")).toBe("aborted"));
            expect(hits.some((hit) => hit.url === "/pending")).toBe(false);
            expect(
              (await read("export")).recording!.requests.find((item) =>
                item.url.endsWith("/pending"),
              )?.intervention?.state,
            ).toBe("cancelled");
            expect(await fetch("/isolated")).toMatchObject({ data: { source: "server" } });
            const archive = (await read("export")).recording!;
            expect(archive.rules?.some((rule) => rule.state === "enabled")).toBe(false);
            expect(archive.requests.some((item) => item.intervention?.type === "mock")).toBe(true);
            expect(archive.requests.some((item) => item.intervention?.type === "block")).toBe(true);
            await expect(debug.read(replayParams)).rejects.toThrow("active capture");
          } finally {
            debug.dispose();
            await cdp.detachAll();
          }
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 45000);
});
