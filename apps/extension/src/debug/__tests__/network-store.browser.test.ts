// @vitest-environment node
// Opt in with BSK_CLICK_CHROME. Uses an isolated browser and local HTTP server.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DebugNetworkStore } from "../network-store";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type NetworkEvent = {
  sessionId?: string;
  method: string;
  params?: Parameters<DebugNetworkStore["onEvent"]>[2];
};

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser XML response capture", () => {
  it("retains XML suffix bodies from native Network events", async () => {
    const body = '<?xml version="1.0"?><response><status>ok</status></response>';
    const mimeTypes: Record<string, string> = {
      "/plain": "application/xml",
      "/soap": "application/soap+xml",
      "/vendor": "application/vnd.example+xml",
      "/binary": "application/octet-stream",
    };
    const server = createServer((request, response) => {
      const mime = mimeTypes[request.url ?? ""];
      response.setHeader("Content-Type", mime ?? "text/html");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(mime ? body : "<!doctype html><title>XML fixture</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      let onEvent: ((event: NetworkEvent) => void) | undefined;
      await withChrome(
        {
          executable: process.env.BSK_CLICK_CHROME,
          deviceScale: 1,
          zoom: 1,
          startupTimeout: 30_000,
          onEvent: (event: NetworkEvent) => onEvent?.(event),
        },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: "about:blank",
          });
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          let sequence = 0;
          const store = new DebugNetworkStore(
            "xml",
            {
              send: <T>(_tabId: number, method: string, params?: object) =>
                send<T>(method, params, sessionId),
            },
            () => ++sequence,
          );
          onEvent = (event) => {
            if (event.sessionId === sessionId && event.method.startsWith("Network."))
              store.onEvent({ tabId: 7 }, event.method, event.params ?? {});
          };
          const evaluate = async (expression: string) => {
            const reply = await send<{
              result: { value?: unknown };
              exceptionDetails?: unknown;
            }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          try {
            await send("Network.enable", {}, sessionId);
            await send("Page.navigate", { url: origin }, sessionId);
            await vi.waitFor(
              async () => expect(await evaluate("document.title")).toBe("XML fixture"),
              { timeout: 5000 },
            );
            expect(
              await evaluate(
                `Promise.all(${JSON.stringify(Object.keys(mimeTypes))}.map(async path => (await fetch(path)).text()))`,
              ),
            ).toEqual(Object.keys(mimeTypes).map(() => body));
            await vi.waitFor(
              () => {
                for (const path of Object.keys(mimeTypes)) {
                  const entry = store.list().find((item) => item.url === origin + path);
                  expect(entry?.state).toBe("complete");
                  expect(entry?.response_body.state).not.toBe("pending");
                }
              },
              { timeout: 5000 },
            );
            for (const [path, mime] of Object.entries(mimeTypes)) {
              const entry = store.list().find((item) => item.url === origin + path)!;
              expect(entry.mime_type).toBe(mime);
              expect(entry.status).toBe(200);
              if (path === "/binary")
                expect(entry.response_body).toEqual({ state: "omitted", reason: "non_text" });
              else expect(entry.response_body).toMatchObject({ state: "available", text: body });
            }
          } finally {
            onEvent = undefined;
            store.stop("requested");
          }
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
