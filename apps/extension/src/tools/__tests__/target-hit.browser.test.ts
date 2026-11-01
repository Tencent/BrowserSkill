// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; the fixture owns its browser, profile and server.
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { CdpFrameGraph, CdpFrameTreeNode } from "@/browser-driver/frame-graph";
import { pointerTargetValidator } from "@/cooperation/pointer-target";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

it.skipIf(!process.env.BSK_CLICK_CHROME)(
  "keeps selector hits inside their document and clicks frame refs through checked ancestors",
  async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      const button = `<button id="button" style="width:100%;height:100%">Frame button</button>
        <script>window.clicks=0;document.querySelector('button').onclick=()=>clicks++;</script>`;
      response.end(
        request.url === "/child"
          ? `<!doctype html><style>html,body{margin:0;height:100%}</style>${button}`
          : `<!doctype html><style>
              body{margin:0}#plain{height:40px}#container{width:400px;height:150px}
              iframe{display:block;width:400px;height:150px;border:0}
              #cover{display:none;position:fixed;inset:0;background:white;z-index:2}
            </style>
            <button id="plain">Plain button</button>
            <div id="container"><iframe id="same" src="/child"></iframe></div>
            <iframe id="cross" src="http://localhost:${(server.address() as { port: number }).port}/child"></iframe>
            <div id="cover"></div>
            <script>window.clicks=0;document.querySelector('#plain').onclick=()=>clicks++;</script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1 },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: `http://127.0.0.1:${port}/`,
          });
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          const local = <T = Record<string, unknown>>(method: string, params?: object) =>
            send<T>(method, params, sessionId);
          const evaluate = async <T>(expression: string, childSession = sessionId) => {
            const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              childSession,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          await expect
            .poll(() =>
              evaluate(
                "document.querySelector('#same')?.contentDocument?.querySelector('#button') != null",
              ),
            )
            .toBe(true);
          let crossTarget: { targetId: string; type: string; url: string } | undefined;
          await expect
            .poll(async () => {
              const { targetInfos } = await send<{
                targetInfos: NonNullable<typeof crossTarget>[];
              }>("Target.getTargets");
              crossTarget = targetInfos.find(
                (target) =>
                  target.type === "iframe" && target.url === `http://localhost:${port}/child`,
              );
              return !!crossTarget;
            })
            .toBe(true);
          const { sessionId: crossSession } = await send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId: crossTarget!.targetId, flatten: true },
          );
          await expect.poll(() => evaluate("typeof clicks", crossSession)).toBe("number");
          const { frameTree } = await local<{ frameTree: CdpFrameTreeNode }>("Page.getFrameTree");
          const root = { tabId: 4 };
          const graph: CdpFrameGraph = {
            rootFrameId: frameTree.frame.id,
            frames: [{ frameId: frameTree.frame.id, target: root }],
          };
          const sameFrame = frameTree.childFrames!.find(
            (child) => child.frame.url === `http://127.0.0.1:${port}/child`,
          )!;
          const { frameTree: crossTree } = await send<{ frameTree: CdpFrameTreeNode }>(
            "Page.getFrameTree",
            {},
            crossSession,
          );
          for (const [frameId, childSession] of [
            [sameFrame.frame.id, undefined],
            [crossTree.frame.id, crossSession],
          ] as const) {
            const owner = await local<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId });
            graph.frames.push({
              frameId,
              parentFrameId: graph.rootFrameId,
              ownerBackendNodeId: owner.backendNodeId,
              target: { tabId: 4, ...(childSession ? { sessionId: childSession } : {}) },
            });
          }
          let presses = 0;
          const dispatch: CdpRunner["sendToTarget"] = async (target, method, params) => {
            if (
              method === "Input.dispatchMouseEvent" &&
              (params as { type?: string }).type === "mousePressed"
            )
              presses++;
            return send(method, params, target.sessionId ?? sessionId) as never;
          };
          const cdp: CdpRunner = {
            send: (tab, method, params) => dispatch({ tabId: tab }, method, params),
            sendToTarget: dispatch,
            getFrameGraph: async () => graph,
            getAttachmentId: () => sessionId,
          };
          cdp.verifyPointerTarget = pointerTargetValidator(cdp);
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [] }),
              remove: async () => {},
              ensureActiveTab: async () => 4,
            },
          });
          const ctx = await manager.start("frame-hit-test");
          const tab = { id: 4, windowId: 100, active: true } as chrome.tabs.Tab;
          const click = (target: { selector?: string; ref?: string }) =>
            handleClick(
              manager,
              { session_id: ctx.sessionId, ...target },
              {
                cdp,
                tabsApi: { get: async () => tab, query: async () => [tab] },
              },
            );
          const sameClicks = () =>
            evaluate<number>("document.querySelector('#same').contentWindow.clicks");
          for (const selector of ["#container", "#same"]) {
            const before = presses;
            expect(await click({ selector })).toMatchObject({
              message: "The pointer target is covered or unavailable; synchronize before clicking",
              data: { effect_state: "none" },
            });
            expect(presses).toBe(before);
            expect(await sameClicks()).toBe(0);
          }
          expect(await click({ selector: "#plain" })).toMatchObject({ used_selector: "#plain" });
          expect(await evaluate("clicks")).toBe(1);

          for (const [ref, expression, frameId, childSession] of [
            [
              "e1",
              "document.querySelector('#same').contentDocument.querySelector('#button')",
              sameFrame.frame.id,
              undefined,
            ],
            ["e2", "document.querySelector('#button')", crossTree.frame.id, crossSession],
          ] as const) {
            const { result } = await send<{ result: { objectId: string } }>(
              "Runtime.evaluate",
              { expression },
              childSession ?? sessionId,
            );
            const { node } = await send<{ node: { backendNodeId: number } }>(
              "DOM.describeNode",
              { objectId: result.objectId },
              childSession ?? sessionId,
            );
            await send(
              "Runtime.releaseObject",
              { objectId: result.objectId },
              childSession ?? sessionId,
            );
            ctx.refStore.set(ref, node.backendNodeId, {
              tabId: 4,
              frameId,
              ...(childSession ? { cdpSessionId: childSession } : {}),
            });
            expect(await click({ ref })).toMatchObject({ used_ref: ref });
            const before = presses;
            await evaluate("document.querySelector('#cover').style.display='block'");
            expect(await click({ ref })).toMatchObject({
              message: "The pointer target is covered or unavailable; synchronize before clicking",
              data: { effect_state: "none" },
            });
            expect(presses).toBe(before);
            await evaluate("document.querySelector('#cover').style.display='none'");
          }
          expect(await sameClicks()).toBe(1);
          expect(await evaluate("clicks", crossSession)).toBe(1);
          expect(presses).toBe(3);
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
