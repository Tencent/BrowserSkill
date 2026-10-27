import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createDshRegressionClient } from "./dsh-client.mjs";

/** Independent file bytes and server effects, exercised through both shipped clients. */
export async function runCompatibilityScenarios({ send, bsk, cli, env, directory, headful }) {
  const html = await readFile(new URL("compatibility.html", import.meta.url));
  const bytes = Buffer.concat([
    Buffer.from([0, 255, 13, 10, ...Buffer.from("协作 file roundtrip")]),
    Buffer.alloc(8192, 97),
  ]);
  const humanBytes = Buffer.from("independent human download");
  const file = join(directory, "协作 sample.bin");
  await writeFile(file, bytes);
  const uploads = [];
  const slow = new Map();
  let slowStarts = 0;
  let downloads = 0;
  const serve = async (req, res) => {
    const path = new URL(req.url, "http://localhost");
    if (path.pathname === "/upload") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), bytes, "uploaded bytes changed");
      uploads.push(path.searchParams.get("kind"));
      res.end("ok");
    } else if (path.pathname === "/human") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=human-owned.bin",
      });
      res.end(humanBytes);
    } else if (path.pathname === "/redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${remote.address().port}/download` });
      res.end();
    } else if (["/download", "/slow", "/delayed"].includes(path.pathname)) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=roundtrip.bin",
        "Content-Length": bytes.length,
      });
      if (path.pathname !== "/download") {
        slowStarts++;
        const sent = path.pathname === "/slow" ? 4096 : 1;
        slow.set(res, sent);
        res.on("close", () => slow.delete(res));
        res.write(bytes.subarray(0, sent));
      } else {
        downloads++;
        res.end(bytes);
      }
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const crossOrigin = path.searchParams.get("origin") === "cross";
      const content = crossOrigin
        ? html.toString().replaceAll('href="/', `href="http://127.0.0.1:${remote.address().port}/`)
        : html;
      res.end(content);
    }
  };
  const server = createServer(serve);
  const remote = createServer(serve);
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const poll = async (check) => {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error("Compatibility condition timed out");
  };
  const results = [];
  let worker;
  const workerRead = async (expression) => {
    const reply = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      worker,
    );
    assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const origins = [server, remote].map(
    (endpoint) => `http://127.0.0.1:${endpoint.address().port}/`,
  );
  const downloadQuery = `chrome.downloads.search({}).then(items=>items.filter(item=>${JSON.stringify(origins)}.some(origin=>item.url.startsWith(origin))))`;
  try {
    worker = await attachExtensionWorker(send);
    // Native background delivery needs headful Chrome; full-page screenshots
    // need uninterrupted visibility and run in the isolated headless suite.
    const scenarios = headful
      ? ["tab", "window"].flatMap((placement) =>
          ["cli", "dsh"].flatMap((client) =>
            ["upload", "download"].map((first) => [client, first, placement]),
          ),
        )
      : [
          ["cli", "foreground"],
          ["dsh", "foreground"],
        ];
    for (const [client, first, placement = "tab"] of scenarios) {
      const background = first !== "foreground";
      const origin = first === "download" || !headful ? "cross" : "same";
      const tag = `${client}-${first}-${placement}-${origin}`;
      console.error(`compatibility: ${tag}`);
      const dsh = client === "dsh" ? createDshRegressionClient(cli, env) : undefined;
      let session, human, task, taskWindowId, cover, coverTabId, coverSession, otherWindow;
      try {
        const url = `http://127.0.0.1:${server.address().port}/?case=${tag}&origin=${origin}`;
        const existing = new Set(
          (await send("Target.getTargets")).targetInfos.map((t) => t.targetId),
        );
        session = dsh
          ? (
              await dsh.run("bsk_session", {
                action: "start",
                noFocus: false,
                ...(!background ? { url } : {}),
              })
            ).sessionId
          : (await bsk(["session", "start", ...(background ? ["--focus"] : [])])).session_id;
        const scope = ["--session", session];
        if (!background && !dsh) await bsk(["navigate", url, ...scope]);
        task = await poll(async () =>
          (await send("Target.getTargets")).targetInfos.find(
            (t) =>
              t.type === "page" &&
              t.url === (background ? "about:blank" : url) &&
              !existing.has(t.targetId),
          ),
        );
        ({ sessionId: human } = await send("Target.attachToTarget", {
          targetId: task.targetId,
          flatten: true,
        }));
        if (background) {
          // Cover the blank tab before navigation. Neither capture nor native input
          // may warm the target document before its first file-transfer trigger.
          ({ targetId: cover } = await send("Target.createTarget", {
            url: 'data:text/html,<title>Unrelated foreground</title><input id="sentinel" value="untouched">',
            newWindow: placement === "window",
          }));
          taskWindowId = (await send("Browser.getWindowForTarget", { targetId: task.targetId }))
            .windowId;
          const coverWindowId = (await send("Browser.getWindowForTarget", { targetId: cover }))
            .windowId;
          if (placement === "window") {
            assert.notEqual(coverWindowId, taskWindowId);
            await send("Browser.setWindowBounds", {
              windowId: taskWindowId,
              bounds: { windowState: "minimized" },
            });
          } else assert.equal(coverWindowId, taskWindowId);
          ({ sessionId: coverSession } = await send("Target.attachToTarget", {
            targetId: cover,
            flatten: true,
          }));
          await send("Page.bringToFront", {}, coverSession);
          const coverUrl = (await send("Target.getTargetInfo", { targetId: cover })).targetInfo.url;
          coverTabId = await poll(() =>
            workerRead(
              `chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===${JSON.stringify(coverUrl)})?.id)`,
            ),
          );
        }
        if (background)
          await (dsh
            ? dsh.run("bsk_page", { action: "navigate", session, url })
            : bsk(["navigate", url, ...scope]));
        if (!background) await send("Page.bringToFront", {}, human);
        const read = async (expression) => {
          const reply = await send("Runtime.evaluate", { expression, returnByValue: true }, human);
          assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
          return reply.result.value;
        };
        await poll(() => read("!!document.querySelector('#wrong')"));
        const showTask = async () => {
          if (background && placement === "window")
            await send("Browser.setWindowBounds", {
              windowId: taskWindowId,
              bounds: { windowState: "normal" },
            });
          await send("Page.bringToFront", {}, human);
        };
        const parkTask = async () => {
          if (placement === "window")
            await send("Browser.setWindowBounds", {
              windowId: taskWindowId,
              bounds: { windowState: "minimized" },
            });
          await send("Page.bringToFront", {}, coverSession);
          // During an attachment navigation the renderer may withhold reads.
          // Confirm browser state here; only sample visibility outside a transfer.
          await poll(() => workerRead(`chrome.tabs.get(${coverTabId}).then(tab=>tab.active)`));
          if (placement === "window")
            await poll(
              async () =>
                (await send("Browser.getWindowBounds", { windowId: taskWindowId })).bounds
                  .windowState === "minimized",
            );
        };
        const assertParked = async () => {
          assert.equal(
            await read("document.visibilityState"),
            "hidden",
            "temporary focus override leaked",
          );
          const foreground = await send(
            "Runtime.evaluate",
            {
              expression:
                "({visible:document.visibilityState, value:document.querySelector('#sentinel').value})",
              returnByValue: true,
            },
            coverSession,
          );
          assert.equal(foreground.result.value.value, "untouched");
          // macOS occlusion can hide both tabs while another app is foreground.
          // Browser activation and minimization are the invariants we control.
          assert.equal(
            await workerRead(`chrome.tabs.get(${coverTabId}).then(tab=>tab.active)`),
            true,
          );
          if (placement === "window")
            assert.equal(
              (await send("Browser.getWindowBounds", { windowId: taskWindowId })).bounds
                .windowState,
              "minimized",
            );
        };
        if (background) await assertParked();
        // The fixed fixture button does not move. Read it before an attachment
        // navigation, when the renderer may temporarily withhold read replies.
        const points = await read(
          "Object.fromEntries(['wrong','human-download'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,{x:r.x+r.width/2,y:r.y+r.height/2}]}))",
        );
        const humanClick = async (id = "wrong") => {
          await showTask();
          const point = points[id];
          for (const type of ["mousePressed", "mouseReleased"])
            await send(
              "Input.dispatchMouseEvent",
              { type, button: "left", clickCount: 1, ...point },
              human,
            );
        };
        const sync = () =>
          dsh
            ? dsh.run("bsk_session", { action: "sync", session })
            : bsk(["cooperate", "sync", ...scope]);
        const wait = async () =>
          assert.equal(
            (
              await (dsh
                ? dsh.run("bsk_session", { action: "wait-user", session, timeoutMs: 3000 })
                : bsk(["cooperate", "wait", ...scope, "--timeout-ms", "3000"]))
            ).ready,
            true,
          );
        const act = async (action, args = {}, context) => {
          if (background) {
            await parkTask();
            // Wait for native window transitions before sending the one input.
            // Post-action assertions below still check cleanup without retrying it.
            await poll(async () => (await read("document.visibilityState")) === "hidden");
            await assertParked();
          }
          const contextId = context ?? (await sync()).context_id;
          if (dsh) return dsh.run("bsk_interact", { action, session, ...args, contextId });
          let command;
          if (action === "evaluate") command = ["evaluate", args.expression];
          else if (action === "upload")
            command = [
              "upload",
              args.target,
              "--file",
              file,
              ...(args.mode ? ["--mode", args.mode] : []),
            ];
          else command = ["download", args.target, "--out", args.output];
          return bsk([...command, ...scope, "--context", contextId]);
        };
        const rejects = async (promise, effect) =>
          assert.rejects(promise, (error) => {
            const data = error.data ?? (error.stdout ? JSON.parse(error.stdout).data : undefined);
            return (
              data?.reason === "cooperation_sync_required" &&
              (!effect || data.effect_state === effect)
            );
          });
        assert.deepEqual(
          (await act("evaluate", { expression: "({sum:1+2, text:'normal'})" })).value,
          { sum: 3, text: "normal" },
        );
        assert.equal((await act("evaluate", { expression: "Promise.resolve(7)" })).value, 7);
        assert.equal(
          (await act("evaluate", { expression: "(()=>{throw new Error('expected')})()" })).ok,
          false,
        );
        const exactClick = async (selector) =>
          assert.deepEqual(
            await read(
              `window.nativeInputs.filter(e => e.target === ${JSON.stringify(selector)}).map(e => e.type)`,
            ),
            ["pointerdown", "pointerup", "click"],
            "first trigger must dispatch exactly once, without retries",
          );
        if (first === "download") {
          const beforeFirst = downloads;
          const output = join(directory, `${tag}-first.bin`);
          await act("download", { target: "#download", output });
          assert.deepEqual(await readFile(output), bytes);
          assert.equal(downloads, beforeFirst + 1);
          await exactClick("download");
          await assertParked();
        }
        const count = uploads.length;
        await act("upload", { target: "#choose", files: [file] });
        await poll(() => uploads.length === count + 1);
        assert.equal(uploads.at(-1), "input");
        await exactClick("choose");
        if (background) await assertParked();
        await act("upload", { target: "#drop", files: [file], mode: "drop" });
        await poll(() => uploads.length === count + 2);
        assert.equal(uploads.at(-1), "drop");
        const output = join(directory, `${tag}-download.bin`);
        await act("download", { target: "#download", output });
        assert.deepEqual(await readFile(output), bytes);
        const before = downloads;
        await assert.rejects(act("download", { target: "#download", output }));
        assert.equal(downloads, before, "existing output must not trigger a second download");
        if (background) {
          const switchScript = act("evaluate", {
            expression:
              "window.switchStarted=true; new Promise(resolve=>setTimeout(()=>{window.switchCount=(window.switchCount||0)+1;resolve(window.switchCount)},1200))",
          });
          void switchScript.catch(() => {});
          await poll(() => read("window.switchStarted"));
          await showTask();
          await parkTask();
          ({ targetId: otherWindow } = await send("Target.createTarget", {
            url: "about:blank",
            newWindow: true,
          }));
          const { sessionId: otherSession } = await send("Target.attachToTarget", {
            targetId: otherWindow,
            flatten: true,
          });
          await send("Page.bringToFront", {}, otherSession);
          assert.equal(
            (await switchScript).value,
            1,
            "window switching must not replay or cancel the script",
          );
          const slowBefore = slowStarts;
          const output = join(directory, `${tag}-switch.bin`);
          const transfer = act("download", { target: "#delayed", output });
          void transfer.catch(() => {});
          await poll(() => slowStarts === slowBefore + 1);
          // Outlast the former one-second cleanup boundary before completing.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await showTask();
          await parkTask();
          await send("Page.bringToFront", {}, otherSession);
          for (const [res, sent] of slow) res.end(bytes.subarray(sent));
          await transfer;
          assert.deepEqual(await readFile(output), bytes);
          assert.equal(slowStarts, slowBefore + 1);
          await send("Target.closeTarget", { targetId: otherWindow });
          otherWindow = undefined;
          await parkTask();
          await assertParked();
        }
        for (const [action, args] of [
          ["evaluate", { expression: "window.scriptCounter++" }],
          ["upload", { target: "#choose", files: [file] }],
          ["download", { target: "#download", output: join(directory, `${tag}-stale.bin`) }],
        ]) {
          const stale = await sync();
          await humanClick();
          await rejects(act(action, args, stale.context_id), "none");
          await wait();
        }
        assert.equal(await read("window.scriptCounter"), 0);
        assert.equal(uploads.length, count + 2);
        assert.equal(downloads, before);
        const script = act("evaluate", {
          expression:
            "window.scriptStarted=true; new Promise(resolve=>setTimeout(()=>{window.scriptCounter++;resolve(7)},1200))",
        });
        const scriptRejected = rejects(script, "unknown");
        void scriptRejected.catch(() => {});
        await poll(() => read("window.scriptStarted"));
        await humanClick();
        await scriptRejected;
        assert.equal(await read("window.scriptCounter"), 1, "interrupted script is never replayed");
        await wait();
        const upload = act("upload", { target: "#waiting", files: [file] });
        const uploadRejected = rejects(upload);
        void uploadRejected.catch(() => {});
        await poll(() => read("window.uploadWaiting"));
        await humanClick();
        await uploadRejected;
        assert.equal(uploads.length, count + 2);
        await wait();
        const slowBefore = slowStarts;
        const slowPath = join(directory, `${tag}-intervened.bin`);
        let settled = false;
        const downloading = act("download", { target: "#slow", output: slowPath }).finally(() => {
          settled = true;
        });
        void downloading.catch(() => {});
        await poll(() => slowStarts > slowBefore);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(settled, false, "a pending receipt must outlive focus cleanup");
        await humanClick();
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(settled, false, "human input must not discard an accepted download");
        for (const [res, sent] of slow) res.end(bytes.subarray(sent));
        await downloading;
        assert.deepEqual(await readFile(slowPath), bytes);
        assert.equal(slowStarts, slowBefore + 1, "intervention must not replay the download");
        assert.equal(await read("document.querySelector('#note').value"), "mistake");
        await wait();
        await act("evaluate", { expression: "document.querySelector('#note').value='goal'" });
        assert.equal(await read("document.querySelector('#note').value"), "goal");
        const recovery = join(directory, `${tag}-recovered.bin`);
        await act("download", { target: "#download", output: recovery });
        assert.deepEqual(await readFile(recovery), bytes);
        // Before Chrome assigns a download id, a second user download must
        // never become the retired action's result or cleanup target.
        const beforeConflict = slowStarts;
        const conflictPath = join(directory, `${tag}-ambiguous.bin`);
        const humanUrl = await read("document.querySelector('#human-download').href");
        const previousIds = new Set((await workerRead(downloadQuery)).map((item) => item.id));
        const uncertain = act("download", { target: "#delayed", output: conflictPath });
        const rejected = rejects(uncertain, "unknown");
        void rejected.catch(() => {});
        await poll(() => slowStarts === beforeConflict + 1);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await humanClick("human-download");
        await rejected;
        for (const [res, sent] of slow) res.end(bytes.subarray(sent));
        const ownHumanDownload = await poll(async () =>
          (await workerRead(downloadQuery)).find(
            (item) =>
              !previousIds.has(item.id) && item.url === humanUrl && item.state === "complete",
          ),
        );
        assert.equal(ownHumanDownload.fileSize, humanBytes.length);
        assert.deepEqual(await readFile(ownHumanDownload.filename), humanBytes);
        await assert.rejects(readFile(conflictPath), { code: "ENOENT" });
        assert.equal(slowStarts, beforeConflict + 1, "uncertain download must not be replayed");
        await wait();
        const redirected = join(directory, `${tag}-redirect.bin`);
        await act("download", { target: "#redirect", output: redirected });
        assert.deepEqual(await readFile(redirected), bytes);
        if (client === "cli" && !background) {
          // Anchor the isolated window before resizing: headless Chrome cascades
          // newly created windows, and may otherwise put this one off-screen.
          const { windowId } = await send("Browser.getWindowForTarget", {
            targetId: task.targetId,
          });
          await send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0 } });
          const command = async (args) =>
            bsk([...args, ...scope, "--context", (await sync()).context_id]);
          await command(["window", "resize", "--width", "640", "--height", "500"]);
          await command(["emulate", "--device", "iphone-14"]);
          // The resize event updates semantic page content asynchronously. Wait
          // for that known effect before observing the next emulation decision.
          await poll(() =>
            read("document.querySelector('#viewport').textContent === 'Narrow layout'"),
          );
          const partial = await command(["emulate", "--width", "400", "--height", "700"]);
          assert.equal(partial.applied.device_scale_factor, 3);
          assert.equal(partial.applied.mobile, true);
          assert.equal(await read("devicePixelRatio"), 3);
          await poll(() =>
            read("document.querySelector('#viewport').textContent === 'Narrow layout'"),
          );
          await command(["emulate", "--off"]);
          await poll(() =>
            read("document.querySelector('#viewport').textContent === 'Wide layout'"),
          );
          await command(["observe", "--probe-hover"]);
          const screenshot = join(directory, "full-page.png");
          await command(["screenshot", "--full-page", "--scope", "current", "--out", screenshot]);
          assert.deepEqual(
            (await readFile(screenshot)).subarray(0, 8),
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          );
          const original = (await sync()).tab_id;
          const created = await bsk(["tab", "create", "--url", url + "&extra=1", ...scope]);
          await bsk([
            "wait-for-navigation",
            "--tab-id",
            String(created.tab_id),
            "--wait-until",
            "networkidle",
            ...scope,
          ]);
          await command(["tab", "close", String(created.tab_id)]);
          await bsk(["tab", "select", String(original), ...scope]);
        }
        results.push({
          client,
          downloadOrigin: origin,
          backgroundFirstTransfer: background ? first : undefined,
          backgroundPlacement: background ? placement : undefined,
          tabAndWindowSwitch: background,
          unattended: true,
          inputUpload: true,
          dropUpload: true,
          downloadBytes: true,
          staleRejected: true,
          scriptIntervention: true,
          uploadIntervention: true,
          downloadIntervention: true,
          independentHumanDownloadPreserved: true,
          preAttributionInterventionUnknown: true,
          redirectedDownload: true,
          recovered: true,
          ...(client === "cli" && !background
            ? {
                windowResize: true,
                devicePartialUpdates: true,
                responsiveUpdates: true,
                hoverProbe: true,
                fullPageScreenshot: true,
                tabLifecycle: true,
              }
            : {}),
        });
        if (dsh) assert(!dsh.calls.some((args) => args[0] === "cooperate" && args[1] === "enable"));
      } catch (error) {
        const visibility = (targetSession) =>
          targetSession &&
          send(
            "Runtime.evaluate",
            {
              expression: "({visibility:document.visibilityState,focus:document.hasFocus()})",
              returnByValue: true,
            },
            targetSession,
          ).catch((failure) => ({ error: failure.message }));
        const state = {
          cooperation: session
            ? await bsk(["cooperate", "status", "--session", session]).catch((failure) => ({
                error: failure.message,
              }))
            : undefined,
          inputs: human
            ? await send(
                "Runtime.evaluate",
                { expression: "window.nativeInputs", returnByValue: true },
                human,
              ).catch((failure) => ({ error: failure.message }))
            : undefined,
          task: await visibility(human),
          foreground: await visibility(coverSession),
          tabs: await workerRead(
            "chrome.tabs.query({}).then(tabs=>tabs.map(({id,windowId,active,url})=>({id,windowId,active,url})))",
          ).catch((failure) => ({ error: failure.message })),
        };
        throw new Error(`${tag}: ${error.message}; browser state: ${JSON.stringify(state)}`, {
          cause: error,
        });
      } finally {
        if (session)
          await (dsh
            ? dsh.run("bsk_session", { action: "stop", session })
            : bsk(["session", "stop", session])
          ).catch(() => {});
        if (human) await send("Target.detachFromTarget", { sessionId: human }).catch(() => {});
        await dsh?.dispose();
        for (const targetId of [otherWindow, cover, task?.targetId])
          if (targetId) await send("Target.closeTarget", { targetId }).catch(() => {});
      }
    }
    return { passed: true, results, uploads, completedDownloads: downloads };
  } finally {
    for (const res of slow.keys()) res.destroy();
    if (worker) {
      // Only this private browser's fixture URLs are eligible for cleanup.
      await workerRead(
        `${downloadQuery}.then(async items=>{for(const item of items){if(item.state==='in_progress')await chrome.downloads.cancel(item.id);await chrome.downloads.removeFile(item.id).catch(()=>{});await chrome.downloads.erase({id:item.id});}})`,
      ).catch(() => {});
      await send("Target.detachFromTarget", { sessionId: worker }).catch(() => {});
    }
    for (const endpoint of [server, remote]) {
      endpoint.closeAllConnections();
      await new Promise((resolve) => endpoint.close(resolve));
    }
  }
}

export async function attachExtensionWorker(send) {
  for (const target of (await send("Target.getTargets")).targetInfos.filter(
    (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
  )) {
    const { sessionId } = await send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const result = await send(
      "Runtime.evaluate",
      {
        expression: "typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().name",
        returnByValue: true,
      },
      sessionId,
    );
    if (result.result?.value === "BrowserSkill") return sessionId;
    await send("Target.detachFromTarget", { sessionId });
  }
  throw new Error("Test extension worker unavailable");
}
