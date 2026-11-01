// @vitest-environment node
// BSK_TAB_DETACH_CHROME=/path/to/chrome runs in an isolated headless profile.
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

// Keep the real overlay state machine and message protocol, without mounting
// the full application UI or connecting this isolated test browser to a daemon.
const content = `
import { OverlayController } from '@/content/overlay-controller';
import { OVERLAY_AGENT_STATE, OVERLAY_AGENT_OVERLAY_RESET, OverlayVersionGate } from '@/lib/overlay-bridge';
const overlay = new OverlayController(), versions = new OverlayVersionGate(), identity = crypto.randomUUID();
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
 if (message.type === OVERLAY_AGENT_STATE && versions.admit(message))
  overlay.applyAgentControlMode(message.sessionId, message.mode);
 if (message.type === OVERLAY_AGENT_OVERLAY_RESET && versions.admit(message))
  overlay.resetAgentOverlays(message.sessionId);
 if (message.type === 'fixture.overlay') reply({...overlay.snapshot(), identity});
 else reply({ok:true});
});
`;

// Use the production lifecycle listener, ownership, tab tools and CDP driver.
// Only the daemon transport is replaced by a recorder.
// A direct Chrome move deliberately bypasses the tool's expected-move registry,
// producing the same browser events as a user dragging a tab between windows.
const entry = `
import { ChromiumCdp } from '@/browser-driver/chromium-cdp';
import { attachCooperation } from '@/cooperation/browser-bridge';
import { nextOverlayVersion } from '@/lib/overlay-version';
import { OVERLAY_AGENT_STATE } from '@/lib/overlay-bridge';
import { attachSessionEventHandler } from '@/session-manager/event-handler';
import { SessionManager } from '@/session-manager/manager';
import { handleSessionStop } from '@/tools/session';
import { chromeTabMutationApi, chromeTabsApi, handleTabBorrow, handleTabCreate, handleTabReturn } from '@/tools/tabs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async (predicate, label) => {
 const deadline = Date.now() + 10000;
 while (!(await predicate())) {
  if (Date.now() > deadline) throw new Error('Timed out: ' + label);
  await sleep(25);
 }
};
globalThis.run = async url => {
 const controller = await chrome.tabs.getCurrent();
 await chrome.windows.create({tabId: controller.id, type: 'popup', focused: false});
 const user = (await chrome.windows.getAll({windowTypes: ['normal']}))[0];
 const manager = new SessionManager(), cdp = new ChromiumCdp(chrome.debugger);
 const events = [], completed = [];
 let cooperation;
 const lifecycle = attachSessionEventHandler({
  manager, cdp, transport: {send: event => events.push(event)},
  onSessionReleased: task => cooperation.release(task.sessionId),
  onSessionsChanged: () => cooperation.syncSessions(),
 });
 cooperation = attachCooperation(manager, () => {});
 const readOverlay = id => chrome.tabs.sendMessage(id, {type: 'fixture.overlay'});
 const active = async (task, id) => {
  await wait(async () => {
   try { return Boolean((await readOverlay(id))?.identity); } catch { return false; }
  }, 'content ready ' + id);
  await cooperation.observeTab(id);
  await cdp.acquireBackgroundExecution(task.sessionId, id);
  await chrome.tabs.sendMessage(id, {
   type: OVERLAY_AGENT_STATE, mode: 'control', sessionId: task.sessionId, ...nextOverlayVersion(),
  });
  check((await readOverlay(id)).controlVisible, 'control overlay missing ' + id);
  return id;
 };
 const start = async (label, extra = 1) => {
  globalThis.phase = label;
  const task = await manager.start(label);
  cooperation.startSession(task.sessionId);
  const home = [...task.agentCreatedTabs][0];
  await chrome.tabs.update(home, {url: url + '/' + label});
  await active(task, home);
  for (let index = 0; index < extra; index++) {
   const result = await handleTabCreate(manager, {
    session_id: task.sessionId, url: url + '/' + label + '/' + index,
   }, {cdp});
   check(!result.code, JSON.stringify(result));
   await active(task, result.tab_id);
  }
  return task;
 };
 const borrow = async task => {
  const tab = await chrome.tabs.create({windowId: user.id, url: url + '/borrow-' + task.sessionId, active: false});
  const result = await handleTabBorrow(manager, {session_id: task.sessionId, tab_id: tab.id}, {
   approveBorrow: async () => true, cdp,
  });
  check(!result.code, JSON.stringify(result));
  check(manager.has(task.sessionId), 'borrowing ended the task');
  await active(task, tab.id);
  return tab.id;
 };
 const observe = async task => {
  const tab = await chrome.tabs.create({windowId: task.agentWindowId, url: url + '/observed-' + task.sessionId, active: false});
  (task.observedTabs ??= new Set()).add(tab.id);
  await active(task, tab.id);
  return tab.id;
 };
 const claimed = task => [...task.agentCreatedTabs, ...task.borrowedTabs.keys(), ...(task.observedTabs ?? [])];
 const snapshot = async task => Promise.all(claimed(task).map(async id => ({
  id, windowId: (await chrome.tabs.get(id)).windowId, identity: (await readOverlay(id)).identity,
 })));
 const sessionEvents = task => events.filter(event => event.payload?.session_id === task.sessionId);
 const assertReleased = async (task, before, movedIds) => {
  await wait(() => !manager.has(task.sessionId), 'task release');
  await wait(() => sessionEvents(task).length > 0, 'terminal event');
  await wait(async () => (await Promise.all(before.map(async ({id}) => {
   const overlay = await readOverlay(id);
   return overlay.controlMode === 'hidden' && !overlay.controlVisible;
  }))).every(Boolean), 'overlays released');
  await wait(async () => {
   const targets = await chrome.debugger.getTargets();
   return before.every(({id}) => !targets.find(target => target.tabId === id)?.attached);
  }, 'debuggers released');
  const targets = await chrome.debugger.getTargets();
  for (const old of before) {
   const tab = await chrome.tabs.get(old.id), overlay = await readOverlay(old.id);
   check(tab.windowId === (movedIds.includes(old.id) ? user.id : old.windowId), 'unexpected page relocation ' + old.id);
   check(overlay.identity === old.identity, 'document was recreated ' + old.id);
   check(manager.findControllingSession(old.id) === null, 'ownership survived ' + old.id);
   check(!cooperation.enabled(old.id), 'cooperation survived ' + old.id);
   check(!cdp.ownsBackgroundExecution(task.sessionId, old.id), 'background execution survived ' + old.id);
   check(!targets.find(target => target.tabId === old.id)?.attached, 'debugger survived ' + old.id);
  }
  check(!cooperation.hasSession(task.sessionId), 'default cooperation survived');
  await sleep(150);
  const terminal = sessionEvents(task);
  check(terminal.length === 1, 'duplicate terminal events: ' + JSON.stringify(terminal));
  check(terminal[0].event === 'session.ended' && terminal[0].payload.reason === 'user_moved_tab', 'wrong termination reason: ' + JSON.stringify(terminal));
  check((await chrome.windows.get(user.id)).type === 'normal', 'ordinary window disappeared');
  completed.push(task.sessionId);
 };
 try {
  const sibling = await start('independent-task', 0);
  const created = await start('created-tab');
  const borrowed = await borrow(created);
  await observe(created);
  const before = await snapshot(created), moved = [...created.agentCreatedTabs][1];
  await chrome.tabs.move(moved, {windowId: user.id, index: -1});
  await assertReleased(created, before, [moved]);
  check((await chrome.tabs.get(borrowed)).windowId === created.agentWindowId, 'drag exit returned a borrowed tab');
  check((await chrome.windows.get(created.agentWindowId)).type === 'normal', 'remaining task pages lost their window');
  check(manager.has(sibling.sessionId), 'drag ended another task');
  check((await readOverlay([...sibling.agentCreatedTabs][0])).controlVisible, 'another task lost its overlay');

  for (const kind of ['borrowed-tab', 'observed-tab']) {
   const task = await start(kind, 0);
   const movedId = kind === 'borrowed-tab' ? await borrow(task) : await observe(task);
   const saved = await snapshot(task);
   await chrome.tabs.move(movedId, {windowId: user.id, index: -1});
   await assertReleased(task, saved, [movedId]);
  }

  const grouped = await start('whole-group');
  const groupedTabs = await snapshot(grouped);
  // Simulate a user-created group; BrowserSkill must release control without
  // dismantling the user's grouping when the whole group is dragged out.
  const groupId = await chrome.tabs.group({
   tabIds: groupedTabs.map(tab => tab.id), createProperties: {windowId: grouped.agentWindowId},
  });
  await chrome.tabGroups.update(groupId, {title: 'User group', color: 'blue'});
  await chrome.tabGroups.move(groupId, {windowId: user.id, index: -1});
  await assertReleased(grouped, groupedTabs, groupedTabs.map(tab => tab.id));
  const movedGroup = (await chrome.tabs.get(groupedTabs[0].id)).groupId;
  check(movedGroup !== -1, 'user group removed');
  for (const {id} of groupedTabs) check((await chrome.tabs.get(id)).groupId === movedGroup, 'user group split');
  check((await chrome.tabGroups.get(movedGroup)).title === 'User group', 'user group renamed');
  check(!(await chrome.windows.get(grouped.agentWindowId).catch(() => null)), 'empty source window remained');

  const last = await start('last-tab', 0), lastTabs = await snapshot(last);
  await chrome.tabs.move(lastTabs[0].id, {windowId: user.id, index: -1});
  await assertReleased(last, lastTabs, [lastTabs[0].id]);
  check(!(await chrome.windows.get(last.agentWindowId).catch(() => null)), 'last-tab source window remained');

  const reordered = await start('same-window-reorder', 2);
  const reorderId = [...reordered.agentCreatedTabs][0];
  await chrome.tabs.move(reorderId, {index: -1});
  await sleep(150);
  check(manager.has(reordered.sessionId) && sessionEvents(reordered).length === 0, 'same-window reorder ended task');
  check((await readOverlay(reorderId)).controlVisible, 'same-window reorder hid overlay');
  completed.push(reordered.sessionId);
  const unrelated = await chrome.tabs.create({windowId: reordered.agentWindowId, url: url + '/unrelated', active: false});
  await chrome.tabs.move(unrelated.id, {windowId: user.id, index: -1});
  await sleep(150);
  check(manager.has(reordered.sessionId) && sessionEvents(reordered).length === 0, 'unrelated tab move ended task');
  completed.push('unrelated-tab');

  const returning = await start('programmatic-return', 0);
  const returnId = await borrow(returning);
  const returned = await handleTabReturn(manager, {session_id: returning.sessionId, tab_id: returnId}, {cdp});
  check(!returned.code, JSON.stringify(returned));
  await sleep(150);
  check(manager.has(returning.sessionId) && sessionEvents(returning).length === 0, 'tab_return ended task');
  check((await chrome.tabs.get(returnId)).windowId === user.id, 'tab_return did not restore user window');
  completed.push(returning.sessionId);

  const stopping = await start('ordinary-stop');
  const stopBorrowed = await borrow(stopping), stopCreated = [...stopping.agentCreatedTabs];
  const stopped = await handleSessionStop(manager, {session_id: stopping.sessionId}, {
   cdp, tabManagement: {tabs: chromeTabMutationApi}, tabsQuery: chromeTabsApi,
  });
  check(!stopped.code && !stopped.return_failures, JSON.stringify(stopped));
  await sleep(150);
  check(!manager.has(stopping.sessionId), 'ordinary stop retained session');
  check(sessionEvents(stopping).length === 0, 'ordinary stop emitted a user termination event');
  check((await chrome.tabs.get(stopBorrowed)).windowId === user.id, 'ordinary stop did not return borrow');
  for (const id of stopCreated) check(!(await chrome.tabs.get(id).catch(() => null)), 'ordinary stop retained agent-created tab');
  completed.push(stopping.sessionId);
  return {completed, terminalEvents: events};
 } finally {
  lifecycle.dispose(); await cdp.detachAll(); cdp.dispose();
 }
};
`;

