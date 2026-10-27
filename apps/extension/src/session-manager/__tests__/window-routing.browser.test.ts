// @vitest-environment node
// BSK_BACKGROUND_CHROME=/path/to/chrome uses an isolated headed Chrome/profile.
// BSK_BACKGROUND_SOAK=1 additionally runs six minutes with Energy Saver enabled.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
const html = `<!doctype html><title>Window routing fixture</title>
<button id="run" disabled>Loading application</button><output id="result"></output>
<a id="popup" href="/popup" target="_blank" rel="noopener">Open task page</a>
<script>
window.framesRun=0;window.ticks=0;window.clicks=0;
function frame(){framesRun++;requestAnimationFrame(frame)}requestAnimationFrame(frame);
setInterval(()=>ticks++,100);
requestAnimationFrame(()=>requestAnimationFrame(()=>document.querySelector('#run').disabled=false));
document.querySelector('#run').onclick=()=>requestAnimationFrame(()=>{
 document.querySelector('#result').textContent='Completed '+(++clicks);
});
</script>`;

// Exercise production session creation, routing, popup observation, CDP policy
// and input/snapshot handlers in an extension page that survives user window close.
const entry = `
import { ChromiumCdp } from '@/browser-driver/chromium-cdp';
import { isAgentControlledTab, SessionManager } from '@/session-manager/manager';
import { AgentWindowRouting } from '@/session-manager/window-routing';
import { withTaskPopups } from '@/session-manager/task-popups';
import { beginTabCreation } from '@/session-manager/tab-creation';
import { handleTabCreate } from '@/tools/tabs';
import { handleClick } from '@/tools/interaction';
import { handleSnapshot } from '@/tools/observation';
import { handleNavigate } from '@/tools/navigation';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(ok,message)=>{if(!ok)throw new Error(message)};
const wait=async(fn,label)=>{const deadline=Date.now()+10000;while(!(await fn())){
 if(Date.now()>deadline)throw new Error('Timed out: '+label);await sleep(50);
}};
globalThis.run=async(url,soak)=>{
 const controller=await chrome.tabs.getCurrent();
 await chrome.windows.create({tabId:controller.id,type:'popup',focused:false});
 const manager=new SessionManager(),cdp=new ChromiumCdp(chrome.debugger);
 const user=(await chrome.windows.getAll({windowTypes:['normal']}))[0];
 const [control]=await chrome.tabs.query({windowId:user.id,active:true});
 await chrome.tabs.update(control.id,{url:url+'/control'});
 await chrome.windows.update(user.id,{focused:true,left:0,top:0,width:1400,height:1000});
 await wait(async()=>(await chrome.tabs.get(control.id)).status==='complete','control load');
 let humanAssistance=false;
 const router=new AgentWindowRouting(manager,chrome,()=>humanAssistance);
 await sleep(300);
 const focused=[],activated=[],removed=[];
 chrome.windows.onFocusChanged.addListener(id=>focused.push(id));
 chrome.tabs.onActivated.addListener(info=>activated.push(info));
 chrome.tabs.onRemoved.addListener((id,info)=>removed.push({id,...info}));
 const task=await manager.start('background-regression',{size:{width:800,height:600}});
 router.sync();
 const evaluate=async(id,expression)=>(await cdp.send(id,'Runtime.evaluate',{
  expression,returnByValue:true,awaitPromise:true
 })).result.value;
 const created=await handleTabCreate(manager,{session_id:task.sessionId,url:url+'/agent'},{cdp});
 check(!created.code,JSON.stringify(created));
 const id=created.tab_id;
 const params={session_id:task.sessionId,tab_id:id};
 const deps={cdp,tabsApi:chrome.tabs};
 const states=[];
 let idleId;
 const exercise=async(label)=>{
  globalThis.phase=label;
  await wait(async()=>await evaluate(id,"!!document.querySelector('#run')&&!document.querySelector('#run').disabled"),label+' ready');
  const before=await evaluate(id,'({frames:framesRun,ticks,clicks,hidden:document.hidden,cookie:document.cookie})');
  globalThis.phase=label+' input';
  const result=await handleClick(manager,{...params,selector:'#run'},deps);
  check(!result.code,JSON.stringify(result));
  await wait(async()=>(await evaluate(id,'clicks'))>before.clicks,label+' input');
  globalThis.phase=label+' snapshot';
  const snapshot=await handleSnapshot(manager,params,deps);
  check(!snapshot.code&&JSON.stringify(snapshot).includes('Completed'),label+' snapshot');
  globalThis.phase=label+' screenshot';
  const screenshot=await cdp.send(id,'Page.captureScreenshot',{format:'png',fromSurface:true});
  const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(screenshot.data),c=>c.charCodeAt(0))],{type:'image/png'}));
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
  context.drawImage(bitmap,0,0);bitmap.close();
  const pixels=context.getImageData(0,0,Math.min(400,canvas.width),Math.min(150,canvas.height)).data;
  let dark=0;for(let n=0;n<pixels.length;n+=4)if(pixels[n]+pixels[n+1]+pixels[n+2]<600&&pixels[n+3])dark++;
  check(dark>100,label+' screenshot pixels');
  const after=await evaluate(id,'({frames:framesRun,ticks,hidden:document.hidden,cookie:document.cookie})');
  check(after.frames>before.frames&&!after.hidden,label+' animation');
  check(after.cookie.includes('shared_login=fixture'),label+' shared profile');
  check(!(await chrome.windows.get(task.agentWindowId)).focused,label+' window focus');
  check((await chrome.tabs.get(control.id)).active,label+' user selection');
  states.push({label,before,after});
 };
 try {
  await exercise('background');
  // The larger foreground user window completely covers the Agent Window.
  await chrome.windows.update(task.agentWindowId,{left:60,top:60,width:800,height:600,focused:false});
  await chrome.windows.update(user.id,{focused:true});
  const cover=await chrome.windows.get(user.id),covered=await chrome.windows.get(task.agentWindowId);
  check(cover.focused&&cover.left<=covered.left&&cover.top<=covered.top&&
   cover.left+cover.width>=covered.left+covered.width&&cover.top+cover.height>=covered.top+covered.height,
   'covered window geometry');
  await exercise('covered');
  await chrome.windows.update(task.agentWindowId,{state:'minimized'});
  await exercise('minimized');
  if(soak){
   const idle=await chrome.tabs.create({windowId:user.id,url:url+'/idle',active:false});
   idleId=idle.id;
   const before=await evaluate(id,'({frames:framesRun,ticks})');
   const start=Date.now();
   // No target evaluations or inputs during the idle interval. Only the
   // extension controller is polled by the host. Use host wall time so the
   // controller's own background timers cannot delay completion of the test.
   await new Promise(resolve=>{globalThis.finishSoak=resolve;globalThis.phase='six-minute Energy Saver soak';});
   globalThis.phase='verify Energy Saver soak';
   const after=await evaluate(id,'({frames:framesRun,ticks})');
   check(after.frames-before.frames>1000,'soak animation throttled');
   check(after.ticks-before.ticks>1000,'soak timers throttled');
   check((await chrome.tabs.get(id)).frozen===false,'agent froze');
   check((await chrome.tabs.get(idle.id)).frozen===true,'Energy Saver positive control did not freeze');
   states.push({label:'Energy Saver soak',elapsed:Date.now()-start,before,after,controlFrozen:true});
   await exercise('after soak');
  }
  check(!focused.includes(task.agentWindowId),'background operation stole window focus: '+JSON.stringify(focused));
  check(!activated.some(event=>event.windowId===user.id),'background operation selected a user tab');
  const backgroundFocusEvents=[...focused];
  if(soak)return {states,backgroundFocusEvents};
  // Browser-created, noopener targets from actual agent input stay in the task.
  // Recovery intentionally applies only when the user was in Chrome. The
  // desktop user may have switched applications during the six-minute soak.
  await chrome.windows.update(user.id,{focused:true});
  await wait(async()=>(await chrome.windows.get(user.id)).focused,'popup focus baseline');
  globalThis.phase='task popup';
  const popup=await withTaskPopups(manager,params,onInputSent=>handleClick(manager,{...params,selector:'#popup'},{...deps,onInputSent}));
  check(!popup.code,JSON.stringify(popup));
  await wait(async()=>(await chrome.tabs.query({windowId:task.agentWindowId})).some(t=>t.url===url+'/popup'),'task popup');
  await sleep(500);
  check((await chrome.tabs.query({windowId:task.agentWindowId})).some(t=>t.url===url+'/popup'),'task popup was routed away');
  check(!(await chrome.windows.get(task.agentWindowId)).focused,'task popup stole window focus');
  // Simulate Chrome choosing the task window for a background external tab.
  globalThis.phase='background external link';
  await chrome.tabs.update(id,{active:true});
  // Hold the same creation barrier used by concurrent agent operations so the
  // unclassified tab remains active throughout default-target tool calls.
  const finishCreation=beginTabCreation(task);
  let external;
  try {
   external=await chrome.tabs.create({windowId:task.agentWindowId,url:url+'/external-background',active:true});
   await wait(async()=>(await chrome.tabs.get(external.id)).status==='complete','external fixture load');
   check(task.pendingRoutingTabs.has(external.id),'external tab is not pending routing');
   const defaults={session_id:task.sessionId};
   const navigated=await handleNavigate(manager,{...defaults,url:url+'/default-target'},deps);
   const defaultId=navigated.tab_id;
   check(!navigated.code&&defaultId!==external.id&&isAgentControlledTab(task,defaultId),'default navigation did not target a controlled task tab');
   const clicked=await handleClick(manager,{...defaults,selector:'#run'},deps);
   check(!clicked.code&&clicked.tab_id===defaultId,'default click did not target the selected task tab');
   await wait(async()=>(await evaluate(defaultId,'clicks'))>0,'default task click');
   const snapshot=await handleSnapshot(manager,defaults,deps);
   check(!snapshot.code&&snapshot.tab_id===defaultId,'default snapshot did not target the selected task tab');
   const pending=await chrome.tabs.get(external.id);
   check(pending.windowId===task.agentWindowId&&pending.url===url+'/external-background','external tab changed before routing');
   check(await evaluate(external.id,'clicks')===0,'default click changed the external page');
  } finally {finishCreation();}
  await wait(async()=>(await chrome.tabs.get(external.id)).windowId===user.id,'background external routing');
  check((await chrome.tabs.get(control.id)).active,'routing changed user selection');
  check(!(await chrome.windows.get(task.agentWindowId)).focused,'routing stole focus');
  // Let the host open a URL through Chrome's process singleton, as external
  // applications do. Deliberately view the task first to reproduce misrouting.
  await chrome.windows.update(task.agentWindowId,{focused:true});
  globalThis.phase='native external link';
  await wait(async()=>(await chrome.tabs.query({url:url+'/external-native'})).some(t=>t.windowId===user.id),'native external routing');
  await wait(async()=>(await chrome.windows.get(user.id)).focused,'external link foreground');
  // Close every user window. Keep the controller alive and verify a replacement
  // receives the original tab, without recreating its document or taking focus.
  await chrome.windows.remove(user.id);
  const fallback=await chrome.tabs.create({windowId:task.agentWindowId,url:url+'/external-fallback',active:false});
  await wait(async()=>(await chrome.tabs.get(fallback.id)).windowId!==task.agentWindowId,'replacement user window');
  const replacement=await chrome.tabs.get(fallback.id);
  check((await chrome.windows.get(replacement.windowId)).type==='normal','replacement type');
  check(!(await chrome.windows.get(replacement.windowId)).focused,'replacement stole focus');
  check(task.agentCreatedTabs.has(id)&&!task.agentCreatedTabs.has(fallback.id),'routing changed ownership');
  await chrome.windows.remove(replacement.windowId);
  // Include a fresh task home: an external URL must not be confused with
  // agent navigation just because the selected page is still about:blank.
  await chrome.tabs.update([...task.agentCreatedTabs][0],{active:true});
  await chrome.windows.update(task.agentWindowId,{focused:true});
  globalThis.phase='native fallback link';
  let nativeFallback;
  await wait(async()=>{
   nativeFallback=(await chrome.tabs.query({url:url+'/external-native-fallback'}))[0];
   return nativeFallback&&nativeFallback.windowId!==task.agentWindowId;
  },'native replacement window');
  await wait(async()=>{
   if((await chrome.windows.get(nativeFallback.windowId)).focused)return true;
   return focused.at(-1)===-1&&!(await chrome.windows.getAll()).some(window=>window.focused);
  },'native replacement foreground or respected application switch');
  const replacementFocused=(await chrome.windows.get(nativeFallback.windowId)).focused;
  // Runtime user gestures exercise real webNavigation events without granting
  // the resulting pages agent ownership or popup-observation permissions.
  const openPage=async(source,suffix)=>{
   await cdp.send(source,'Runtime.evaluate',{
    expression:'window.open('+JSON.stringify(url+suffix)+',"_blank");void 0',userGesture:true
   });
   let page;
   await wait(async()=>{
    page=(await chrome.tabs.query({url:url+suffix}))[0];
    return page?.status==='complete';
   },suffix+' load');
   return page;
  };
  globalThis.phase='closed popup source';
  const relay=await openPage(id,'/relay-source');
  await cdp.send(relay.id,'Runtime.evaluate',{
   expression:'window.open('+JSON.stringify(url+'/relay-destination')+',"_blank");window.close();void 0',
   userGesture:true
  }).catch(async error=>{if(await chrome.tabs.get(relay.id).catch(()=>null))throw error;});
  await wait(async()=>!(await chrome.tabs.get(relay.id).catch(()=>null)),'relay source close');
  await wait(async()=>(await chrome.tabs.query({url:url+'/relay-destination'})).length===1,'relay destination');
  await sleep(500);
  const [destination]=await chrome.tabs.query({url:url+'/relay-destination'});
  check(destination.windowId===task.agentWindowId,'closed-source popup was not kept in the task window');
  check(manager.findControllingSession(destination.id)===null,'provenance granted control');
  globalThis.phase='human-assistance popup chain';
  humanAssistance=true;
  const intermediate=await openPage(id,'/help-intermediate');
  const descendant=await openPage(intermediate.id,'/help-descendant');
  humanAssistance=false;
  await evaluate(descendant.id,'document.title="After human assistance";void 0');
  await sleep(500);
  for(const page of [intermediate,descendant]){
   check((await chrome.tabs.get(page.id)).windowId===task.agentWindowId,'help popup was not kept in the task window');
   check(manager.findControllingSession(page.id)===null,'help provenance granted control');
  }
  return {states,backgroundFocusEvents,nativeExternal:true,replacementWindow:nativeFallback.windowId,
   replacementFocused,closedSourcePopup:true,humanAssistancePopupChain:true,defaultTargetProtected:true};
 } catch(error) {
  throw new Error(JSON.stringify({error:error.message,phase:globalThis.phase,id,idleId,control:control.id,states,focused,removed,
   tabs:(await chrome.tabs.query({})).map(({id,windowId,url,frozen,discarded,openerTabId})=>({id,windowId,url,frozen,discarded,openerTabId})),
   sources:[...router.pageSourceWindows]}));
 } finally {router.dispose();await cdp.detachAll();cdp.dispose();}
};`;

