// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { collectCooperationFrames } from "@/cooperation/browser-bridge";
import { CooperationController } from "@/cooperation/controller";
import { COOPERATION_ARM, COOPERATION_READ } from "@/cooperation/types";
import { SessionManager } from "@/session-manager/manager";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

describe.skipIf(!process.env.BSK_COOP_CHROME)("frame interaction coverage", () => {
  it("collects HTTP frames, skips load failures and repairs old tabs while preserving human control", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-http-cooperation-"));
    const brokenFrame = await readFile(
      new URL(
        "../../../../../evals/browser/cases/regression/cooperation/broken-frame.html",
        import.meta.url,
      ),
    );
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        request.url === "/broken"
          ? brokenFrame
          : request.url === "/frame"
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
      await mkdir(path.join(directory, "content-scripts"));
      await writeFile(
        path.join(directory, "content-scripts/cooperation.js"),
        await readFile(path.join(directory, "content.bundle.js")),
      );
      const matches = ["http://127.0.0.1/*", "http://intranet.test/*"];
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "HTTP interaction regression",
          version: "1.0",
          background: { service_worker: "http-cooperation-worker.js" },
          permissions: ["tabs", "webNavigation", "scripting"],
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
          extensionViaCdp: true,
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
          let { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: worker!.targetId,
            flatten: true,
          });
          const evaluate = async <T>(expression: string): Promise<T> => {
            const reply = await send<{
              result: { value: T };
              exceptionDetails?: { exception?: { description?: string }; text: string };
            }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              sessionId,
            );
            if (reply.exceptionDetails)
              throw new Error(
                reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text,
              );
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
          const executeScript = vi.fn((options: object) =>
            evaluate(`chrome.scripting.executeScript(${JSON.stringify(options)})`),
          );
          vi.stubGlobal("chrome", {
            webNavigation: { getAllFrames },
            tabs: {
              sendMessage,
              get: (tabId: number) => evaluate(`chrome.tabs.get(${tabId})`),
              query: (query: object) => evaluate(`chrome.tabs.query(${JSON.stringify(query)})`),
            },
            scripting: { executeScript },
          });
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
            const { frames: states } = await collectCooperationFrames(
              tabId,
              COOPERATION_READ,
              "lease",
            );
            expect(states.size).toBe(2);
            expect(states.get(0)?.fields).toEqual([
              expect.objectContaining({ label: "Page", value: "top" }),
            ]);
            const childId = frames.find((frame) => frame.parentFrameId === 0)!.frameId;
            expect(states.get(childId)?.fields).toEqual([
              expect.objectContaining({ label: "Frame", value: "child" }),
            ]);
            expect(new Set([...states.values()].map((state) => state.document)).size).toBe(2);
            const { frames: armed } = await collectCooperationFrames(
              tabId,
              COOPERATION_ARM,
              "lease",
              {
                type: "pointerdown",
                x: 10,
                y: 20,
              },
            );
            for (const [frameId, state] of states) {
              expect(armed.get(frameId)).toMatchObject({
                document: state.document,
                fields: state.fields,
              });
            }
            await evaluate(`chrome.tabs.remove(${tabId})`);
          }

          const createTab = async (route: string) => {
            const tab = await evaluate<{ id: number; windowId: number }>(
              `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${port}${route}`)}})`,
            );
            await expect
              .poll(() => evaluate(`chrome.tabs.get(${tab.id})`), { timeout: 10000 })
              .toMatchObject({ status: "complete" });
            return tab;
          };
          const broken = await createTab("/broken");
          const browserFrames = await getAllFrames({ tabId: broken.id });
          const failed = browserFrames.find((frame) => frame.frameId !== 0)!;
          // Confirm Chrome's real metadata, not just a mocked error flag.
          expect(failed.errorOccurred).toBe(true);
          const collected = await collectCooperationFrames(broken.id, COOPERATION_READ, "broken");
          expect([...collected.frames.keys()]).toEqual([0]);
          expect(collected.gaps).toEqual([
            { frame_id: failed.frameId, url: failed.url, reason: "load_error" },
          ]);
          expect(executeScript).not.toHaveBeenCalled();
          await evaluate(`chrome.tabs.remove(${broken.id})`);

          const oldTab = await createTab("/");
          const beforeReload = await getAllFrames({ tabId: oldTab.id });
          const oldWorker = worker!.targetId;
          await send("Extensions.loadUnpacked", { path: directory });
          await expect
            .poll(
              async () => {
                const { targetInfos } = await send<{
                  targetInfos: { targetId: string; type: string; url: string }[];
                }>("Target.getTargets");
                worker = targetInfos.find(
                  (target) =>
                    target.type === "service_worker" &&
                    target.targetId !== oldWorker &&
                    target.url.endsWith("/http-cooperation-worker.js"),
                );
                return worker;
              },
              { timeout: 10000 },
            )
            .toBeDefined();
          ({ sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: worker!.targetId,
            flatten: true,
          }));
          expect(await getAllFrames({ tabId: oldTab.id })).toEqual(beforeReload);
          for (const frame of beforeReload)
            await expect(
              sendMessage(
                oldTab.id,
                { kind: COOPERATION_READ, lease: "old" },
                { documentId: frame.documentId },
              ),
            ).rejects.toThrow("Receiving end does not exist");

          const sessions = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: oldTab.windowId, initialTabIds: [oldTab.id] }),
              remove: async () => {},
              ensureActiveTab: async () => oldTab.id,
            },
          });
          await sessions.start("repair");
          const controller = new CooperationController({
            sessions,
            readFrames: (tabId, input, lease, repairs) =>
              collectCooperationFrames(
                tabId,
                input ? COOPERATION_ARM : COOPERATION_READ,
                lease,
                input,
                repairs,
              ),
            resumeFrames: async () => {},
            changed: () => {},
          });
          controller.startSession("repair");
          await controller.observeTab(oldTab.id);
          expect(controller.view(oldTab.id)?.mode).toBe("syncing");
          expect(executeScript).toHaveBeenCalledTimes(2);
          expect(
            executeScript.mock.calls
              .map(
                ([options]) =>
                  (options as { target: { documentIds: string[] } }).target.documentIds[0],
              )
              .sort(),
          ).toEqual(beforeReload.map((frame) => frame.documentId).sort());
          const guard = controller.controlGuard("repair", oldTab.id);
          expect(guard).not.toThrow();

          const { targetInfos } = await send<{ targetInfos: { targetId: string; url: string }[] }>(
            "Target.getTargets",
          );
          const target = targetInfos.find((target) => target.url === `http://127.0.0.1:${port}/`)!;
          const { sessionId: human } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          });
          await send("Page.bringToFront", {}, human);
          const point = await send<{ result: { value: { x: number; y: number } } }>(
            "Runtime.evaluate",
            {
              expression: `(() => { const f = document.querySelector('iframe'); const a = f.getBoundingClientRect(); const b = f.contentDocument.querySelector('input').getBoundingClientRect(); return { x: a.x + f.clientLeft + b.x + 10, y: a.y + f.clientTop + b.y + 10 }; })()`,
              returnByValue: true,
            },
            human,
          );
          for (const type of ["mousePressed", "mouseReleased"])
            await send(
              "Input.dispatchMouseEvent",
              { type, button: "left", clickCount: 1, ...point.result.value },
              human,
            );
          await controller.observeTab(oldTab.id);
          expect(controller.view(oldTab.id)?.mode).toBe("human");
          expect(guard).toThrow();
          expect(executeScript).toHaveBeenCalledTimes(2);
          await evaluate(`chrome.tabs.remove(${oldTab.id})`);
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
