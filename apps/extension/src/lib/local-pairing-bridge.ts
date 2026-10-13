import { LocalAuthError } from "@/transport/local-auth";
import {
  initializeLocalMigration,
  readLocalState,
  setSkipLocalVerification,
} from "@/transport/local-credentials";
import { verifyLocalPairing } from "@/transport/pairing-verifier";
import { writeRemoteConnection } from "@/transport/remote-storage";
import type { WSTransport } from "@/transport/ws-transport";
import type { ConnectionController } from "./connection-controller";
import { getOrCreateInstanceId, setDaemonPort } from "./instance-id";

export const LOCAL_PAIRING_MESSAGE = "bsk-local-pairing";
export function trustedPopup(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html") &&
    !sender.tab
  );
}
export function attachLocalPairing(controller: ConnectionController, transport: WSTransport): void {
  const initialize = () =>
    initializeLocalMigration().catch(() => controller.setLocalAuth({ state: "server_unverified" }));
  void initialize();
  chrome.runtime.onInstalled.addListener((details) => {
    void initializeLocalMigration(details).catch(() =>
      controller.setLocalAuth({ state: "server_unverified" }),
    );
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.kind !== LOCAL_PAIRING_MESSAGE) return false;
    if (!trustedPopup(sender)) {
      reply({ error: "Invalid pairing request" });
      return false;
    }
    const action = async () => {
      switch (message.action) {
        case "info": {
          const state = await readLocalState();
          return {
            policy: state.policy,
            devices: state.credentials
              .filter((c) => c.role === "active")
              .map((c) => ({ daemonId: c.daemonId, deviceId: c.deviceId, endpoint: c.endpoint })),
          };
        }
        case "pair": {
          if (typeof message.link !== "string") throw new Error("Invalid pairing request");
          const result = await verifyLocalPairing(
            message.link,
            await getOrCreateInstanceId(),
            chrome.runtime.getURL("").replace(/\/$/, ""),
          );
          await setDaemonPort(Number(new URL(result.endpoint).port || "80"));
          await writeRemoteConnection(null);
          transport.resetAuthenticationBackoff();
          await controller.retryConnection();
          return { ok: true };
        }
        case "skip":
          if (typeof message.value !== "boolean") throw new Error("Invalid pairing request");
          await setSkipLocalVerification(message.value);
          transport.resetAuthenticationBackoff();
          await controller.retryConnection();
          return { ok: true };
        case "retry":
          transport.resetAuthenticationBackoff();
          await controller.retryConnection();
          return { ok: true };
        default:
          throw new Error("Invalid pairing request");
      }
    };
    void action().then(reply, (error) =>
      reply({
        error: error instanceof LocalAuthError ? error.status.state : "pairing_failed",
        ...(error instanceof LocalAuthError ? { browserId: error.status.browserId } : {}),
      }),
    );
    return true;
  });
}
