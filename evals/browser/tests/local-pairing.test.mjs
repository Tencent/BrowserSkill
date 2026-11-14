import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyIsolatedExtension, copyPairingExtension } from "../local-pairing.mjs";

test("copyIsolatedExtension rewrites daemon WebSocket ports across nested bundles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bsk-isolated-ext-"));
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "dst");
    await mkdir(path.join(src, "chunks"), { recursive: true });
    await writeFile(path.join(src, "manifest.json"), '{"name":"BrowserSkill"}\n');
    await writeFile(
      path.join(src, "background.js"),
      'const ws = "ws://127.0.0.1:52800";\nconsole.log(ws);\n',
    );
    await writeFile(
      path.join(src, "chunks", "client.js"),
      'export const endpoint = "ws://127.0.0.1:52800";\n',
    );

    const returned = await copyIsolatedExtension(src, dst, 52923);
    assert.equal(returned, dst);

    const background = await readFile(path.join(dst, "background.js"), "utf8");
    const chunk = await readFile(path.join(dst, "chunks", "client.js"), "utf8");
    assert.equal(background.includes("ws://127.0.0.1:52923"), true);
    assert.equal(background.includes("ws://127.0.0.1:52800"), false);
    assert.equal(chunk.includes("ws://127.0.0.1:52923"), true);
    assert.equal(chunk.includes("ws://127.0.0.1:52800"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copyPairingExtension seeds pairing storage and rewrites WebSocket port", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bsk-pairing-ext-"));
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "dst");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "manifest.json"), '{"name":"BrowserSkill"}\n');
    await writeFile(path.join(src, "background.js"), 'const ws = "ws://127.0.0.1:52800";\n');

    await copyPairingExtension(src, dst, 52837);
    const background = await readFile(path.join(dst, "background.js"), "utf8");
    assert.equal(background.includes("bsk_daemon_port:52837"), true);
    assert.equal(background.includes("ws://127.0.0.1:52837"), true);
    assert.equal(background.includes("ws://127.0.0.1:52800"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
