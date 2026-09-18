import type { SessionManager } from "@/session-manager/manager";
import { handleDebug } from "@/tools/debug";
import { isRpcError } from "@/tools/shared";
import type { DebugManager } from "./manager";
import type { DebugParams } from "./types";

export const DEBUG_MESSAGE = "bsk_debug";

/** Only extension-owned UI may read evidence; content scripts are excluded. */
export function isDebugPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const origin = new URL(chrome.runtime.getURL("/"));
    const url = new URL(sender.url);
    return (
      url.protocol === origin.protocol &&
      url.host === origin.host &&
      ["/popup.html", "/debug.html"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}

export function attachDebugBridge(sessions: SessionManager, debug: DebugManager): void {
  let writes = Promise.resolve();
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== DEBUG_MESSAGE) return false;
    if (!isDebugPage(sender)) {
      respond({ ok: false, error: "forbidden" });
      return false;
    }
    const action = message.action;
    const execute = async () => {
      if (action === "tasks") return { tasks: await debug.tasks() };
      const params = message.params as DebugParams;
      const result = await handleDebug(sessions, params, debug);
      if (isRpcError(result)) throw new Error(result.message);
      return result;
    };
    const request = writes.then(execute);
    if (message.params?.action === "start" || message.params?.action === "stop")
      writes = request.then(
        () => {},
        () => {},
      );
    void request.then(
      (data) => respond({ ok: true, data }),
      (error: unknown) =>
        respond({ ok: false, error: error instanceof Error ? error.message : "unavailable" }),
    );
    return true;
  });
}
