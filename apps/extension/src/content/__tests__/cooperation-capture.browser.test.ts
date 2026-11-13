// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { guardedRunner } from "@/cooperation/action-guard";
import { collectCooperationFrames } from "@/cooperation/browser-bridge";
import { CooperationController } from "@/cooperation/controller";
import { COOPERATION_ARM, COOPERATION_READ, type FrameState } from "@/cooperation/types";
import { SessionManager } from "@/session-manager/manager";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

describe.skipIf(!process.env.BSK_TEST_CHROME)("frame interaction coverage", () => {
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
      if (request.url === "/enter") {
        response.end(`<!doctype html><form onsubmit="event.preventDefault(); window.submits++">
          <input aria-label="Search"><button>Submit</button></form><script>
          window.submits=0;window.keys=[];for(const type of ['keydown','keypress','keyup'])
          addEventListener(type,e=>keys.push([type,e.isTrusted]));</script>`);
        return;
      }
      response.end(
        request.url === "/broken"
          ? brokenFrame
          : request.url === "/late-frame"
            ? '<!doctype html><iframe src="/delayed"></iframe>'
            : request.url === "/wheel"
              ? // A legacy handler, as Bilibili uses for volume (#550).
                '<!doctype html><div style="height:400px"></div><script>window.counts={mousewheel:0};document.addEventListener("mousewheel",()=>counts.mousewheel++)</script>'
              : request.url === "/frame" || request.url === "/delayed"
                ? '<!doctype html><input aria-label="Frame" value="child">'
                : '<!doctype html><input aria-label="Page" value="top"><iframe src="/frame"></iframe>',
      );
    });
    try {
      // Use the shipped WXT entrypoint, including its invalidation/cleanup.
      // Build the extension before running this browser regression.
      const cooperationScript = await readFile(
        path.resolve("dist/chrome-mv3/content-scripts/cooperation.js"),
        "utf8",
      );
      await writeFile(
        path.join(directory, "content.bundle.js"),
        `if (location.pathname !== '/delayed') chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.kind === 'fixture.environment') reply({
    secure: isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues,
  });
});
const start = () => { ${cooperationScript} };
if (location.pathname === '/delayed') globalThis.fixtureStartCapture = start;
else start();`,
      );
      await mkdir(path.join(directory, "content-scripts"));
      await writeFile(path.join(directory, "content-scripts/cooperation.js"), cooperationScript);
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
        `chrome.runtime.onInstalled.addListener(() => {});
globalThis.frameUpdates = [];
chrome.runtime.onMessage.addListener(message => {
  if (message.kind === 'cooperation.frame') globalThis.frameUpdates.push(message.state);
});
globalThis.httpCooperationReady = true;`,
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
          executable: process.env.BSK_TEST_CHROME,
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
          const waitForWorker = () =>
            expect
              .poll(() => evaluate("globalThis.httpCooperationReady"), { timeout: 10000 })
              .toBe(true);
          await waitForWorker();
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
          const clickFrame = async (route: string) => {
            const { targetInfos } = await send<{
              targetInfos: { targetId: string; url: string }[];
            }>("Target.getTargets");
            const target = targetInfos.find(
              (target) => target.url === `http://127.0.0.1:${port}${route}`,
            )!;
            const { sessionId: human } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: target.targetId, flatten: true },
            );
            try {
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
            } finally {
              await send("Target.detachFromTarget", { sessionId: human });
            }
          };
          // Atomic Enter text must remain agent-attributed in the shipped
          // collector, including Chromium's derived keypress/click/submit.
          const enter = await createTab("/enter");
          await collectCooperationFrames(enter.id, COOPERATION_READ, "enter");
          const { targetInfos: enterTargets } = await send<{
            targetInfos: { targetId: string; url: string }[];
          }>("Target.getTargets");
          const enterTarget = enterTargets.find(
            (target) => target.url === `http://127.0.0.1:${port}/enter`,
          )!;
          const { sessionId: enterSession } = await send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId: enterTarget.targetId, flatten: true },
          );
          const enterSend = <T>(method: string, params?: object) =>
            send<T>(method, params, enterSession);
          await enterSend("Page.bringToFront");
          await enterSend("Runtime.evaluate", {
            expression: "document.querySelector('input').focus()",
          });
          const guarded = guardedRunner(
            {
              send: <T>(_tabId: number, method: string, params?: object) =>
                enterSend<T>(method, params),
            },
            {
              prepare: async (input) => {
                if (input)
                  await collectCooperationFrames(enter.id, COOPERATION_ARM, "enter", input);
              },
            },
          );
          const keydown = {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            text: "\r",
          };
          const keyup = { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
          await guarded.send(enter.id, "Input.dispatchKeyEvent", keydown);
          await guarded.send(enter.id, "Input.dispatchKeyEvent", keyup);
          const agentEnter = await collectCooperationFrames(enter.id, COOPERATION_READ, "enter");
          expect(agentEnter.frames.get(0)).toMatchObject({
            human: 0,
            lastInput: 0,
            editing: false,
          });
          const keyResult = await enterSend<{ result: { value: unknown } }>("Runtime.evaluate", {
            expression: "({submits,keys})",
            returnByValue: true,
          });
          expect(keyResult.result.value).toEqual({
            submits: 1,
            keys: [
              ["keydown", true],
              ["keypress", true],
              ["keyup", true],
            ],
          });
          await enterSend("Input.dispatchKeyEvent", keydown);
          await enterSend("Input.dispatchKeyEvent", keyup);
          const humanEnter = await collectCooperationFrames(enter.id, COOPERATION_READ, "enter");
          expect(humanEnter.frames.get(0)!.human).toBeGreaterThan(0);
          await send("Target.detachFromTarget", { sessionId: enterSession });
          await evaluate(`chrome.tabs.remove(${enter.id})`);

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

          const delayed = await createTab("/late-frame");
          const child = (await getAllFrames({ tabId: delayed.id })).find(
            (frame) => frame.frameId !== 0,
          )!;
          await expect(
            sendMessage(
              delayed.id,
              { kind: COOPERATION_READ, lease: "late" },
              { documentId: child.documentId },
            ),
          ).rejects.toThrow("Receiving end does not exist");
          const repaired = await collectCooperationFrames(delayed.id, COOPERATION_READ, "late");
          expect(executeScript).toHaveBeenCalledOnce();
          const repairedDocument = repaired.frames.get(child.frameId)!.document;
          // Let the delayed declared script run after the repair. WXT must
          // dispose the previous collector rather than leave both listening.
          await evaluate(
            `chrome.scripting.executeScript({target:{tabId:${delayed.id},documentIds:[${JSON.stringify(child.documentId)}]},func:()=>globalThis.fixtureStartCapture()})`,
          );
          const declared = await collectCooperationFrames(delayed.id, COOPERATION_READ, "late");
          const declaredDocument = declared.frames.get(child.frameId)!.document;
          expect(declaredDocument).not.toBe(repairedDocument);
          await evaluate("globalThis.frameUpdates = []");
          await clickFrame("/late-frame");
          const afterInput = await collectCooperationFrames(delayed.id, COOPERATION_READ, "late");
          expect(afterInput.frames.get(child.frameId)).toMatchObject({
            document: declaredDocument,
            human: 1,
          });
          const updates = await evaluate<FrameState[]>(
            "globalThis.frameUpdates.filter(state => state.human > 0)",
          );
          expect(updates.length).toBeGreaterThan(0);
          expect(new Set(updates.map((state) => state.document))).toEqual(
            new Set([declaredDocument]),
          );
          expect(updates.every((state) => state.human === 1)).toBe(true);
          expect(executeScript).toHaveBeenCalledOnce();
          await evaluate(`chrome.tabs.remove(${delayed.id})`);
          executeScript.mockClear();

          // Chromium skips a node's `mousewheel` listeners when that node has a
          // `wheel` listener. Wheel capture must keep page handlers running (#550).
          // Passive wheel events reach page script after the input is acknowledged.
          const wheel = async (route: string, counts: Record<string, number>) => {
            const { targetInfos } = await send<{
              targetInfos: { targetId: string; url: string }[];
            }>("Target.getTargets");
            const target = targetInfos.find(
              (target) => target.url === `http://127.0.0.1:${port}${route}`,
            )!;
            const { sessionId: human } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: target.targetId, flatten: true },
            );
            try {
              await send("Page.bringToFront", {}, human);
              await send(
                "Input.dispatchMouseEvent",
                { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: -120 },
                human,
              );
              await expect
                .poll(
                  async () =>
                    (
                      await send<{ result: { value: Record<string, number> } }>(
                        "Runtime.evaluate",
                        { expression: "window.counts", returnByValue: true },
                        human,
                      )
                    ).result.value,
                  { timeout: 3000 },
                )
                .toEqual(counts);
            } finally {
              await send("Target.detachFromTarget", { sessionId: human });
            }
          };
          const legacy = await createTab("/wheel");
          await wheel("/wheel", { mousewheel: 1 });
          await collectCooperationFrames(legacy.id, COOPERATION_READ, "wheel");
          await wheel("/wheel", { mousewheel: 2 });
          // Browsing never transfers control.
          expect(
            (await collectCooperationFrames(legacy.id, COOPERATION_READ, "wheel")).frames.get(0),
          ).toMatchObject({ human: 0 });
          await evaluate(`chrome.tabs.remove(${legacy.id})`);
          expect(executeScript).not.toHaveBeenCalled();

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
          await waitForWorker();
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

          await clickFrame("/");
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
