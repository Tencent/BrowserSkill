// Standalone browser contract probe. No extension, credentials or user profile.
// Raw replies and screenshots are written only to the caller-supplied directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error("Pass an absolute evidence output directory");
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const styles = [
  "position",
  "pointer-events",
  "cursor",
  "visibility",
  "opacity",
  "overflow-x",
  "overflow-y",
  "display",
];
const checks = [];
function check(name, condition) {
  checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
}

class Cdp {
  nextId = 0;
  pending = new Map();
  events = [];
  counts = {};
  async connect(url) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data);
      if (!reply.id) {
        this.events.push(reply);
        return;
      }
      const task = this.pending.get(reply.id);
      if (!task) return;
      this.pending.delete(reply.id);
      clearTimeout(task.timer);
      if (reply.error) task.reject(new Error(JSON.stringify(reply.error)));
      else task.resolve(reply.result);
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("CDP closed"));
    }
    this.pending.clear();
    this.socket?.close();
  }
}

function decodedCanvases(snapshot) {
  return snapshot.documents.flatMap((document) => {
    const layoutByNode = new Map(document.layout.nodeIndex.map((node, index) => [node, index]));
    return document.nodes.nodeName.flatMap((name, index) => {
      if (snapshot.strings[name] !== "CANVAS") return [];
      const attrs = document.nodes.attributes[index];
      const attributes = {};
      for (let i = 0; i < attrs.length; i += 2)
        attributes[snapshot.strings[attrs[i]]] = snapshot.strings[attrs[i + 1]];
      const layoutIndex = layoutByNode.get(index) ?? -1;
      return [
        {
          id: attributes.id,
          backendNodeId: document.nodes.backendNodeId[index],
          frameId: snapshot.strings[document.frameId],
          attributes,
          bounds: layoutIndex < 0 ? null : document.layout.bounds[layoutIndex],
          styles:
            layoutIndex < 0
              ? null
              : Object.fromEntries(
                  styles.map((style, i) => [
                    style,
                    snapshot.strings[document.layout.styles[layoutIndex][i]],
                  ]),
                ),
        },
      ];
    });
  });
}

