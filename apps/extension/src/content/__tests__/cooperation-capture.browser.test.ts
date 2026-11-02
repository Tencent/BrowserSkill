// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { collectCooperationFrames } from "@/cooperation/browser-bridge";
import { COOPERATION_ARM, COOPERATION_READ } from "@/cooperation/types";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

describe.skipIf(!process.env.BSK_COOP_CHROME)("HTTP interaction capture", () => {
  it("collects top-level and child frames on secure and insecure HTTP origins", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-http-cooperation-"));
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        request.url === "/frame"
          ? '<!doctype html><input aria-label="Frame" value="child">'
          : '<!doctype html><input aria-label="Page" value="top"><iframe src="/frame"></iframe>',
      );
    });
    try {
      const entry = path.join(directory, "content.js");
      await writeFile(
        entry,
        `import { attachCooperationCapture } from '@/content/cooperation-capture';
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.kind === 'fixture.environment') reply({
    secure: isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues,
  });
});
attachCooperationCapture();`,
      );
      await build({
        entryPoints: [entry],
        outfile: path.join(directory, "content.bundle.js"),
        bundle: true,
        format: "iife",
        alias: { "@": path.resolve("src") },
      });
      const matches = ["http://127.0.0.1/*", "http://intranet.test/*"];
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "HTTP interaction regression",
          version: "1.0",
          background: { service_worker: "http-cooperation-worker.js" },
          permissions: ["tabs", "webNavigation"],
          host_permissions: matches,
          content_scripts: [
            { matches, js: ["content.bundle.js"], run_at: "document_start", all_frames: true },
          ],
        }),
      );
      await writeFile(
        path.join(directory, "http-cooperation-worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {}); globalThis.httpCooperationReady = true;",
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_COOP_CHROME,
          extensionPath: directory,
          deviceScale: 1,
          zoom: 1,
          // Loopback URLs are secure contexts. Map a non-localhost name to our
          // server so Chrome exercises the same API restrictions as an intranet.
          extraArgs: [
            "--host-resolver-rules=MAP intranet.test 127.0.0.1",
            "--no-proxy-server",
            "--disable-features=HttpsUpgrades",
          ],
        },
        async (send: Send) => {
          let worker: { targetId: string } | undefined;
          await expect
            .poll(
              async () => {
                const { targetInfos } = await send<{
                  targetInfos: { targetId: string; type: string; url: string }[];
                }>("Target.getTargets");
                worker = targetInfos.find(
                  (target) =>
                    target.type === "service_worker" &&
                    target.url.endsWith("/http-cooperation-worker.js"),
                );
                return worker;
              },
              { timeout: 10000 },
            )
            .toBeDefined();
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: worker!.targetId,
            flatten: true,
          });
          const evaluate = async <T>(expression: string): Promise<T> => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          await expect
            .poll(() => evaluate("globalThis.httpCooperationReady"), { timeout: 10000 })
            .toBe(true);
          expect(await evaluate("chrome.runtime.getManifest().name")).toBe(
            "HTTP interaction regression",
          );
          // Keep the production collector and bridge; forward only Chrome APIs
          // from this test process to the isolated extension's real worker.
          const getAllFrames = ({ tabId }: { tabId: number }) =>
            evaluate<chrome.webNavigation.GetAllFrameResultDetails[]>(
              `chrome.webNavigation.getAllFrames({tabId:${tabId}})`,
            );
          const sendMessage = (tabId: number, message: unknown, options: object) =>
            evaluate(
              `chrome.tabs.sendMessage(${tabId},${JSON.stringify(message)},${JSON.stringify(options)})`,
            );
          vi.stubGlobal("chrome", { webNavigation: { getAllFrames }, tabs: { sendMessage } });
          for (const host of ["127.0.0.1", "intranet.test"]) {
            const url = `http://${host}:${port}/`;
            const { id: tabId } = await evaluate<{ id: number }>(
              `chrome.tabs.create({url:${JSON.stringify(url)}})`,
            );
            await expect
              .poll(() => evaluate(`chrome.tabs.get(${tabId})`), { timeout: 10000 })
              .toMatchObject({ url, status: "complete" });
            const frames = await getAllFrames({ tabId });
            expect(frames).toHaveLength(2);
            for (const frame of frames) {
              expect(
                await sendMessage(
                  tabId,
                  { kind: "fixture.environment" },
                  {
                    documentId: frame.documentId,
                  },
                ),
              ).toEqual({
                secure: host === "127.0.0.1",
                randomUUID: host === "127.0.0.1" ? "function" : "undefined",
                getRandomValues: "function",
              });
            }
            const states = await collectCooperationFrames(tabId, COOPERATION_READ, "lease");
            expect(states.size).toBe(2);
            expect(states.get(0)?.fields).toEqual([
              expect.objectContaining({ label: "Page", value: "top" }),
            ]);
            const childId = frames.find((frame) => frame.parentFrameId === 0)!.frameId;
            expect(states.get(childId)?.fields).toEqual([
              expect.objectContaining({ label: "Frame", value: "child" }),
            ]);
            expect(new Set([...states.values()].map((state) => state.document)).size).toBe(2);
            const armed = await collectCooperationFrames(tabId, COOPERATION_ARM, "lease", {
              type: "pointerdown",
              x: 10,
              y: 20,
            });
            for (const [frameId, state] of states) {
              expect(armed.get(frameId)).toMatchObject({
                document: state.document,
                fields: state.fields,
              });
            }
            await evaluate(`chrome.tabs.remove(${tabId})`);
          }
        },
      );
    } finally {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
