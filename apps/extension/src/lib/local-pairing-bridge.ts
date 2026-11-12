import { LocalAuthError } from "@/transport/local-auth";
import {
  parseLocalPairing,
  readLocalState,
  setSkipLocalVerification,
} from "@/transport/local-credentials";
import { verifyLocalPairing } from "@/transport/pairing-verifier";
import { writeRemoteConnection } from "@/transport/remote-storage";
import type { WSTransport } from "@/transport/ws-transport";
import type { ConnectionController } from "./connection-controller";
import { getOrCreateInstanceId, setDaemonPort } from "./instance-id";

export const LOCAL_PAIRING_MESSAGE = "bsk-local-pairing";
export const PAIR_TICKET_TTL_MS = 5 * 60_000;
export const MAX_PAIR_TICKETS = 4;
export const PAIR_NAVIGATION_URL_RE =
  /^http:\/\/127\.0\.0\.1:(\d+)\/pair(#bsk-local\.v1\.[A-Za-z0-9._-]+)$/;

const DUPLICATE_NAVIGATION_SUPPRESS_MS = 1_000;

export type ExistingPairingState = "unpaired" | "same_daemon" | "other_daemon";

export interface PairTicketPreview {
  port: number;
  hostPort: string;
  endpoint: string;
  daemonFingerprint: string;
  deviceFingerprint: string;
  instanceId: string;
  existingPairing: ExistingPairingState;
  expiresAt: number;
}

interface PairTicket {
  ticketId: string;
  tabId: number;
  port: number;
  daemonId: string;
  daemonFingerprint: string;
  deviceFingerprint: string;
  link: string;
  createdAt: number;
  expiresAt: number;
}

export interface ParsedPairNavigation {
  port: number;
  daemonId: string;
  deviceId: string;
  link: string;
}

export function parsePairNavigationUrl(rawUrl: string): ParsedPairNavigation | null {
  const match = PAIR_NAVIGATION_URL_RE.exec(rawUrl);
  if (!match) return null;
  const wsLink = `ws://127.0.0.1:${match[1]}/${match[2]}`;
  try {
    const parsed = parseLocalPairing(wsLink);
    return {
      port: Number(match[1]),
      daemonId: parsed.daemonId,
      deviceId: parsed.deviceId,
      link: wsLink,
    };
  } catch {
    return null;
  }
}

export function trustedPopup(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html") &&
    !sender.tab
  );
}

export function trustedPairTab(
  sender: chrome.runtime.MessageSender,
  expectedTabId: number,
): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab?.id !== expectedTabId) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  if (typeof sender.url !== "string") return false;
  const pairBase = chrome.runtime.getURL("pair.html");
  if (!sender.url.startsWith(`${pairBase}?`)) return false;
  const query = sender.url.slice(pairBase.length + 1).split("#", 1)[0] ?? "";
  const ticket = new URLSearchParams(query).get("ticket");
  return typeof ticket === "string" && ticket.length > 0;
}

function senderTicketParam(sender: chrome.runtime.MessageSender): string | null {
  if (typeof sender.url !== "string") return null;
  const queryIndex = sender.url.indexOf("?");
  if (queryIndex < 0) return null;
  const query = sender.url.slice(queryIndex + 1).split("#", 1)[0] ?? "";
  return new URLSearchParams(query).get("ticket");
}

async function completeLocalPairing(
  link: string,
  controller: ConnectionController,
  transport: WSTransport,
): Promise<{ ok: true; connectionEnabled: boolean }> {
  const result = await verifyLocalPairing(
    link,
    await getOrCreateInstanceId(),
    chrome.runtime.getURL("").replace(/\/$/, ""),
  );
  await setDaemonPort(Number(new URL(result.endpoint).port || "80"));
  await writeRemoteConnection(null);
  transport.resetAuthenticationBackoff();
  await controller.retryConnection();
  return { ok: true, connectionEnabled: controller.isConnectionEnabled };
}

