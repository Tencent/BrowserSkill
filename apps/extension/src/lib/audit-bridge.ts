import type { Transport } from "@/transport/transport";
import { isResponseFrame } from "@/transport/types";
import { AUDIT_ENABLED_KEY, AUDIT_MESSAGE, getAuditEnabled } from "./audit";
import type { ConnectionController } from "./connection-controller";
import { defaultStorage } from "./instance-id";

export function auditRpc(transport: Transport, params: Record<string, unknown>): Promise<unknown> {
  const id = `audit-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    let messages: { dispose(): void } | undefined;
    let states: { dispose(): void } | undefined;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timeout")), 10_000);
    messages = transport.onMessage((message) => {
      if (!isResponseFrame(message) || message.id !== id) return;
      finish(
        "error" in message ? new Error("request_failed") : null,
        "result" in message ? message.result : undefined,
      );
    });
    if (settled) messages.dispose();
    states = transport.onConnectionStateChange((state) => {
      if (state === "disconnected") finish(new Error("disconnected"));
    });
    if (settled) states.dispose();
    function finish(error: Error | null, value?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      messages?.dispose();
      states?.dispose();
      if (error) reject(error);
      else resolve(value);
    }
    if (settled) return;
    try {
      transport.send({ id, method: "audit.request", params });
    } catch {
      finish(new Error("disconnected"));
    }
  });
}

export function isAuditPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const extension = new URL(chrome.runtime.getURL("/"));
    return (
      url.protocol === extension.protocol &&
      url.host === extension.host &&
      ["/popup.html", "/audit.html"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}

export function attachAuditBridge(controller: ConnectionController, transport: Transport): void {
  let writes = Promise.resolve();
  let previousHandshake: unknown = null;
  controller.subscribe((snapshot) => {
    if (snapshot.handshake === previousHandshake) return;
    previousHandshake = snapshot.handshake;
    if (snapshot.handshake?.audit_version === 1) {
      writes = writes
        .then(async () => {
          const enabled = await getAuditEnabled();
          controller.setAuditEnabled(enabled);
          await auditRpc(transport, { action: "configure", enabled });
        })
        .catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind !== AUDIT_MESSAGE) return false;
    if (!isAuditPage(sender)) {
      sendResponse({ ok: false, error: "forbidden" });
      return false;
    }
    const action: string = message.action;
    const execute = async () => {
      if (action === "state") return { enabled: await getAuditEnabled() };
      if (action === "configure") {
        if (typeof message.enabled !== "boolean") throw new Error("request_failed");
        await defaultStorage().set({ [AUDIT_ENABLED_KEY]: message.enabled });
        controller.setAuditEnabled(message.enabled);
      }
      const snapshot = controller.snapshot();
      if (
        action === "configure" &&
        (!snapshot.handshake ||
          !snapshot.connectionEnabled ||
          snapshot.handshake.audit_version !== 1)
      )
        return { enabled: message.enabled, pending: true };
      if (!snapshot.handshake || !snapshot.connectionEnabled) throw new Error("disconnected");
      if (snapshot.handshake.audit_version !== 1) throw new Error("unsupported");
      if (!["configure", "list", "get", "delete", "open_directory"].includes(action))
        throw new Error("request_failed");
      const params: Record<string, unknown> = { action };
      for (const key of ["id", "offset", "limit", "enabled"]) {
        if (message[key] !== undefined) params[key] = message[key];
      }
      return auditRpc(transport, params);
    };
    const request = writes.then(execute);
    if (action === "configure")
      writes = request.then(
        () => {},
        () => {},
      );
    void request.then(
      (data) => sendResponse({ ok: true, data }),
      (error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "unavailable" }),
    );
    return true;
  });
}
