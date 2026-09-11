// @vitest-environment node
// Real CLI -> isolated daemon -> shipped extension. No installed CLI or user
// profile is touched. Build both artifacts and opt in with the two env vars.
import { spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function poll<T>(read: () => Promise<T | false | undefined>, timeout = 20_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Agent screenshot condition timed out");
}

async function withAgent(
  run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
  scale = 1,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "bsk-agent-screenshot-"));
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      fixture(req.url?.includes("large") ? 34_003 : 2603) +
        `
      <canvas id="noise" width="256" height="512" style="position:absolute;left:200px;top:100px"></canvas>
      <script>const c=document.querySelector('#noise'),ctx=c.getContext('2d'),d=ctx.createImageData(c.width,c.height);let n=7;
      for(let i=0;i<d.data.length;i++){n=(Math.imul(n,1664525)+1013904223)|0;d.data[i]=i%4===3?255:n>>>24;}ctx.putImageData(d,0,0);</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const portServer = createServer();
  await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const env = { ...process.env, BSK_HOME: directory, BSK_AUTO_START: "0" };
  const cli = process.env.BSK_LONG_SCREENSHOT_CLI!;
  const daemon = spawn(cli, ["daemon", "start", "--foreground", "--port", String(port)], {
    env,
    stdio: "ignore",
  });
  try {
    const info = await poll(async () => {
      try {
        return JSON.parse(await readFile(path.join(directory, "daemon.json"), "utf8"));
      } catch {
        return false;
      }
    });
    const { withChrome } = await import(
      new URL(
        "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    await withChrome(
      {
        executable: process.env.BSK_LONG_SCREENSHOT_CHROME,
        deviceScale: scale,
        zoom: 1,
        extensionPath: path.resolve("dist/chrome-mv3"),
        softwareRendering: true,
        headless: process.env.BSK_LONG_SCREENSHOT_HEADED !== "1",
      },
      async (send: Send) => run(await harness(send, directory, baseUrl, port, info, cli, env)),
    );
  } finally {
    daemon.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function harness(
  send: Send,
  directory: string,
  baseUrl: string,
  port: number,
  info: { sock_path: string },
  cli: string,
  env: NodeJS.ProcessEnv,
) {
  const targets = () =>
    send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
  const worker = await poll(async () =>
    (await targets()).targetInfos.find(
      (t) => t.type === "service_worker" && t.url.endsWith("/background.js"),
    ),
  );
  const origin = worker.url.split("/").slice(0, 3).join("/");
  const extensionTarget = await send<{ targetId: string }>("Target.createTarget", {
    url: `${origin}/popup.html`,
    background: true,
  });
  const workerSession = (
    await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: extensionTarget.targetId,
      flatten: true,
    })
  ).sessionId;
  const evaluate = async <T>(expression: string, sessionId = workerSession): Promise<T> => {
    const value = await send<{ result: { value: T }; exceptionDetails?: object }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  await poll(() => evaluate<boolean>("!!globalThis.chrome?.storage?.local"));
  await evaluate(`chrome.storage.local.set({bsk_daemon_port:${port},bh_connection_enabled:true})`);
  const command = (args: string[]) => {
    const child = spawn(cli, [...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (b) => {
          stdout += b;
        });
        child.stderr.on("data", (b) => {
          stderr += b;
        });
        void once(child as unknown as EventEmitter, "close").then(
          ([code]) => resolve({ code, stdout, stderr }),
          reject,
        );
      },
    );
    return { child, done };
  };
  const ok = async (args: string[]) => {
    const result = await command(args).done;
    if (result.code !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  };
  await poll(async () => ((await ok(["status"])).browsers?.length ?? 0) > 0);
  // Raw session setup avoids the CLI session-start skill auto-sync in the host's
  // home directory. All screenshot operations below use the actual CLI binary.
  const rpc = (method: string, params: object) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const socket = createConnection(info.sock_path);
      let data = "";
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(JSON.stringify({ id: crypto.randomUUID(), method, params }) + "\n"),
      );
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          socket.end();
          const reply = JSON.parse(data.split("\n")[0]);
          if (reply.error) reject(new Error(JSON.stringify(reply.error)));
          else resolve(reply.result);
        }
      });
    });
  const started = await rpc("session.start", { width: 900, height: 720 });
  const session = started.session_id as string;
  await ok(["navigate", baseUrl, "--session", session]);
  const tabId = await evaluate<number>(`(async()=>{
    const tabs=await chrome.tabs.query({windowId:${started.agent_window_id}});
    return tabs.find(t=>t.url.startsWith(${JSON.stringify(baseUrl)})).id;
  })()`);
  // Read page state through the session's existing debugger attachment.
  const onPage = async <T>(expression: string): Promise<T> => {
    const value = await evaluate<{ result: { value: T }; exceptionDetails?: object }>(
      `chrome.debugger.sendCommand({tabId:${tabId}},'Runtime.evaluate',${JSON.stringify({ expression, returnByValue: true, awaitPromise: true })})`,
    );
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const restored = () =>
    onPage<{ y: number; style: string | null; nodes: number }>(
      `({y:scrollY,style:document.body.getAttribute('style'),nodes:document.documentElement.children.length,styles:[...document.querySelectorAll('#sticky,#fixed,#footer')].map(e=>e.getAttribute('style')),hiddenOverlays:document.querySelectorAll('[data-bsk-capture-hidden]').length})`,
    );
  const scratch = () =>
    evaluate<string[]>(
      `(async()=>{try {const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('long-screenshots');return (await Array.fromAsync(d.keys())).filter(n=>n.startsWith('agent-'));}catch{return []}})()`,
    );
  return { directory, baseUrl, session, command, ok, onPage, restored, scratch, rpc };
}

function verifyPng(png: Buffer, expectedHeight: number, scale = 1) {
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  expect(height).toBe(expectedHeight);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      chunks.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const data = inflateSync(Buffer.concat(chunks));
  expect(data.length).toBe(height * (width * 4 + 1));
  const previous = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    if (data[at] !== 2) throw new Error(`Unexpected PNG filter on row ${y}`);
    for (let x = 0; x < previous.length; x++) previous[x] = (previous[x] + data[at + x + 1]) & 255;
    const row = Math.floor(y / scale) - 31;
    const sample = 400 * scale;
    if (
      row >= 0 &&
      (previous[sample] !== row % 256 ||
        previous[sample + 1] !== Math.floor(row / 256) ||
        previous[sample + 2] !== 127)
    )
      throw new Error(
        `Stitched row ${y} differs from page pixels: ${previous.slice(sample, sample + 4)}`,
      );
    const right = (width - 40 * scale) * 4;
    if (
      y >= height - 80 * scale &&
      (previous[right] !== 255 || previous[right + 1] !== 136 || previous[right + 2] !== 0)
    )
      throw new Error(`Fixed footer missing on row ${y}`);
  }
}

describe.skipIf(!process.env.BSK_LONG_SCREENSHOT_CHROME || !process.env.BSK_LONG_SCREENSHOT_CLI)(
  "Agent full-page screenshots",
  () => {
    it.each([1, 2])(
      "captures exact full-page pixels at scale %i through the CLI and releases all export files",
      (scale) =>
        withAgent(async (h) => {
          const original = await h.restored();
          const out = path.join(h.directory, "full.png");
          const reply = await h.ok([
            "screenshot",
            "--session",
            h.session,
            "--full-page",
            "--out",
            out,
          ]);
          const png = await readFile(out);
          expect(reply.byte_size).toBe(png.length);
          expect(png.length).toBeGreaterThan(256 * 1024);
          verifyPng(png, 2634 * scale, scale);
          expect(await h.restored()).toEqual(original);
          expect(await h.scratch()).toEqual([]);
          const viewport = await h.ok([
            "screenshot",
            "--session",
            h.session,
            "--out",
            path.join(h.directory, "viewport.png"),
          ]);
          expect(viewport.height).toBeLessThan(reply.height);
          expect(viewport.width).toBeGreaterThan(0);
        }, scale),
      120_000,
    );

    it(
      "restores the page on timeout and Ctrl-C without replacing an existing output",
      () =>
        withAgent(async (h) => {
          const original = await h.restored();
          const out = path.join(h.directory, "previous.png");
          await writeFile(out, "previous image");
          const timed = await h.command([
            "screenshot",
            "--session",
            h.session,
            "--full-page",
            "--timeout",
            "600ms",
            "--out",
            out,
          ]).done;
          expect(timed.code).not.toBe(0);
          expect(timed.stderr + timed.stdout).toContain("timeout");
          await poll(async () => (await h.restored()).y === original.y);
          expect(await h.scratch()).toEqual([]);
          const pending = h.command([
            "screenshot",
            "--session",
            h.session,
            "--full-page",
            "--out",
            out,
          ]);
          await poll(async () => (await h.onPage<number>("scrollY")) !== original.y);
          pending.child.kill("SIGINT");
          const stopped = await pending.done;
          expect(stopped.code).not.toBe(0);
          expect(stopped.stderr + stopped.stdout).toContain("cancelled");
          await poll(async () => (await h.restored()).y === original.y);
          await poll(async () => (await h.scratch()).length === 0);
          expect(await readFile(out, "utf8")).toBe("previous image");
          expect((await readdir(h.directory)).filter((n) => n.endsWith(".part"))).toEqual([]);
        }),
      120_000,
    );

    it(
      "honors the page's Escape cancel button without opening a popup result",
      () =>
        withAgent(async (h) => {
          const original = await h.restored();
          const out = path.join(h.directory, "cancelled.png");
          const pending = h.command([
            "screenshot",
            "--session",
            h.session,
            "--full-page",
            "--out",
            out,
          ]);
          await poll(async () => (await h.onPage<number>("scrollY")) !== original.y);
          await h.onPage("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
          const stopped = await pending.done;
          expect(stopped.code).not.toBe(0);
          expect(stopped.stderr + stopped.stdout).toContain("cancelled");
          expect(await h.restored()).toEqual(original);
          expect(await h.scratch()).toEqual([]);
          expect((await readdir(h.directory)).includes("cancelled.png")).toBe(false);
        }),
      120_000,
    );

    it(
      "captures pages beyond 32K pixels and cleans up after a local output error",
      () =>
        withAgent(async (h) => {
          await h.ok(["navigate", `${h.baseUrl}/large`, "--session", h.session]);
          const original = await h.restored();
          const out = path.join(h.directory, "large.png");
          const result = await h.ok([
            "screenshot",
            "--session",
            h.session,
            "--full-page",
            "--timeout",
            "3m",
            "--out",
            out,
          ]);
          expect(result.height).toBe(34_034);
          verifyPng(await readFile(out), 34_034);
          expect(await h.restored()).toEqual(original);
          expect(await h.scratch()).toEqual([]);
          await h.ok(["navigate", h.baseUrl, "--session", h.session]);
          const failed = await h.command([
            "screenshot",
            "--session",
            h.session,
            "--full-page",
            "--out",
            path.join(h.directory, "missing", "out.png"),
          ]).done;
          expect(failed.code).not.toBe(0);
          expect(await h.scratch()).toEqual([]);
        }),
      240_000,
    );
  },
);