export function attachLocalPairing(
  controller: ConnectionController,
  transport: WSTransport,
  options: { now?: () => number } = {},
): void {
  const now = options.now ?? Date.now;
  const tickets = new Map<string, PairTicket>();

  function pruneExpiredTickets(nowMs: number): void {
    for (const [id, entry] of tickets) {
      if (entry.expiresAt <= nowMs) tickets.delete(id);
    }
  }

  function redirectToPairTab(tabId: number, ticketId: string): void {
    const targetUrl = chrome.runtime.getURL(`pair.html?ticket=${ticketId}`);
    void Promise.resolve(chrome.tabs.update(tabId, { url: targetUrl })).catch(() => {});
  }

  function handleTopLevelPairNavigation(tabId: number, url: string): void {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const parsed = parsePairNavigationUrl(url);
    if (!parsed) return;
    const nowMs = now();
    pruneExpiredTickets(nowMs);

    for (const existing of tickets.values()) {
      if (existing.tabId === tabId && existing.link === parsed.link) {
        const recentlyRedirected = nowMs - existing.createdAt < DUPLICATE_NAVIGATION_SUPPRESS_MS;
        existing.expiresAt = nowMs + PAIR_TICKET_TTL_MS;
        if (!recentlyRedirected) {
          existing.createdAt = nowMs;
          redirectToPairTab(tabId, existing.ticketId);
        }
        return;
      }
    }

    for (const [id, existing] of tickets) {
      if (existing.tabId === tabId) tickets.delete(id);
    }
    while (tickets.size >= MAX_PAIR_TICKETS) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }

    const ticketId = crypto.randomUUID();
    tickets.set(ticketId, {
      ticketId,
      tabId,
      port: parsed.port,
      daemonId: parsed.daemonId,
      daemonFingerprint: parsed.daemonId.slice(0, 8),
      deviceFingerprint: parsed.deviceId.slice(0, 8),
      link: parsed.link,
      createdAt: nowMs,
      expiresAt: nowMs + PAIR_TICKET_TTL_MS,
    });
    redirectToPairTab(tabId, ticketId);
  }

  if (typeof chrome.webNavigation?.onBeforeNavigate?.addListener === "function") {
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      if (details.frameId !== 0) return;
      handleTopLevelPairNavigation(details.tabId, details.url);
    });
  }
  if (typeof chrome.webNavigation?.onCommitted?.addListener === "function") {
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return;
      handleTopLevelPairNavigation(details.tabId, details.url);
    });
  }
  if (typeof chrome.tabs?.onUpdated?.addListener === "function") {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (typeof changeInfo.url === "string") {
        handleTopLevelPairNavigation(tabId, changeInfo.url);
      }
    });
  }
  if (typeof chrome.tabs?.onRemoved?.addListener === "function") {
    chrome.tabs.onRemoved.addListener((tabId) => {
      for (const [id, entry] of tickets) {
        if (entry.tabId === tabId) tickets.delete(id);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.kind !== LOCAL_PAIRING_MESSAGE) return false;

    if (message.action === "inspect_ticket" || message.action === "approve_ticket") {
      if (typeof message.ticket !== "string" || !message.ticket) {
        reply({ error: "Invalid pairing request" });
        return false;
      }
      const senderTabId = sender.tab?.id;
      if (
        typeof senderTabId !== "number" ||
        !trustedPairTab(sender, senderTabId) ||
        senderTicketParam(sender) !== message.ticket
      ) {
        reply({ error: "Invalid pairing request" });
        return false;
      }
      pruneExpiredTickets(now());
      const ticket = tickets.get(message.ticket);
      if (!ticket) {
        reply({ error: "ticket_expired" });
        return false;
      }
      if (!trustedPairTab(sender, ticket.tabId)) {
        reply({ error: "Invalid pairing request" });
        return false;
      }

      const runTicketAction = async () => {
        if (message.action === "inspect_ticket") {
          const [state, instanceId] = await Promise.all([
            readLocalState(),
            getOrCreateInstanceId(),
          ]);
          const active = state.credentials.filter((c) => c.role === "active");
          const existingPairing: ExistingPairingState = active.some(
            (c) => c.daemonId === ticket.daemonId,
          )
            ? "same_daemon"
            : active.length > 0
              ? "other_daemon"
              : "unpaired";
          const preview: PairTicketPreview = {
            port: ticket.port,
            hostPort: `127.0.0.1:${ticket.port}`,
            endpoint: `ws://127.0.0.1:${ticket.port}`,
            daemonFingerprint: ticket.daemonFingerprint,
            deviceFingerprint: ticket.deviceFingerprint,
            instanceId,
            existingPairing,
            expiresAt: ticket.expiresAt,
          };
          return { preview };
        }
        tickets.delete(ticket.ticketId);
        return completeLocalPairing(ticket.link, controller, transport);
      };

      void runTicketAction().then(reply, (error) =>
        reply({
          error: error instanceof LocalAuthError ? error.status.state : "pairing_failed",
          ...(error instanceof LocalAuthError ? { browserId: error.status.browserId } : {}),
        }),
      );
      return true;
    }

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
          return completeLocalPairing(message.link, controller, transport);
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
