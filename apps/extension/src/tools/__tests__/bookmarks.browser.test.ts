// @vitest-environment node
// The browser, daemon, and bookmarks belong to temporary directories.
import { execFile, spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { attachVideoBackground, type BrowserSend } from "@/video/browser-fixture";

const run = promisify(execFile);

describe.skipIf(!process.env.BSK_BOOKMARKS_CHROME || !process.env.BSK_BOOKMARKS_BSK)(
  "bookmark CLI/extension integration",
  () => {
    it("preserves bookmark identities while flattening and refuses destructive removal", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "bsk-bookmarks-"));
      const executable = path.resolve(process.env.BSK_BOOKMARKS_BSK!);
      const env = {
        ...process.env,
        BSK_HOME: path.join(directory, "state"),
        BSK_AUTO_START: "0",
        BSK_AUTO_UPDATE: "off",
      };
      const daemon = spawn(executable, ["daemon", "start", "--foreground", "--port", "0"], {
        env,
        stdio: "ignore",
      });
      const cli = async (...args: string[]) =>
        JSON.parse((await run(executable, ["--json", ...args], { env, timeout: 40_000 })).stdout);
      try {
        let port = 0;
        await expect
          .poll(
            async () => {
              try {
                port = (await cli("status")).ws_port;
                return port;
              } catch {
                return 0;
              }
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(0);
        const extension = path.join(directory, "extension");
        await cp(path.resolve("dist/chrome-mv3"), extension, { recursive: true });
        const manifestPath = path.join(extension, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        expect(manifest.optional_permissions).toContain("bookmarks");
        expect(manifest.permissions).not.toContain("bookmarks");
        // Grant only this isolated test extension native API access at installation.
        manifest.name = "BrowserSkill bookmark regression";
        manifest.permissions.push("bookmarks");
        manifest.optional_permissions = manifest.optional_permissions.filter(
          (value: string) => value !== "bookmarks",
        );
        await writeFile(manifestPath, JSON.stringify(manifest));
        const backgroundPath = path.join(extension, "background.js");
        const background = await readFile(backgroundPath, "utf8");
        expect(background).toContain("ws://127.0.0.1:52800");
        await writeFile(
          backgroundPath,
          background.replaceAll("ws://127.0.0.1:52800", `ws://127.0.0.1:${port}`),
        );
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          {
            executable: process.env.BSK_BOOKMARKS_CHROME,
            extensionPath: extension,
            deviceScale: 1,
            zoom: 1,
          },
          async (send: BrowserSend) => {
            await expect
              .poll(async () => (await cli("browsers")).length, { timeout: 15_000 })
              .toBe(1);
            const task = await cli("session", "start", "--no-focus");
            const bookmarks = (...args: string[]) =>
              cli("bookmarks", "--session", task.session_id, ...args);
            try {
              const tree = await bookmarks("tree");
              const bar = tree.nodes[0].children.find(
                (node: { title: string; folderType?: string }) =>
                  node.folderType === "bookmarks-bar" ||
                  node.title.toLowerCase() === "bookmarks bar",
              );
              expect(bar).toBeDefined();
              const parent = (await bookmarks("create-folder", "Top", "--parent", bar.id)).nodes[0];
              const nested = (await bookmarks("create-folder", "Nested", "--parent", parent.id))
                .nodes[0];
              const worker = await attachVideoBackground(send, manifest.name);
              const reply = await send<{
                result: { value: { id: string; title: string; url: string }[] };
                exceptionDetails?: unknown;
              }>(
                "Runtime.evaluate",
                {
                  expression: `Promise.all([chrome.bookmarks.create({parentId:${JSON.stringify(nested.id)},title:'中文 😀',url:'https://example.com/a'}),chrome.bookmarks.create({parentId:${JSON.stringify(nested.id)},title:'Duplicate URL',url:'https://example.com/a'})])`,
                  awaitPromise: true,
                  returnByValue: true,
                },
                worker.sessionId,
              );
              expect(reply.exceptionDetails).toBeUndefined();
              const original = reply.result.value;
              expect(original).toHaveLength(2);
              await expect(bookmarks("remove-empty-folder", nested.id)).rejects.toThrow();
              await expect(bookmarks("remove-empty-folder", original[0].id)).rejects.toThrow();
              await expect(bookmarks("move", bar.id, "--parent", parent.id)).rejects.toThrow();
              for (const [index, node] of original.entries()) {
                const moved = (
                  await bookmarks("move", node.id, "--parent", parent.id, "--index", String(index))
                ).nodes[0];
                expect(moved).toMatchObject({
                  id: node.id,
                  title: node.title,
                  url: node.url,
                  parentId: parent.id,
                });
              }
              expect(await bookmarks("remove-empty-folder", nested.id)).toEqual({
                nodes: [],
                removed_id: nested.id,
              });
              const final = await bookmarks("tree");
              const top = final.nodes[0].children
                .find((node: { id: string }) => node.id === bar.id)
                .children.find((node: { id: string }) => node.id === parent.id);
              expect(top.children.map((node: { id: string }) => node.id)).toEqual(
                original.map((node) => node.id),
              );
              expect(top.children.every((node: { url?: string }) => node.url !== undefined)).toBe(
                true,
              );
              if (process.env.BSK_BOOKMARKS_SCREENSHOT) {
                const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
                  url: `${worker.origin}/popup.html`,
                });
                const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
                  targetId,
                  flatten: true,
                });
                await send("Page.enable", {}, sessionId);
                await expect
                  .poll(
                    async () =>
                      (
                        await send<{ result: { value: boolean } }>(
                          "Runtime.evaluate",
                          {
                            expression: "!!document.querySelector('#bookmark-access')",
                            returnByValue: true,
                          },
                          sessionId,
                        )
                      ).result.value,
                  )
                  .toBe(true);
                await send(
                  "Runtime.evaluate",
                  {
                    expression:
                      "document.querySelector('#bookmark-access').scrollIntoView({block:'center'})",
                  },
                  sessionId,
                );
                await expect
                  .poll(
                    async () =>
                      (
                        await send<{ result: { value: boolean } }>(
                          "Runtime.evaluate",
                          {
                            expression:
                              "(()=>{const b=document.querySelector('#bookmark-access');return !b.disabled && b.getAttribute('aria-checked')==='true'})()",
                            returnByValue: true,
                          },
                          sessionId,
                        )
                      ).result.value,
                  )
                  .toBe(true);
                const screenshot = await send<{ data: string }>(
                  "Page.captureScreenshot",
                  { clip: { x: 0, y: 0, width: 340, height: 650, scale: 1 } },
                  sessionId,
                );
                await writeFile(
                  process.env.BSK_BOOKMARKS_SCREENSHOT,
                  Buffer.from(screenshot.data, "base64"),
                );
              }
            } finally {
              await cli("session", "stop", task.session_id);
            }
          },
        );
      } finally {
        if (daemon.exitCode === null) {
          const exited = once(daemon as unknown as EventEmitter, "exit");
          daemon.kill();
          await exited;
        }
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
