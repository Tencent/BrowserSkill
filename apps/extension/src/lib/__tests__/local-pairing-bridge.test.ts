import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionController } from "@/lib/connection-controller";
import { getOrCreateInstanceId, setDaemonPort } from "@/lib/instance-id";
import {
  attachLocalPairing,
  LOCAL_PAIRING_MESSAGE,
  MAX_PAIR_TICKETS,
  PAIR_TICKET_TTL_MS,
  parsePairNavigationUrl,
  trustedPairTab,
  trustedPopup,
} from "@/lib/local-pairing-bridge";
import { LocalAuthError } from "@/transport/local-auth";
import { readLocalState, setSkipLocalVerification } from "@/transport/local-credentials";
import { verifyLocalPairing } from "@/transport/pairing-verifier";
import { writeRemoteConnection } from "@/transport/remote-storage";
import type { WSTransport } from "@/transport/ws-transport";

vi.mock("@/lib/instance-id", () => ({
  getOrCreateInstanceId: vi.fn(),
  setDaemonPort: vi.fn(),
}));
vi.mock("@/transport/local-credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/transport/local-credentials")>();
  return {
    ...actual,
    readLocalState: vi.fn(),
    setSkipLocalVerification: vi.fn(),
  };
});
vi.mock("@/transport/pairing-verifier", () => ({
  verifyLocalPairing: vi.fn(),
}));
vi.mock("@/transport/remote-storage", () => ({
  writeRemoteConnection: vi.fn(),
}));

const EXT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaap";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const DAEMON_ID = "AAAAAAAAAAAAAAAAAAAAAA"; // 16 canonical bytes in base64url
const DEVICE_1 = "BBBBBBBBBBBBBBBBBBBBBA";
const DEVICE_2 = "CCCCCCCCCCCCCCCCCCCCCA";
const DEVICE_3 = "DDDDDDDDDDDDDDDDDDDDDA";
const DEVICE_4 = "EEEEEEEEEEEEEEEEEEEEEA";
const DEVICE_5 = "FFFFFFFFFFFFFFFFFFFFFA";
const SECRET = "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGAE"; // 32 canonical bytes in base64url

function makeHttpPairUrl(port: number, deviceId = DEVICE_1, daemonId = DAEMON_ID): string {
  return `http://127.0.0.1:${port}/pair#bsk-local.v1.${daemonId}.${deviceId}.${SECRET}`;
}

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (response: unknown) => void,
) => boolean | undefined;

