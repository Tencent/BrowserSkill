import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateRemoteEndpoint,
  renewRemoteAuthorization,
  updateRemoteConnection,
} from "../remote-authorization";
import { REMOTE_ENDPOINT_KEY, type RemoteEndpoint } from "../remote-endpoint";

let values: Record<string, unknown>;
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
  values = { [REMOTE_ENDPOINT_KEY]: { ...endpoint } };
  vi.stubGlobal("chrome", {
    storage: {
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
    await renewRemoteAuthorization();
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).token).toBe(pending.pendingToken);
    expect((values[REMOTE_ENDPOINT_KEY] as RemoteEndpoint).pendingToken).toBeUndefined();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).next_token).toBe(
      JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body)).next_token,
    );
  });
  it("does not renew a current authorization", async () => {
    values[REMOTE_ENDPOINT_KEY] = { ...endpoint, renewAfter: "2099-01-01T00:00:00Z" };
    await renewRemoteAuthorization();
    expect(fetch).not.toHaveBeenCalled();
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
