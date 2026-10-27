// @vitest-environment node
// BSK_INCOGNITO_CHROME=/path/to/chrome runs against a disposable browser/profile.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

const entry = `
import { ChromiumCdp } from '@/browser-driver/chromium-cdp';
import { SessionManager } from '@/session-manager/manager';
import { attachSessionEventHandler } from '@/session-manager/event-handler';
import { handleSessionStart, handleSessionStop } from '@/tools/session';
import { handleTabCreate, handleTabBorrow, handleTabClose } from '@/tools/tabs';
import { handleClick, handleFill } from '@/tools/interaction';
import { handleSnapshot } from '@/tools/observation';
const check=(ok,message)=>{if(!ok)throw new Error(message)};
const ok=result=>{check(!result.code,JSON.stringify(result));return result};
const wait=async fn=>{const until=Date.now()+10000;while(!(await fn())){
 if(Date.now()>until)throw new Error('Page did not load');await new Promise(r=>setTimeout(r,50));
}};
globalThis.run=async(url,allowed)=>{
 const manager=new SessionManager(),cdp=new ChromiumCdp(chrome.debugger);
 const events=attachSessionEventHandler({manager,transport:{send(){}},cdp});
 const deps={cdp,tabsApi:chrome.tabs};
 const evaluate=async(tabId,expression)=>(await cdp.send(tabId,'Runtime.evaluate',{
  expression,returnByValue:true,awaitPromise:true
 })).result.value;
 const start=async(session_id,incognito)=>{
  globalThis.phase='start '+session_id;
  ok(await handleSessionStart(manager,{session_id,incognito}));
  const created=ok(await handleTabCreate(manager,{session_id,url},{cdp}));
  await wait(async()=>(await chrome.tabs.get(created.tab_id)).status==='complete');
  return {session_id,tab_id:created.tab_id};
 };
 const stop=async task=>{globalThis.phase='stop '+task.session_id;return ok(await handleSessionStop(manager,task,{
  cdp,tabsQuery:chrome.tabs,tabManagement:{tabs:chrome.tabs,windows:chrome.windows}
 }));};
 try {
  if(!allowed){
   const before=(await chrome.windows.getAll()).length;
   const denied=await handleSessionStart(manager,{session_id:'denied',incognito:true});
   check(denied.code==='protocol_error'&&denied.message.includes('Allow in incognito'),'missing permission error');
   check((await chrome.windows.getAll()).length===before&&!manager.has('denied'),'denied start created a window');
   const normal=await start('normal',false);await stop(normal);
   return {permissionDenied:true,normalStillWorks:true};
  }
  const normal=await start('normal',false);
  await evaluate(normal.tab_id,"document.cookie='mode=normal; Path=/';localStorage.setItem('mode','normal')");
  const first=await start('private-one',true);
  check(await evaluate(first.tab_id,"!document.cookie.includes('mode=normal')&&localStorage.getItem('mode')===null"),'normal state leaked');
  await evaluate(first.tab_id,"document.cookie='mode=private; Path=/';localStorage.setItem('mode','private')");
  const second=await start('private-two',true);
  check(await evaluate(second.tab_id,"document.cookie.includes('mode=private')&&localStorage.getItem('mode')==='private'"),'incognito windows should share state');
  check(await evaluate(normal.tab_id,"document.cookie.includes('mode=normal')&&localStorage.getItem('mode')==='normal'"),'normal state changed');
  globalThis.phase='fill';
  ok(await handleFill(manager,{...first,selector:'#name',value:'private input'},deps));
  globalThis.phase='click';
  ok(await handleClick(manager,{...first,selector:'#save'},deps));
  check(await evaluate(first.tab_id,"document.querySelector('output').textContent==='private input'"),'input failed');
  globalThis.phase='snapshot';
  ok(await handleSnapshot(manager,first,deps));
  check((await handleTabBorrow(manager,{...first,tab_id:normal.tab_id})).code==='permission_denied','borrow allowed');
  // Explicit tab close remains available inside an incognito session.
  globalThis.phase='create and close extra tab';
  const extra=ok(await handleTabCreate(manager,{session_id:first.session_id,url},{cdp}));
  ok(await handleTabClose(manager,{session_id:first.session_id,tab_id:extra.tab_id},{cdp}));
  await stop(first);
  check(await evaluate(second.tab_id,"document.cookie.includes('mode=private')"),'stopping another task cleared shared state');
  const windowId=manager.get(second.session_id).agentWindowId;
  const userTab=await chrome.tabs.create({windowId,url,active:false});
  check((await stop(second)).window_released===true,'user tab was not preserved');
  check((await chrome.tabs.get(userTab.id)).incognito,'user tab lost incognito mode');
  await chrome.windows.remove(windowId);
  const fresh=await start('private-fresh',true);
  check(await evaluate(fresh.tab_id,"!document.cookie.includes('mode=private')&&localStorage.getItem('mode')===null"),'last window close did not clear site data');
  await stop(fresh);await stop(normal);
  return {isolated:true,sharedIncognito:true,input:true,userTabPreserved:true,cleared:true};
 } finally {globalThis.phase='detach';await cdp.detachAll();cdp.dispose();await manager.stopAll();events.dispose();}
};`;