describe.skipIf(!process.env.BSK_BACKGROUND_CHROME)("Agent Window browser regression", () => {
  it.each(
    process.env.BSK_BACKGROUND_SOAK === "1" ? [false, true] : [false],
  )("works in the background and routes tabs (six-minute Energy Saver: %s)", async (soak) => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-window-routing-"));
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/control")
        res.setHeader("Set-Cookie", "shared_login=fixture; Path=/; SameSite=Lax");
      res.end(html);
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
        define: { __BSK_EXT_VERSION__: JSON.stringify("0.0.0") },
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
          name: "Agent Window regression",
          version: "1.0",
          background: { service_worker: "worker.js" },
          permissions: ["debugger", "tabs", "scripting", "webNavigation", "storage"],
          host_permissions: ["http://127.0.0.1/*"],
        }),
      );
      await writeFile(
        path.join(directory, "worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {});",
      );
      await writeFile(
        path.join(directory, "regression.html"),
        '<!doctype html><script src="regression.js"></script>',
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
          executable: process.env.BSK_BACKGROUND_CHROME,
          deviceScale: 1,
          zoom: 1,
          extensionPath: directory,
          headless: false,
          disableGpu: false,
          // Current Chromium supports the always-enabled Battery Saver pref.
          // Lower only the CPU threshold; keep the real five-minute protection.
          // A frozen ordinary tab is required as a positive control.
          ...(soak
            ? {
                localState: { performance_tuning: { battery_saver_mode: { state: 3 } } },
                extraArgs: [
                  "--force-device-has-battery",
                  "--enable-features=CPUMeasurementInFreezingPolicy:freezing_high_cpu_proportion/0",
                ],
              }
            : {}),
        },
        async (send: Send, { profile }: { profile: string }) => {
          let origin = "";
          await expect
            .poll(
              async () => {
                const { targetInfos } = await send<{
                  targetInfos: { type: string; targetId: string; url: string }[];
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
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: `${origin}/regression.html`,
            background: true,
          });
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId,
            flatten: true,
          });
          // Exempt only the test controller from freezing. The unrelated idle
          // tab must still freeze, proving Energy Saver remains active.
          await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
          const evaluate = async (expression: string) => {
            const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          await expect
            .poll(() => evaluate("typeof globalThis.run"), { timeout: 5000 })
            .toBe("function");
          await evaluate(
            `globalThis.run(${JSON.stringify(url)},${soak}).then(value=>globalThis.done={value},error=>globalThis.done={error:error.stack});void 0`,
          );
          const launched = new Set<string>();
          let previousPhase = "";
          let soakStarted: number | undefined;
          let soakFinished = false;
          await expect
            .poll(
              async () => {
                const phase = await evaluate("globalThis.phase");
                if (phase && phase !== previousPhase) {
                  console.log(phase);
                  previousPhase = String(phase);
                }
                if (phase === "six-minute Energy Saver soak" && !soakFinished) {
                  soakStarted ??= Date.now();
                  if (Date.now() - soakStarted >= 360000) {
                    soakFinished = true;
                    await evaluate("globalThis.finishSoak()");
                  }
                }
                if (
                  (phase === "native external link" || phase === "native fallback link") &&
                  !launched.has(phase)
                ) {
                  launched.add(phase);
                  await promisify(execFile)(process.env.BSK_BACKGROUND_CHROME!, [
                    `--user-data-dir=${profile}`,
                    `${url}/${phase === "native external link" ? "external-native" : "external-native-fallback"}`,
                  ]);
                }
                return evaluate("globalThis.done");
              },
              { timeout: soak ? 420000 : 45000, interval: 500 },
            )
            .toBeDefined();
          const done = (await evaluate("globalThis.done")) as { value?: unknown; error?: string };
          expect(done.error).toBeUndefined();
          console.log(JSON.stringify(done.value));
          if (process.env.BSK_BACKGROUND_REPORT) {
            await writeFile(process.env.BSK_BACKGROUND_REPORT, JSON.stringify(done.value, null, 2));
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 450000);
});
