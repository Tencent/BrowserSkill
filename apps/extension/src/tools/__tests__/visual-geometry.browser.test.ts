// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CdpFrame } from "@/browser-driver/frame-graph";
import type { CdpRunner } from "../shared";
import { captureVisualScreenshot } from "../visual-screenshot";
import { resolveVisualRegionNow, verifyVisualHit } from "../visual-target";
import { captureObservationFacts } from "../vom/capture-coordinator";
import { discoverVisualCandidates, type VisualCandidate } from "../vom/visual-discovery";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Tree = { frame: { id: string }; childFrames?: Tree[] };
type Rect = { x: number; y: number; width: number; height: number };

// Uses an isolated native Chrome profile and the production snapshot/live/screenshot
// paths. Fixture dimensions and browser hit testing provide independent expectations.
async function withPage(
  run: (page: {
    cdp: CdpRunner;
    send: Send;
    load: (html: string) => Promise<void>;
    evaluate: <T>(expression: string) => Promise<T>;
    observe: () => Promise<VisualCandidate>;
  }) => Promise<void>,
) {
  const evalRoot = new URL("../../../../../evals/browser/", import.meta.url);
  const { withChrome } = await import(
    new URL("cases/regression/snapshot-coordinates/chrome.mjs", evalRoot).href
  );
  await withChrome(
    { executable: process.env.BSK_GEOMETRY_CHROME, deviceScale: 1, zoom: 1 },
    async (send: Send) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await send("Target.activateTarget", { targetId });
      const local: Send = (method, params) => send(method, params, sessionId);
      const { frameTree } = await local<{ frameTree: Tree }>("Page.getFrameTree");
      const cdp: CdpRunner = {
        send: (_tab, method, params) => local(method, params),
        getAttachmentId: () => "visual-geometry-browser-test",
        getFrameGraph: async () => {
          const { frameTree } = await local<{ frameTree: Tree }>("Page.getFrameTree");
          const frames: CdpFrame[] = [];
          const visit = async (tree: Tree, parentFrameId?: string) => {
            const owner = parentFrameId
              ? await local<{ backendNodeId: number }>("DOM.getFrameOwner", {
                  frameId: tree.frame.id,
                })
              : undefined;
            frames.push({
              frameId: tree.frame.id,
              target: { tabId: 1 },
              parentFrameId,
              ownerBackendNodeId: owner?.backendNodeId,
            });
            for (const child of tree.childFrames ?? []) await visit(child, tree.frame.id);
          };
          await visit(frameTree);
          return { rootFrameId: frameTree.frame.id, frames };
        },
      };
      await run({
        cdp,
        send: local,
        load: async (html) => {
          await local("Page.setDocumentContent", {
            frameId: frameTree.frame.id,
            html: `<!doctype html>${html}`,
          });
          await local("Runtime.evaluate", {
            expression:
              "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            awaitPromise: true,
          });
        },
        evaluate: async <T>(expression: string) => {
          const reply = await local<{ result: { value: T }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        },
        observe: async () => {
          const facts = await captureObservationFacts(cdp, 1, undefined, undefined, {
            includeVisualFacts: true,
          });
          const discovered = await discoverVisualCandidates(facts);
          expect(discovered.issues).toEqual([]);
          expect(discovered.candidates).toHaveLength(1);
          return discovered.candidates[0];
        },
      });
    },
  );
}

async function expectCapture(cdp: CdpRunner, candidate: VisualCandidate, crop: Rect) {
  expect(candidate.region.crop).toEqual(crop);
  const live = await resolveVisualRegionNow(cdp, candidate);
  if ("code" in live) throw new Error(live.message);
  expect(live.crop).toEqual(crop);
  const shot = await captureVisualScreenshot(cdp, candidate);
  if ("code" in shot) throw new Error(shot.message);
  expect(shot.mapping?.crop).toEqual(crop);
  // Read the actual PNG header, not just the requested clip or response metadata.
  const png = Buffer.from(shot.image_base64, "base64");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([crop.width, crop.height]);
  const point = { x: crop.x + crop.width - 1, y: crop.y + crop.height - 1 };
  expect(await verifyVisualHit(cdp, live, point)).toBe(true);
  return live;
}

const canvas = '<canvas width="200" height="200" style="display:block;background:red"></canvas>';
const bodyStyle = "margin:0;width:100px;height:100px;";