await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "bsk-visual-probe-"));
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, "http://fixture").pathname;
  if (!["/index.html", "/frame.html"].includes(name)) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(await readFile(path.join(fixtureDirectory, name.slice(1))));
  } catch {
    response.writeHead(500).end();
  }
});
const cdp = new Cdp();
let chrome;
let report = {};
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--site-per-process",
      "--window-size=1440,1100",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  chrome.on("error", (error) => {
    report.launchError = error.message;
  });
  let activePort;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      activePort = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
      break;
    } catch {
      await pause(100);
    }
  }
  if (!activePort)
    throw new Error(report.launchError ?? "Chrome did not expose DevToolsActivePort");
  await cdp.connect(`ws://127.0.0.1:${activePort[0]}${activePort[1]}`);
  report.browser = await cdp.send("Browser.getVersion");
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: root } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => cdp.send(method, params, root);
  const evaluate = async (expression, session = root, contextId) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) },
      session,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  async function navigate(url) {
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.readyState === 'complete' && window.fixtureReady === true"))
        return;
      await pause(50);
    }
    throw new Error("Fixture did not become ready");
  }
  const url = `http://127.0.0.1:${port}/index.html`;
  await navigate(`${url}?noFrames=1`);
  async function capture(label) {
    const metrics = await send("Page.getLayoutMetrics");
    const snapshot = await send("DOMSnapshot.captureSnapshot", {
      computedStyles: styles,
      includePaintOrder: true,
      includeDOMRects: true,
    });
    const ax = await send("Accessibility.getFullAXTree");
    const runtime = await evaluate(`Array.from(document.querySelectorAll('canvas'), el => {
      const r=el.getBoundingClientRect(), s=getComputedStyle(el);
      return {id:el.id,rect:{x:r.x,y:r.y,w:r.width,h:r.height},visibility:s.visibility,display:s.display,
        checkVisibility:el.checkVisibility({opacityProperty:true,visibilityProperty:true}),
        dpr:devicePixelRatio,scrollX,scrollY}; })`);
    const result = { metrics, snapshot, ax, runtime, canvases: decodedCanvases(snapshot) };
    await writeFile(path.join(output, `${label}.json`), JSON.stringify(result, null, 2));
    return result;
  }
  const baseline = await capture("root-baseline");
  const rootImage = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(output, "root.png"), Buffer.from(rootImage.data, "base64"));
  const runtime = Object.fromEntries(baseline.runtime.map((node) => [node.id, node]));
  for (const id of [
    "plain",
    "named",
    "aria-hidden",
    "inert",
    "pointer-none",
    "visibility-override",
    "hidden-overridden",
    "fallback",
  ])
    check(`CSS visible: ${id}`, runtime[id].checkVisibility);
  for (const id of ["opacity-parent", "display-none", "visibility-hidden"])
    check(`CSS suppressed: ${id}`, !runtime[id].checkVisibility);
  check("painted text is absent from AX", !JSON.stringify(baseline.ax).includes("PIXEL TABLE 42"));
  report.css = baseline.runtime;
  const bordered = baseline.canvases.find((node) => node.id === "border-canvas");
  report.canvasBox = await send("DOM.getBoxModel", { backendNodeId: bordered.backendNodeId });
  check(
    "Canvas snapshot uses border box",
    bordered.bounds[2] === 130 &&
      report.canvasBox.model.border[2] - report.canvasBox.model.border[0] === 130 &&
      report.canvasBox.model.content[2] - report.canvasBox.model.content[0] === 120,
  );
  const rootDocument = baseline.snapshot.documents[0];
  const ownerNode = rootDocument.nodes.attributes.findIndex((attrs) =>
    attrs.some(
      (value, index) => index % 2 === 1 && baseline.snapshot.strings[value] === "border-clip-owner",
    ),
  );
  const ownerLayout = rootDocument.layout.nodeIndex.indexOf(ownerNode);
  report.clipClientBox = {
    snapshot: rootDocument.layout.clientRects[ownerLayout],
    runtime: await evaluate(
      "(() => {const e=document.getElementById('border-clip-owner');return [e.clientLeft,e.clientTop,e.clientWidth,e.clientHeight]})()",
    ),
  };
  check(
    "snapshot client rect contains local client offsets and size",
    JSON.stringify(report.clipClientBox.snapshot) ===
      JSON.stringify(report.clipClientBox.runtime) &&
      JSON.stringify(report.clipClientBox.runtime) === "[5,5,68,38]",
  );
  report.clips = await evaluate(`['partial-clip','full-clip','axis-clip'].map(id=>{
    const el=document.getElementById(id),p=el.parentElement,s=getComputedStyle(p);
    const a=el.getBoundingClientRect(),b=p.getBoundingClientRect();
    return {id,overflowX:s.overflowX,overflowY:s.overflowY,
      child:{x:a.x,y:a.y,w:a.width,h:a.height},parent:{x:b.x,y:b.y,w:b.width,h:b.height}};
  })`);
  const [partial, full, axis] = report.clips;
  check(
    "partial overflow crop dimensions",
    partial.parent.w === 60 &&
      partial.parent.h === 30 &&
      partial.child.x === partial.parent.x &&
      partial.child.y === partial.parent.y,
  );
  check(
    "fully clipped candidate lies beyond ancestor",
    full.child.x >= full.parent.x + full.parent.w,
  );
  check(
    "single-axis clip remains independent in computed style",
    axis.overflowX === "clip" && axis.overflowY === "visible" && axis.child.h > axis.parent.h,
  );
  const samples = [];
  for (let i = 0; i < 12; i++)
    samples.push(
      await evaluate(
        "JSON.stringify(document.querySelector('#plain').getBoundingClientRect().toJSON())",
      ),
    );
  check("static rect stable over 12 reads", new Set(samples).size === 1);
  await evaluate("document.querySelector('#plain').style.transform='translateX(0.5px)'");
  report.halfPixelMovement = await evaluate(
    "document.querySelector('#plain').getBoundingClientRect().x",
  );
  await evaluate("document.querySelector('#plain').style.transform=''");
  report.raster = [];
  for (const dpr of [1, 1.5, 2]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 900,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    const state = await capture(`dpr-${dpr}`);
    const image = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 20, y: 100, width: 120, height: 40, scale: 1 },
    });
    const bytes = Buffer.from(image.data, "base64");
    const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    report.raster.push({
      dpr,
      dimensions,
      metrics: state.metrics,
      plain: state.canvases.find((node) => node.id === "plain"),
    });
    check(
      `screenshot raster DPR ${dpr}`,
      dimensions.width === 120 * dpr && dimensions.height === 40 * dpr,
    );
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await evaluate("document.body.style.zoom='1.25'");
  const cssZoom = await capture("css-zoom-1.25");
  check(
    "CSS zoom is reflected in snapshot geometry",
    cssZoom.canvases.find((n) => n.id === "plain").bounds[2] === 150,
  );
  report.cssZoom = {
    runtime: cssZoom.runtime[0],
    snapshot: cssZoom.canvases.find((n) => n.id === "plain"),
  };
  await evaluate("document.body.style.zoom=''");
  await send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.5 });
  report.pageScale = (await capture("page-scale-1.5")).metrics;
  await send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await evaluate("scrollTo(0,100)");
  const scrolled = await capture("scroll-100");
  check(
    "snapshot document bounds stable under scroll",
    JSON.stringify(scrolled.canvases.find((n) => n.id === "plain").bounds) ===
      JSON.stringify(baseline.canvases.find((n) => n.id === "plain").bounds),
  );
  check(
    "runtime viewport y follows scroll",
    scrolled.runtime[0].rect.y === baseline.runtime[0].rect.y - 100,
  );
  await navigate(url);
  await pause(200);
  const targets = await cdp.send("Target.getTargets");
  const iframeTarget = targets.targetInfos.find(
    (target) => target.type === "iframe" && target.url.startsWith(`http://localhost:${port}/`),
  );
  check("cross-site frame is an actual OOPIF target", iframeTarget);
  const { sessionId: child } = await cdp.send("Target.attachToTarget", {
    targetId: iframeTarget.targetId,
    flatten: true,
  });
  report.frames = {};
  for (const [name, session] of [
    ["root", root],
    ["oopif", child],
  ]) {
    const tree = await cdp.send("Page.getFrameTree", {}, session);
    const snapshot = await cdp.send(
      "DOMSnapshot.captureSnapshot",
      { computedStyles: styles, includeDOMRects: true },
      session,
    );
    const frameRows = [];
    const stack = [tree.frameTree];
    while (stack.length) {
      const node = stack.pop();
      const world = await cdp.send(
        "Page.createIsolatedWorld",
        { frameId: node.frame.id, worldName: "bsk-design-probe" },
        session,
      );
      const local = await evaluate(
        "({url:location.pathname,innerWidth,innerHeight,scrollX,scrollY,canvas:document.querySelector('canvas').getBoundingClientRect().toJSON()})",
        session,
        world.executionContextId,
      );
      let owner;
      if (node.frame.parentId) {
        // All owners in this fixture live in the root target; child content can be OOPIF.
        const address = await send("DOM.getFrameOwner", { frameId: node.frame.id });
        owner = await send("DOM.getBoxModel", { backendNodeId: address.backendNodeId });
      }
      frameRows.push({ frame: node.frame, local, owner });
      stack.push(...(node.childFrames ?? []));
    }
    report.frames[name] = { tree, snapshot, canvases: decodedCanvases(snapshot), frameRows };
  }
  check(
    "same-target snapshot includes nested documents",
    report.frames.root.snapshot.documents.length === 3,
  );
  check("oopif snapshot isolated from root", report.frames.oopif.snapshot.documents.length === 1);
  const sameRow = report.frames.root.frameRows.find(
    (row) => row.owner && row.local.innerWidth === 300,
  );
  const nestedRow = report.frames.root.frameRows.find(
    (row) => row.owner && row.local.innerWidth === 180,
  );
  check(
    "same frame content origin includes border",
    sameRow.owner.model.content[0] === 50 && sameRow.owner.model.content[1] === 610,
  );
  check(
    "nested owner quad is already target-root relative",
    nestedRow.owner.model.content[0] === 87 && nestedRow.owner.model.content[1] === 707,
  );
  const crossRow = report.frames.oopif.frameRows[0];
  check(
    "OOPIF owner content origin",
    crossRow.owner.model.content[0] === 410 && crossRow.owner.model.content[1] === 610,
  );
  const sameFrame = sameRow.frame.id;
  const world = await send("Page.createIsolatedWorld", {
    frameId: sameFrame,
    worldName: "bsk-design-probe",
  });
  await evaluate("scrollTo(0,10)", root, world.executionContextId);
  const frameScroll = await send("DOMSnapshot.captureSnapshot", {
    computedStyles: styles,
    includeDOMRects: true,
  });
  report.frameScroll = {
    documents: frameScroll.documents.map((d) => ({
      frameId: frameScroll.strings[d.frameId],
      scrollOffsetY: d.scrollOffsetY,
    })),
    canvases: decodedCanvases(frameScroll),
    local: await evaluate(
      "document.querySelector('canvas').getBoundingClientRect().toJSON()",
      root,
      world.executionContextId,
    ),
  };
  check("frame scroll is local", report.frameScroll.local.y === 13);
  check(
    "frame snapshot stays document-relative after child scroll",
    report.frameScroll.canvases.find((n) => n.frameId === sameFrame).bounds[1] === 23,
  );
  await evaluate("scrollTo(0,0)", root, world.executionContextId);
  await evaluate(
    "document.querySelector('#same').style.transformOrigin='0 0';document.querySelector('#same').style.transform='scale(1.25)'",
  );
  const sameOwner = await send("DOM.getFrameOwner", { frameId: sameFrame });
  report.transformedOwner = await send("DOM.getBoxModel", {
    backendNodeId: sameOwner.backendNodeId,
  });
  check(
    "scaled frame owner content width",
    report.transformedOwner.model.content[2] - report.transformedOwner.model.content[0] === 375,
  );
  await evaluate("document.querySelector('#same').style.transform=''");
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(output, "frames.png"), Buffer.from(screenshot.data, "base64"));
  const before = (await send("Page.getFrameTree")).frameTree.frame;
  const oldDocument = (await send("DOM.getDocument")).root.backendNodeId;
  await evaluate("history.replaceState(null,'','#same-document')");
  const sameDocument = (await send("Page.getFrameTree")).frameTree.frame;
  const sameDocumentBackend = (await send("DOM.getDocument")).root.backendNodeId;
  await navigate(`${url}?noFrames=1&navigation=2`);
  const after = (await send("Page.getFrameTree")).frameTree.frame;
  const newDocument = (await send("DOM.getDocument")).root.backendNodeId;
  report.identity = { before, sameDocument, after, oldDocument, sameDocumentBackend, newDocument };
  check("same-document navigation preserves loader", before.loaderId === sameDocument.loaderId);
  check("cross-document navigation changes loader", before.loaderId !== after.loaderId);
  check("frame id survives document replacement", before.id === after.id);
  check(
    "document backend identity changes on navigation",
    oldDocument !== newDocument && oldDocument === sameDocumentBackend,
  );
  const documentTree = await send("DOM.getDocument");
  report.identity.htmlBeforeOpen = documentTree.root.children.find(
    (node) => node.nodeType === 1,
  ).backendNodeId;
  const anchorNode = await send("DOM.querySelector", {
    nodeId: documentTree.root.nodeId,
    selector: "canvas",
  });
  const anchor = await send("DOM.describeNode", { nodeId: anchorNode.nodeId });
  await evaluate(
    "document.open(); document.write('<!doctype html><title>Replacement</title><canvas></canvas>'); document.close()",
  );
  report.identity.documentOpen = (await send("Page.getFrameTree")).frameTree.frame;
  const afterOpenTree = await send("DOM.getDocument");
  report.identity.documentOpenBackend = afterOpenTree.root.backendNodeId;
  report.identity.htmlAfterOpen = afterOpenTree.root.children.find(
    (node) => node.nodeType === 1,
  ).backendNodeId;
  check(
    "document.open replaces documentElement identity",
    report.identity.htmlBeforeOpen !== report.identity.htmlAfterOpen,
  );
  try {
    const object = await send("DOM.resolveNode", { backendNodeId: anchor.node.backendNodeId });
    const connected = await send("Runtime.callFunctionOn", {
      objectId: object.object.objectId,
      functionDeclaration: "function(){return this.isConnected}",
      returnByValue: true,
    });
    report.identity.oldAnchorConnected = connected.result.value;
  } catch {
    report.identity.oldAnchorConnected = false;
  }
  check(
    "document.open invalidates old anchor even if document identifiers survive",
    report.identity.oldAnchorConnected === false,
  );
  report.counts = cdp.counts;
  report.checks = checks;
  process.stdout.write(
    `${JSON.stringify({ browser: report.browser.product, checks: checks.length, output })}\n`,
  );
} catch (error) {
  report.error = error.stack;
  report.checks = checks;
  process.exitCode = 1;
  process.stderr.write(`${error.stack}\n`);
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  cdp.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await Promise.race([exited, pause(2000)]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await exited;
    }
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
