// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectCooperationFrames } from "@/cooperation/browser-bridge";
import { COOPERATION_OWNERS, COOPERATION_READ, type HiddenFrames } from "@/cooperation/types";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Frame = chrome.webNavigation.GetAllFrameResultDetails;

// #614: a hidden child frame that never answers must not block a whole page,
// while a displayed one must still be named and block it.
describe.skipIf(!process.env.BSK_TEST_CHROME)("hidden frames that do not answer", () => {
  it("records a hidden silent frame as a gap, stops waiting for it and requires it once displayed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-hidden-frames-"));
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      const cross = `http://intranet.test:${(server.address() as { port: number }).port}`;
      response.end(
        request.url === "/busy"
          ? // Cross-site, so it gets its own renderer. Spin after its collector is installed.
            "<!doctype html><p>busy</p><script>setTimeout(() => { for (;;) {} }, 300)</script>"
          : request.url === "/frame"
            ? '<!doctype html><input aria-label="Frame">'
            : request.url === "/owners"
              ? `<!doctype html>
                <iframe id="none" style="display:none" src="/frame"></iframe>
                <iframe id="zero" style="width:0;height:0;border:0" src="/frame"></iframe>
                <iframe id="invisible" style="visibility:hidden" src="/frame"></iframe>
                <iframe id="transparent" style="opacity:0" src="/frame"></iframe>
                <iframe id="shown" src="/frame"></iframe>
                <iframe id="cross" src="${cross}/frame"></iframe>
                <div id="host"></div>
                <script>document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML =
                  '<iframe style="display:none" src="/frame"></iframe>';</script>`
              : `<!doctype html><input aria-label="Page">
                <iframe id="sandbox" style="display:none" src="${cross}/busy"></iframe>
                <iframe src="/frame"></iframe>`,
      );
    });
    try {
      // Use the shipped collector. Build the extension before this regression.
      const cooperationScript = await readFile(
        path.resolve("dist/chrome-mv3/content-scripts/cooperation.js"),
        "utf8",
      );
      await mkdir(path.join(directory, "content-scripts"));
      await writeFile(path.join(directory, "content-scripts/cooperation.js"), cooperationScript);
      const matches = ["http://127.0.0.1/*", "http://intranet.test/*"];
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Hidden frame regression",
          version: "1.0",
          background: { service_worker: "worker.js" },
          permissions: ["tabs", "webNavigation", "scripting"],
          host_permissions: matches,
          content_scripts: [
            {
              matches,
              js: ["content-scripts/cooperation.js"],
              run_at: "document_start",
              all_frames: true,
            },
          ],
        }),
      );
      await writeFile(
        path.join(directory, "worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {}); globalThis.ready = true;",
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const { withChrome } = await import(
        new URL(
          "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
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
                  (target) => target.type === "service_worker" && target.url.endsWith("/worker.js"),
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
          const evaluate = async <T>(expression: string, session = sessionId): Promise<T> => {
            const reply = await send<{
              result: { value: T };
              exceptionDetails?: { exception?: { description?: string }; text: string };
            }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              session,
            );
            if (reply.exceptionDetails)
              throw new Error(
                reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text,
              );
            return reply.result.value;
          };
          await expect.poll(() => evaluate("globalThis.ready"), { timeout: 10000 }).toBe(true);
          // Keep the production bridge and collector; forward only Chrome APIs.
          const getAllFrames = ({ tabId }: { tabId: number }) =>
            evaluate<Frame[]>(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
          const sendMessage = (tabId: number, message: unknown, options: object) =>
            evaluate(
              `chrome.tabs.sendMessage(${tabId},${JSON.stringify(message)},${JSON.stringify(options)})`,
            );
          vi.stubGlobal("chrome", {
            webNavigation: { getAllFrames },
            tabs: { sendMessage },
            scripting: {
              executeScript: (options: object) =>
                evaluate(`chrome.scripting.executeScript(${JSON.stringify(options)})`),
            },
          });
          const open = async (route: string) => {
            const url = `http://127.0.0.1:${port}${route}`;
            const { id } = await evaluate<{ id: number }>(
              `chrome.tabs.create({url:${JSON.stringify(url)}})`,
            );
            await expect
              .poll(() => evaluate(`chrome.tabs.get(${id})`), { timeout: 10000 })
              .toMatchObject({ status: "complete" });
            const { targetInfos } = await send<{
              targetInfos: { targetId: string; url: string }[];
            }>("Target.getTargets");
            const target = targetInfos.find((info) => info.url === url)!;
            const { sessionId: page } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: target.targetId,
              flatten: true,
            });
            return { id, page };
          };

          // The parent collector reports facts from real layout and focus.
          const owners = await open("/owners");
          const [top] = (await getAllFrames({ tabId: owners.id })).filter(
            (frame) => frame.frameId === 0,
          );
          const facts = () =>
            sendMessage(
              owners.id,
              { kind: COOPERATION_OWNERS },
              { documentId: top.documentId },
            ) as Promise<{ hidden: boolean; url: string | null }[]>;
          const same = `http://127.0.0.1:${port}/frame`;
          expect(await facts()).toEqual([
            { hidden: true, url: same }, // display: none
            { hidden: true, url: same }, // no area
            { hidden: true, url: same }, // visibility: hidden
            { hidden: false, url: same }, // opacity 0 is still clickable
            { hidden: false, url: same },
            { hidden: false, url: null }, // cross-origin: unidentified
            { hidden: true, url: same }, // inside a closed shadow root
          ]);
          // A focused frame can receive keys even without area.
          await evaluate('document.getElementById("zero").focus()', owners.page);
          expect((await facts())[1]).toEqual({ hidden: false, url: same });
          await evaluate(`chrome.tabs.remove(${owners.id})`);

          const tab = await open("/");
          const frames = await getAllFrames({ tabId: tab.id });
          const busy = frames.find((frame) => frame.url.endsWith("/busy"))!;
          const shown = frames.find((frame) => frame.url.endsWith("/frame"))!;
          const gap = {
            frame_id: busy.frameId,
            url: `http://intranet.test:${port}/busy`,
            reason: "hidden_frame",
          };
          const collectWith = (memory: HiddenFrames) =>
            collectCooperationFrames(
              tab.id,
              COOPERATION_READ,
              "lease",
              undefined,
              new Map(),
              memory,
            );
          // Chrome may throttle timers in a hidden cross-origin frame to one
          // wake-up per second, so a fixed delay does not prove that the frame
          // has started spinning. Probe with throwaway memory until it is silent.
          await expect
            .poll(async () => (await collectWith(new Set())).gaps, {
              timeout: 15000,
              interval: 100,
            })
            .toEqual([gap]);
          const hidden: HiddenFrames = new Set();
          const collect = () => collectWith(hidden);
          let started = Date.now();
          const first = await collect();
          expect(Date.now() - started).toBeGreaterThanOrEqual(1100);
          expect([...first.frames.keys()].sort()).toEqual([0, shown.frameId].sort());
          expect(first.gaps).toEqual([gap]);
          started = Date.now();
          expect((await collect()).gaps).toEqual([gap]);
          expect(Date.now() - started).toBeLessThan(1000);

          // Once displayed, the same silent frame could receive input again.
          await evaluate('document.getElementById("sandbox").style.display = "block"', tab.page);
          await expect(collect()).rejects.toMatchObject({
            message: `A page frame is not responding: ${gap.frame_id} (${gap.url})`,
            frames: [{ frame_id: gap.frame_id, url: gap.url }],
          });
          expect(hidden.size).toBe(0);
          await evaluate(`chrome.tabs.remove(${tab.id})`);
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
