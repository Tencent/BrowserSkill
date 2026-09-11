import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRemoteEndpoint, readRemoteEndpoint, remoteSocket } from "../remote-endpoint";

const token = "a".repeat(43);
afterEach(() => vi.unstubAllGlobals());
describe("remote pairing boundary", () => {
  it("strips the pairing credential from the network URL", () => {
    expect(parseRemoteEndpoint(`wss://gateway.example/bsk#${token}`)).toEqual({
      url: "wss://gateway.example/bsk",
      token,
    });
  });
  it.each([
    `ws://example.com/bsk#${token}`,
    `https://example.com/#${token}`,
    `wss://user:pass@example.com/#${token}`,
    `wss://example.com/?token=secret#${token}`,
    "wss://example.com/#short",
  ])("rejects unsafe pairing %s", (input) => {
    expect(() => parseRemoteEndpoint(input)).toThrow();
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])("permits local development on %s", (host) => {
    expect(parseRemoteEndpoint(`ws://${host}:8080/bsk#${token}`).url).toBe(`ws://${host}:8080/bsk`);
  });
  it("does not turn a corrupt remote preference into a local connection", () => {
    expect(readRemoteEndpoint(null)).toBeNull();
    expect(() => readRemoteEndpoint({ url: "ws://public.example", token })).toThrow();
  });
  it("sends credentials only to the paired endpoint via the subprotocol", () => {
    const calls: unknown[][] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(...args: unknown[]) {
          calls.push(args);
        }
      },
    );
    const remote = parseRemoteEndpoint(`wss://gateway.example/bsk#${token}`);
    remoteSocket(remote.url, remote);
    remoteSocket("ws://localhost:52800", null);
    expect(calls).toEqual([[remote.url, [`bsk-auth.${token}`]], ["ws://localhost:52800"]]);
    expect(() => remoteSocket("wss://other.example/bsk", remote)).toThrow();
    expect(calls).toHaveLength(2);
  });
});