describe("local-pairing-bridge", () => {
  let nowMs = 1_000_000;
  let onMessageListeners: MessageListener[];
  let beforeNavigateListeners: Array<
    (details: { tabId: number; frameId: number; url: string }) => void
  >;
  let tabsUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string }) => void>;
  let tabsRemovedListeners: Array<(tabId: number) => void>;
  let tabsUpdate: ReturnType<typeof vi.fn>;
  let controller: ConnectionController;
  let transport: WSTransport;

  beforeEach(() => {
    nowMs = 1_000_000;
    onMessageListeners = [];
    beforeNavigateListeners = [];
    tabsUpdatedListeners = [];
    tabsRemovedListeners = [];
    tabsUpdate = vi.fn().mockResolvedValue({});

    vi.stubGlobal("chrome", {
      runtime: {
        id: EXT_ID,
        getURL: (path: string) => `${EXT_ORIGIN}/${path.replace(/^\//, "")}`,
        onMessage: {
          addListener: (fn: MessageListener) => onMessageListeners.push(fn),
        },
      },
      webNavigation: {
        onBeforeNavigate: {
          addListener: (fn: (details: { tabId: number; frameId: number; url: string }) => void) =>
            beforeNavigateListeners.push(fn),
        },
        onCommitted: {
          addListener: vi.fn(),
        },
      },
      tabs: {
        update: tabsUpdate,
        onUpdated: {
          addListener: (fn: (tabId: number, changeInfo: { url?: string }) => void) =>
            tabsUpdatedListeners.push(fn),
        },
        onRemoved: {
          addListener: (fn: (tabId: number) => void) => tabsRemovedListeners.push(fn),
        },
      },
    });

    vi.mocked(getOrCreateInstanceId).mockResolvedValue("a1b2c3d4");
    vi.mocked(setDaemonPort).mockResolvedValue(undefined);
    vi.mocked(writeRemoteConnection).mockResolvedValue(undefined);
    vi.mocked(setSkipLocalVerification).mockResolvedValue(undefined);
    vi.mocked(readLocalState).mockResolvedValue({
      credentials: [],
      policy: { skip: false },
    });
    vi.mocked(verifyLocalPairing).mockImplementation(async (link) => {
      const parsed = new URL(link);
      return {
        state: "verified",
        daemonId: DAEMON_ID,
        deviceId: DEVICE_1,
        endpoint: `ws://127.0.0.1:${parsed.port || "52811"}/`,
      };
    });

    controller = {
      isConnectionEnabled: true,
      retryConnection: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionController;
    transport = {
      resetAuthenticationBackoff: vi.fn(),
    } as unknown as WSTransport;

    attachLocalPairing(controller, transport, { now: () => nowMs });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  async function sendRuntimeMessage(
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
  ): Promise<Record<string, unknown>> {
    return await new Promise((resolve) => {
      for (const listener of onMessageListeners) {
        listener(message, sender, (resp) => resolve(resp as Record<string, unknown>));
      }
    });
  }

  function pairTabSender(tabId: number, ticket: string, frameId = 0): chrome.runtime.MessageSender {
    return {
      id: EXT_ID,
      url: `${EXT_ORIGIN}/pair.html?ticket=${ticket}`,
      frameId,
      tab: { id: tabId } as chrome.tabs.Tab,
    };
  }

  function popupSender(): chrome.runtime.MessageSender {
    return {
      id: EXT_ID,
      url: `${EXT_ORIGIN}/popup.html`,
    };
  }

  it("validates http://127.0.0.1:<port>/pair#bsk-local.v1... URLs strictly", () => {
    const valid = parsePairNavigationUrl(makeHttpPairUrl(52811));
    expect(valid).not.toBeNull();
    expect(valid?.port).toBe(52811);
    expect(valid?.link).toBe(
      `ws://127.0.0.1:52811/#bsk-local.v1.${DAEMON_ID}.${DEVICE_1}.${SECRET}`,
    );

    expect(parsePairNavigationUrl(makeHttpPairUrl(0))).toBeNull();
    expect(parsePairNavigationUrl(makeHttpPairUrl(70000))).toBeNull();
    expect(
      parsePairNavigationUrl(
        `http://localhost:52811/pair#bsk-local.v1.${DAEMON_ID}.${DEVICE_1}.${SECRET}`,
      ),
    ).toBeNull();
    expect(
      parsePairNavigationUrl(
        `https://127.0.0.1:52811/pair#bsk-local.v1.${DAEMON_ID}.${DEVICE_1}.${SECRET}`,
      ),
    ).toBeNull();
    expect(
      parsePairNavigationUrl(
        `http://127.0.0.1:52811/pair?x=1#bsk-local.v1.${DAEMON_ID}.${DEVICE_1}.${SECRET}`,
      ),
    ).toBeNull();
    expect(parsePairNavigationUrl("http://127.0.0.1:52811/pair#bsk-local.v1.bad")).toBeNull();
  });

  it("intercepts only frameId === 0 navigations and redirects without exposing the secret", async () => {
    // Subframe navigation must be ignored.
    beforeNavigateListeners[0]({
      tabId: 10,
      frameId: 1,
      url: makeHttpPairUrl(52811),
    });
    expect(tabsUpdate).not.toHaveBeenCalled();

    // Main-frame navigation mints a ticket and redirects to pair.html?ticket=<uuid>.
    beforeNavigateListeners[0]({
      tabId: 10,
      frameId: 0,
      url: makeHttpPairUrl(52811),
    });
    expect(tabsUpdate).toHaveBeenCalledOnce();
    const redirectedUrl = tabsUpdate.mock.calls[0][1].url as string;
    expect(redirectedUrl.startsWith(`${EXT_ORIGIN}/pair.html?ticket=`)).toBe(true);
    expect(redirectedUrl).not.toContain(SECRET);

    // Immediate duplicate tabs.onUpdated for the same navigation does not double-mint.
    tabsUpdatedListeners[0](10, { url: makeHttpPairUrl(52811) });
    expect(tabsUpdate).toHaveBeenCalledOnce();

    const ticket = new URL(redirectedUrl).searchParams.get("ticket")!;
    const inspectReply = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "inspect_ticket", ticket },
      pairTabSender(10, ticket),
    );
    expect(JSON.stringify(inspectReply)).not.toContain(SECRET);
    expect(inspectReply.preview).toMatchObject({
      port: 52811,
      hostPort: "127.0.0.1:52811",
      endpoint: "ws://127.0.0.1:52811",
      daemonFingerprint: DAEMON_ID.slice(0, 8),
      deviceFingerprint: DEVICE_1.slice(0, 8),
      instanceId: "a1b2c3d4",
      existingPairing: "unpaired",
    });
  });

  it("enforces sender boundaries: pair.html cannot skip, and cross-tab ticket access is rejected", async () => {
    expect(trustedPopup(popupSender())).toBe(true);
    expect(trustedPopup(pairTabSender(7, "t1"))).toBe(false);
    expect(trustedPairTab(pairTabSender(7, "t1"), 7)).toBe(true);
    expect(trustedPairTab(pairTabSender(7, "t1"), 8)).toBe(false);
    expect(trustedPairTab(pairTabSender(7, "t1", 1), 7)).toBe(false);
    expect(trustedPairTab(popupSender(), 7)).toBe(false);

    beforeNavigateListeners[0]({
      tabId: 7,
      frameId: 0,
      url: makeHttpPairUrl(52822),
    });
    const redirectedUrl = tabsUpdate.mock.calls[0][1].url as string;
    const ticket = new URL(redirectedUrl).searchParams.get("ticket")!;

    // pair.html must never be allowed to invoke `skip` or `pair`.
    const skipAttempt = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "skip", value: true },
      pairTabSender(7, ticket),
    );
    expect(skipAttempt).toEqual({ error: "Invalid pairing request" });
    expect(setSkipLocalVerification).not.toHaveBeenCalled();

    // Another tab opening pair.html?ticket=<stolen> must be rejected AND keep tab 7's ticket intact.
    const crossTabAttempt = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "approve_ticket", ticket },
      pairTabSender(99, ticket),
    );
    expect(crossTabAttempt).toEqual({ error: "Invalid pairing request" });
    expect(verifyLocalPairing).not.toHaveBeenCalled();

    // Original tab 7 can still approve once, and a second attempt sees ticket_expired.
    vi.mocked(verifyLocalPairing).mockResolvedValueOnce({
      state: "verified",
      daemonId: DAEMON_ID,
      deviceId: DEVICE_1,
      endpoint: "ws://127.0.0.1:52822/",
    });
    const approved = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "approve_ticket", ticket },
      pairTabSender(7, ticket),
    );
    expect(approved).toEqual({ ok: true, connectionEnabled: true });
    expect(verifyLocalPairing).toHaveBeenCalledWith(
      `ws://127.0.0.1:52822/#bsk-local.v1.${DAEMON_ID}.${DEVICE_1}.${SECRET}`,
      "a1b2c3d4",
      EXT_ORIGIN,
    );
    expect(setDaemonPort).toHaveBeenCalledWith(52822);
    expect(writeRemoteConnection).toHaveBeenCalledWith(null);
    expect(transport.resetAuthenticationBackoff).toHaveBeenCalledOnce();
    expect(controller.retryConnection).toHaveBeenCalledOnce();

    const replay = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "approve_ticket", ticket },
      pairTabSender(7, ticket),
    );
    expect(replay).toEqual({ error: "ticket_expired" });
  });

  it("expires tickets after 5 minutes, evicts beyond 4 tickets, and surfaces already_paired", async () => {
    const devices = [DEVICE_1, DEVICE_2, DEVICE_3, DEVICE_4, DEVICE_5];
    const minted: Array<{ tabId: number; ticket: string }> = [];
    for (let i = 0; i < devices.length; i++) {
      const tabId = 20 + i;
      beforeNavigateListeners[0]({
        tabId,
        frameId: 0,
        url: makeHttpPairUrl(52830 + i, devices[i]),
      });
      const url = tabsUpdate.mock.calls[i][1].url as string;
      minted.push({ tabId, ticket: new URL(url).searchParams.get("ticket")! });
    }
    expect(MAX_PAIR_TICKETS).toBe(4);

    // 1st ticket was evicted when the 5th arrived.
    const evictedReply = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "inspect_ticket", ticket: minted[0].ticket },
      pairTabSender(minted[0].tabId, minted[0].ticket),
    );
    expect(evictedReply).toEqual({ error: "ticket_expired" });

    // 2nd ticket works and surfaces LocalAuthError(already_paired).
    vi.mocked(verifyLocalPairing).mockRejectedValueOnce(
      new LocalAuthError({ state: "already_paired", browserId: "a1b2c3d4" }),
    );
    const alreadyPaired = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "approve_ticket", ticket: minted[1].ticket },
      pairTabSender(minted[1].tabId, minted[1].ticket),
    );
    expect(alreadyPaired).toEqual({ error: "already_paired", browserId: "a1b2c3d4" });

    // Closing tab cleans up its ticket.
    tabsRemovedListeners[0](minted[2].tabId);
    const closedTabReply = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "inspect_ticket", ticket: minted[2].ticket },
      pairTabSender(minted[2].tabId, minted[2].ticket),
    );
    expect(closedTabReply).toEqual({ error: "ticket_expired" });

    // Advancing clock past TTL expires remaining tickets.
    nowMs += PAIR_TICKET_TTL_MS + 1;
    const ttlReply = await sendRuntimeMessage(
      { kind: LOCAL_PAIRING_MESSAGE, action: "inspect_ticket", ticket: minted[4].ticket },
      pairTabSender(minted[4].tabId, minted[4].ticket),
    );
    expect(ttlReply).toEqual({ error: "ticket_expired" });
  });
});