describe.skipIf(!process.env.BSK_TAB_DETACH_CHROME)("tab detachment browser regression", () => {
  it("releases the whole task after an unregistered cross-window move", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-tab-detachment-"));
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Tab detachment fixture</title><input value='keep me'>");
    });
    try {
      const require = createRequire(import.meta.url);
      const { build } = await import(
        require.resolve("vite", { paths: [require.resolve("vitest")] })
      );
      for (const [name, source] of [
        ["entry", entry],
        ["content", content],
      ]) {
        const file = path.join(directory, `${name}.js`);
        await writeFile(file, source);
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
              entry: file,
              formats: ["iife"],
              name: `Detachment${name}`,
              fileName: () => `${name}.bundle.js`,
            },
          },
        });
      }
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Tab detachment regression",
          version: "1.0",
          background: { service_worker: "worker.js" },
          // Only the fixture uses tabGroups to simulate the user's group drag.
          permissions: ["debugger", "tabs", "tabGroups", "storage", "webNavigation"],
          host_permissions: ["http://127.0.0.1/*"],
          content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.bundle.js"] }],
        }),
      );
      await writeFile(
        path.join(directory, "worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {});",
      );
      // Install diagnostics before the bundle executes. Keep this in a separate
      // script because Manifest V3 forbids inline scripts in extension pages.
      await writeFile(
        path.join(directory, "bootstrap.js"),
        `globalThis.bootstrapErrors = [];
window.addEventListener('error', event => {
 globalThis.bootstrapErrors.push({
  kind: 'error', message: event.message, filename: event.filename,
  line: event.lineno, column: event.colno, stack: event.error?.stack,
  resource: event.target?.src,
 });
}, true);
window.addEventListener('unhandledrejection', event => {
 globalThis.bootstrapErrors.push({kind: 'unhandledrejection', message: String(event.reason), stack: event.reason?.stack});
});`,
      );
      await writeFile(
        path.join(directory, "regression.html"),
        '<!doctype html><script src="bootstrap.js"></script><script src="entry.bundle.js"></script>',
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
          executable: process.env.BSK_TAB_DETACH_CHROME,
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
                  targetInfos: { type: string; url: string }[];
                }>("Target.getTargets");
                const worker = targetInfos.find(
                  (target) => target.type === "service_worker" && target.url.endsWith("/worker.js"),
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
          const evaluate = async (expression: string) => {
            const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true },
              sessionId,
            );
            expect(reply.exceptionDetails).toBeUndefined();
            return reply.result.value;
          };
          try {
            await expect
              .poll(() => evaluate("typeof globalThis.run"), { timeout: 5000 })
              .toBe("function");
          } catch (error) {
            const diagnostics = await evaluate(`({
              url: location.href, readyState: document.readyState,
              run: typeof globalThis.run, errors: globalThis.bootstrapErrors,
              scripts: [...document.scripts].map(script => script.src),
            })`);
            throw new Error(`Regression bootstrap failed: ${JSON.stringify(diagnostics)}`, {
              cause: error,
            });
          }
          await evaluate(
            `globalThis.run(${JSON.stringify(url)}).then(value=>globalThis.done={value},error=>globalThis.done={error:error.stack,phase:globalThis.phase});void 0`,
          );
          await expect
            .poll(() => evaluate("globalThis.done"), { timeout: 45000, interval: 100 })
            .toBeDefined();
          const done = (await evaluate("globalThis.done")) as { value?: unknown; error?: string };
          expect(done.error).toBeUndefined();
          console.log(JSON.stringify(done.value));
          if (process.env.BSK_TAB_DETACH_REPORT) {
            await writeFile(process.env.BSK_TAB_DETACH_REPORT, JSON.stringify(done.value, null, 2));
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
