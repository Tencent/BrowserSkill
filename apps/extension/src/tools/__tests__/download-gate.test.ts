import { expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleDownload } from "../download";

it("queues a second download within its timeout instead of rejecting it as invalid (#519)", async () => {
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const a = await sessions.start("download-a");
  const b = await sessions.start("download-b");
  const tab = { id: 7, windowId: 100, active: true } as chrome.tabs.Tab;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  // The first capture holds the browser-global gate until its tab lookup returns.
  const first = handleDownload(sessions, { session_id: a.sessionId, ref: "e1" }, {
    tabsApi: {
      get: async () => {
        await blocked;
        return tab;
      },
      query: async () => {
        await blocked;
        return [tab];
      },
    },
  } as never);
  const deps = { tabsApi: { get: async () => tab, query: async () => [tab] } } as never;

  const late = await handleDownload(
    sessions,
    { session_id: b.sessionId, ref: "e1", timeout_ms: 20 },
    deps,
  );
  expect(late).toMatchObject({ code: "timeout", data: { effect_state: "none", phase: "queue" } });

  const abort = new AbortController();
  const cancelled = handleDownload(
    sessions,
    { session_id: b.sessionId, ref: "e1", timeout_ms: 10_000 },
    { ...(deps as object), signal: abort.signal } as never,
  );
  abort.abort();
  expect(await cancelled).toMatchObject({ code: "cancelled", data: { effect_state: "none" } });

  // A call that keeps waiting runs once the first capture finishes; here it then
  // stops at the missing capability directory, which proves it passed the gate.
  const queued = handleDownload(
    sessions,
    { session_id: b.sessionId, ref: "e1", timeout_ms: 10_000 },
    deps,
  );
  unblock();
  await first;
  expect(await queued).toMatchObject({
    code: "invalid_params",
    message: "download requires a daemon capability directory",
  });
});