describe.skipIf(!process.env.BSK_INCOGNITO_CHROME)("incognito Agent Windows", () => {
  it.each([
    false,
    true,
  ])("respects permission and session lifecycle (allowed=%s)", async (allowed) => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-incognito-"));
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><title>Incognito fixture</title>
        <label>Name<input id="name"></label><button id="save">Save</button><output></output>
        <script>document.querySelector('#save').onclick=()=>{
          document.querySelector('output').textContent=document.querySelector('#name').value;
        };</script>`);
    });
    try {
      const require = createRequire(import.meta.url);
      const { build } = await import(
        require.resolve("vite", { paths: [require.resolve("vitest")] })
      );
      await writeFile(path.join(directory, "entry.js"), entry);
      await build({
        configFile: false,
        logLevel: "error",
        define: {
          __BSK_EXT_VERSION__: JSON.stringify("0.0.0"),
          __BSK_DAEMON_WS_URL__: JSON.stringify("ws://127.0.0.1:1"),
        },
        resolve: {
          alias: {
            "@": path.resolve("src"),
            "@browser-skill/i18n": path.resolve("../../packages/i18n/src/index.ts"),
          },
        },
        build: {
          outDir: directory,
          emptyOutDir: false,
          lib: {
            entry: path.join(directory, "entry.js"),
            formats: ["iife"],
            name: "Regression",
            fileName: () => "regression.js",
          },
        },
      });
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Incognito regression",
          version: "1.0",
          background: { service_worker: "worker.js" },
          permissions: ["debugger", "tabs", "scripting", "storage", "webNavigation"],
          host_permissions: ["http://127.0.0.1/*"],
        }),
      );
      await writeFile(
        path.join(directory, "worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {});",
      );
      await writeFile(
        path.join(directory, "regression.html"),
        '<!doctype html><script src="loader.js"></script><script src="regression.js"></script>',
      );
      await writeFile(
        path.join(directory, "loader.js"),
        "addEventListener('error', event => { globalThis.bootError = event.message; });",
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      await withChrome(
        {
          executable: process.env.BSK_INCOGNITO_CHROME,
          deviceScale: 1,
          zoom: 1,
          extensionPath: directory,
        },
        async (send: Send) => {
          let origin = "";
          await expect
            .poll(
              async () => {
                const { targetInfos } = await send<{
                  targetInfos: { type: string; url: string; targetId: string }[];
                }>("Target.getTargets");
                const worker = targetInfos.find(
                  (t) => t.type === "service_worker" && t.url.endsWith("/worker.js"),
                );
                origin = worker ? worker.url.slice(0, -"/worker.js".length) : "";
                return origin;
              },
              { timeout: 10000 },
            )
            .not.toBe("");
          const attach = async (url: string) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            return async (expression: string) => {
              const result = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sessionId,
              );
              expect(result.exceptionDetails).toBeUndefined();
              return result.result.value;
            };
          };
          if (allowed) {
            const settings = await attach("chrome://extensions/");
            await expect
              .poll(() => settings("typeof chrome.developerPrivate"), { timeout: 5000 })
              .toBe("object");
            // Change only this disposable profile's extension permission through Chrome's settings API.
            const extensionId = new URL(origin).host;
            // Unpacked extensions must remain enabled when permission changes reload them.
            await settings(
              "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})",
            );
            await settings(
              `new Promise((resolve,reject)=>chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},incognitoAccess:true},()=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(true)))`,
            );
            await expect
              .poll(
                async () => {
                  const info = (await settings(
                    `new Promise(resolve=>chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extensionId)},resolve))`,
                  )) as { state: string; incognitoAccess: { isActive: boolean } };
                  return info.state === "ENABLED" && info.incognitoAccess.isActive;
                },
                { timeout: 10000 },
              )
              .toBe(true);
          }
          const evaluate = await attach(`${origin}/regression.html`);
          await expect
            .poll(() => evaluate("globalThis.bootError || typeof globalThis.run"), {
              timeout: 5000,
            })
            .toBe("function")
            .catch(async (error) => {
              const page = await evaluate(
                "({url:location.href,body:document.body.innerText,scripts:[...document.scripts].map(s=>s.src)})",
              );
              throw new Error(`${error.message}: ${JSON.stringify(page)}`);
            });
          await evaluate(
            `globalThis.run(${JSON.stringify(url)},${allowed}).then(value=>globalThis.done={value},error=>globalThis.done={error:error.stack});void 0`,
          );
          let done: { value?: unknown; error?: string } | undefined;
          let phase = "";
          await expect
            .poll(
              async () => {
                const state = (await evaluate(
                  "({done:globalThis.done,phase:globalThis.phase})",
                )) as { done: typeof done; phase: string };
                if (state.phase !== phase) {
                  phase = state.phase;
                  console.log(phase);
                }
                done = state.done;
                return done;
              },
              { timeout: 30000 },
            )
            .toBeDefined();
          expect(done?.error).toBeUndefined();
          expect(done?.value).toEqual(
            allowed
              ? {
                  isolated: true,
                  sharedIncognito: true,
                  input: true,
                  userTabPreserved: true,
                  cleared: true,
                }
              : { permissionDenied: true, normalStillWorks: true },
          );
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
