import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateRemoteEndpoint,
  renewRemoteAuthorization,
  updateRemoteConnection,
  watchRemoteAuthorization,
} from "../remote-authorization";
import { REMOTE_ENDPOINT_KEY, type RemoteEndpoint } from "../remote-endpoint";

let values: Record<string, unknown>;
vi.mock("../remote-storage", () => ({
  initializeRemoteStorage: async () => {},
  REMOTE_CONNECTION_REVISION: "revision",
  REMOTE_CONNECTION_MODE: "mode",
  readRemoteConnection: async () => values["bsk_remote_endpoint"],
  writeRemoteConnection: async (endpoint: unknown) => {
    values["bsk_remote_endpoint"] = structuredClone(endpoint);
  },
}));
let changes: (changes: Record<string, unknown>, area: string) => void;
const endpoint: RemoteEndpoint = {
  url: "wss://gateway.example/api/v1/local-browser/extension",
  token: "a".repeat(43),
  deviceId: "a".repeat(32),
  expiresAt: "2099-01-01T00:00:00Z",
  renewAfter: "2020-01-01T00:00:00Z",
};
const response = () =>
  new Response(
    JSON.stringify({
      device_id: endpoint.deviceId,
      expires_at: "2099-02-01T00:00:00Z",
      renew_after: "2099-01-01T00:00:00Z",
    }),
    { status: 200 },
  );
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T00:00:00Z"));
  values = { [REMOTE_ENDPOINT_KEY]: { ...endpoint } };
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => {
          changes = listener;
        }),
        removeListener: vi.fn(),
      },
      local: {
        get: vi.fn(async () => ({ ...values })),
        set: vi.fn(async (next) => {
          Object.assign(values, next);
        }),
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("durable remote authorization", () => {
  it("exchanges a pairing link over HTTPS without putting credentials in the URL", async () => {
    const result = await activateRemoteEndpoint({ url: endpoint.url, token: endpoint.token });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://gateway.example/api/v1/local-browser/extension/authorize");
    expect(options?.redirect).toBe("error");
    expect(options?.credentials).toBe("omit");
    expect(options?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${endpoint.token}` }),
    );
    expect(result.token).not.toBe(endpoint.token);
    expect(result.deviceId).toBe(endpoint.deviceId);
    expect(JSON.parse(String(options?.body)).next_token).toBe(result.token);
  });
  it("retains the candidate after a lost response and retries the same rotation", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost"));
    await expect(renewRemoteAuthorization()).rejects.toThrow("connection lost");
    const pending = values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint;
    expect(pending.token).toBe(endpoint.token);
    expect(pending.pendingToken).toHaveLength(43);
    expect(pending.renewalFailure).toBe("unavailable");
    await renewRemoteAuthorization();
    expect(fetch).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(Date.now() + 60_000);
    await renewRemoteAuthorization();
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).token).toBe(pending.pendingToken);
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).pendingToken).toBeUndefined();
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).renewalFailure).toBeUndefined();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).next_token).toBe(
      JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).next_token,
    );
  });
  it.each([
    { device_id: "wrong", expires_at: "2099-02-01T00:00:00Z", renew_after: "2099-01-01T00:00:00Z" },
    {
      device_id: "b".repeat(32),
      expires_at: "2099-02-01T00:00:00Z",
      renew_after: "2099-01-01T00:00:00Z",
    },
    { device_id: endpoint.deviceId, expires_at: "invalid", renew_after: "2099-01-01T00:00:00Z" },
  ])("does not persist an invalid renewal response", async (data) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(data)));
    await expect(renewRemoteAuthorization()).rejects.toThrow();
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).token).toBe(endpoint.token);
  });
  it("does not renew a current authorization", async () => {
    values[REMOTE_ENDPOINT_KEY] = { ...endpoint, renewAfter: "2099-01-01T00:00:00Z" };
    await renewRemoteAuthorization();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports an authorization rejection without discarding a retry candidate", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(renewRemoteAuthorization()).rejects.toThrow("rejected");
    const stored = values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint;
    expect(stored.renewalFailure).toBe("rejected");
    expect(stored.token).toBe(endpoint.token);
    expect(stored.pendingToken).toHaveLength(43);
  });
  it("does not start a fresh rotation for an expired authorization", async () => {
    values[REMOTE_ENDPOINT_KEY] = { ...endpoint, expiresAt: "2020-01-01T00:00:00Z" };
    await renewRemoteAuthorization();
    expect(fetch).not.toHaveBeenCalled();
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).pendingToken).toBeUndefined();
  });
  it("can confirm a lost rotation response after the previous local expiry", async () => {
    values[REMOTE_ENDPOINT_KEY] = {
      ...endpoint,
      expiresAt: "2020-01-01T00:00:00Z",
      pendingToken: "b".repeat(43),
    };
    await renewRemoteAuthorization();
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).token).toBe("b".repeat(43));
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).pendingToken).toBeUndefined();
  });
  it("serializes disconnect with rotation so an old response cannot restore credentials", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const renewing = renewRemoteAuthorization();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const disconnecting = updateRemoteConnection(null);
    resolve(response());
    await renewing;
    await disconnecting;
    expect(values[REMOTE_ENDPOINT_KEY]).toBeNull();
  });
});

it("only schedules renewal alarms while a remote connection is selected", async () => {
  values[REMOTE_ENDPOINT_KEY] = null;
  const watcher = watchRemoteAuthorization();
  await vi.waitFor(() => expect(chrome.alarms.clear).toHaveBeenCalled());
  expect(chrome.alarms.create).not.toHaveBeenCalled();
  values[REMOTE_ENDPOINT_KEY] = { ...endpoint, renewAfter: "2099-01-01T00:00:00Z" };
  changes({ revision: {} }, "local");
  await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledOnce());
  expect(fetch).not.toHaveBeenCalled();
  values[REMOTE_ENDPOINT_KEY] = null;
  changes({ revision: {} }, "local");
  await vi.waitFor(() => expect(chrome.alarms.clear).toHaveBeenCalledTimes(2));
  watcher.dispose();
});