describe.skipIf(!process.env.BSK_GEOMETRY_CHROME)(
  "native Canvas viewport overflow and rendered ancestry",
  { timeout: 30_000 },
  () => {
    it.each([
      { name: "body hidden propagates", root: "", body: "overflow:hidden", size: 200 },
      { name: "body auto propagates", root: "", body: "overflow:auto", size: 200 },
      { name: "body clip propagates", root: "", body: "overflow:clip", size: 200 },
      {
        name: "root hidden clips the viewport",
        root: "overflow:hidden;width:100px;height:100px",
        body: "",
        size: 200,
      },
      {
        name: "root clip clips the viewport",
        root: "overflow:clip;width:100px;height:100px",
        body: "",
        size: 200,
      },
      {
        name: "body remains local under root hidden",
        root: "overflow:hidden",
        body: "overflow:hidden",
        size: 100,
      },
      {
        name: "body remains local under root axis overflow",
        root: "overflow-x:clip",
        body: "overflow:hidden",
        size: 100,
      },
      ...[
        "contain:size",
        "contain:layout",
        "contain:style",
        "container-type:inline-size",
        "content-visibility:auto",
      ].flatMap((containment) => [
        {
          name: `root ${containment} prevents propagation`,
          root: containment,
          body: "overflow:hidden",
          size: 100,
        },
        {
          name: `body ${containment} prevents propagation`,
          root: "",
          body: `overflow:hidden;${containment}`,
          size: 100,
        },
      ]),
    ])("$name", async ({ root, body, size }) => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(`<style>html{${root}}body{${bodyStyle}${body}}</style>${canvas}`);
        // This point lies outside the body's 100px box but inside the Canvas box.
        expect(
          await evaluate("document.elementFromPoint(150,150) === document.querySelector('canvas')"),
        ).toBe(size === 200);
        await expectCapture(cdp, await observe(), { x: 0, y: 0, width: size, height: size });
      });
    });

    it("retains nested element clipping and rejects changed overflow propagation", async () => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(
          `<style>body{${bodyStyle}overflow:hidden}</style><div style="width:80px;height:70px;overflow:hidden">${canvas}</div>`,
        );
        await expectCapture(cdp, await observe(), { x: 0, y: 0, width: 80, height: 70 });
        await load(`<style>body{${bodyStyle}overflow:hidden}</style>${canvas}`);
        const candidate = await observe();
        await evaluate("document.documentElement.style.overflow = 'hidden'");
        expect(await resolveVisualRegionNow(cdp, candidate)).toMatchObject({
          data: { reason: "visual_target_changed" },
        });
        await expectCapture(cdp, await observe(), { x: 0, y: 0, width: 100, height: 100 });
      });
    });

    it("applies body propagation inside a clipped iframe viewport", async () => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(
          "<style>body{margin:0}iframe{display:block;border:0;width:160px;height:140px;margin:20px}</style><iframe></iframe>",
        );
        await evaluate(`new Promise(resolve => {
        const frame = document.querySelector('iframe'); frame.onload = () => resolve(true);
        frame.srcdoc = ${JSON.stringify(`<!doctype html><style>body{${bodyStyle}overflow:hidden}</style>${canvas}`)};
      })`);
        expect(
          await evaluate(
            "document.querySelector('iframe').contentDocument.elementFromPoint(150,130).tagName",
          ),
        ).toBe("CANVAS");
        await expectCapture(cdp, await observe(), { x: 20, y: 20, width: 160, height: 140 });
      });
    });

    it.each([
      "open",
      "closed",
    ])("follows %s slot clips and invalidates changed distribution", async (mode) => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(`<style>body{margin:0}</style><div id="host">${canvas}</div>`);
        await evaluate(`{
        const root = document.querySelector('#host').attachShadow({mode:${JSON.stringify(mode)}});
        root.innerHTML = '<div style="width:100px;height:100px;overflow:hidden"><slot style="display:block;overflow:hidden;width:80px;height:90px"></slot></div><slot name="other" style="display:block"></slot>';
        window.testRoot = root;
      }`);
        const candidate = await observe();
        const live = await expectCapture(cdp, candidate, { x: 0, y: 0, width: 80, height: 90 });
        expect(await verifyVisualHit(cdp, live, { x: 90, y: 50 })).toBe(false);
        await evaluate("window.testRoot.querySelector('slot').style.width = '70px'");
        expect(await resolveVisualRegionNow(cdp, candidate)).toMatchObject({
          data: { reason: "visual_target_changed" },
        });
        const beforeRedistribution = await observe();
        await expectCapture(cdp, beforeRedistribution, { x: 0, y: 0, width: 70, height: 90 });
        await evaluate("document.querySelector('canvas').slot = 'other'");
        expect(await resolveVisualRegionNow(cdp, beforeRedistribution)).toMatchObject({
          data: { reason: "visual_target_changed" },
        });
        await expectCapture(cdp, await observe(), { x: 0, y: 100, width: 200, height: 200 });
      });
    });

    it.each([
      "open",
      "closed",
    ])("follows nested %s slots with reassigned slot elements", async (mode) => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(`<style>body{margin:0}</style><div id="host">${canvas}</div>`);
        await evaluate(`{
        const outer = document.querySelector('#host').attachShadow({mode:${JSON.stringify(mode)}});
        outer.innerHTML = '<div id="inner"><slot style="display:block"></slot></div>';
        const inner = outer.querySelector('#inner').attachShadow({mode:${JSON.stringify(mode)}});
        inner.innerHTML = '<div style="width:90px;height:60px;overflow:hidden"><slot style="display:block"></slot></div>';
      }`);
        await expectCapture(cdp, await observe(), { x: 0, y: 0, width: 90, height: 60 });
      });
    });

    it("does not shift the viewport clip by the root margin or border", async () => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(
          `<style>html{margin:30px 0 0 40px;border:5px solid;overflow:hidden;width:100px;height:100px}body{margin:0}canvas{position:relative;left:-40px;top:-30px}</style>${canvas}`,
        );
        expect(
          await evaluate("document.elementFromPoint(10,10) === document.querySelector('canvas')"),
        ).toBe(true);
        await expectCapture(cdp, await observe(), { x: 5, y: 5, width: 200, height: 200 });
      });
    });

    it("clips propagated overflow at the viewport after scrolling", async () => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(
          `<style>body{${bodyStyle}overflow:hidden}canvas{width:2000px;height:2000px}</style>${canvas}`,
        );
        await evaluate("scrollTo(20,30)");
        const viewport = await evaluate<Rect>("({x:0,y:0,width:innerWidth,height:innerHeight})");
        const candidate = await observe();
        expect(candidate.region.borderBox).toMatchObject({ x: -20, y: -30 });
        await expectCapture(cdp, candidate, viewport);
      });
    });

    it("rejects a closed slot reassigned during the live read and releases its objects", async () => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load(`<style>body{margin:0}</style><div id="host">${canvas}</div>`);
        await evaluate(
          `document.querySelector('#host').attachShadow({mode:'closed'}).innerHTML = '<slot style="display:block;width:100px;height:100px;overflow:hidden"></slot><slot name="other" style="display:block"></slot>'`,
        );
        const candidate = await observe();
        let changed = false;
        const resolvedGroups: string[] = [],
          releasedGroups: string[] = [];
        const racing: CdpRunner = {
          ...cdp,
          send: async <T>(tabId: number, method: string, params?: object) => {
            const reply = await cdp.send<T>(tabId, method, params);
            if (method === "DOM.resolveNode")
              resolvedGroups.push((params as { objectGroup: string }).objectGroup);
            if (method === "Runtime.releaseObjectGroup")
              releasedGroups.push((params as { objectGroup: string }).objectGroup);
            if (method === "DOM.describeNode" && !changed) {
              changed = true;
              await evaluate("document.querySelector('canvas').slot = 'other'");
            }
            return reply;
          },
        };
        expect(await resolveVisualRegionNow(racing, candidate)).toMatchObject({
          data: { reason: "visual_target_changed" },
        });
        expect(changed).toBe(true);
        expect(resolvedGroups).toHaveLength(2);
        expect(new Set(resolvedGroups)).toEqual(new Set(releasedGroups));
      });
    });

    it("preserves direct children of closed shadow roots", async () => {
      await withPage(async ({ cdp, load, evaluate, observe }) => {
        await load('<style>body{margin:0}</style><div id="host"></div>');
        await evaluate(
          `document.querySelector('#host').attachShadow({mode:'closed'}).innerHTML = ${JSON.stringify(canvas)}`,
        );
        await expectCapture(cdp, await observe(), { x: 0, y: 0, width: 200, height: 200 });
      });
    });
  },
);
