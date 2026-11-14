import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DAEMON_PORT,
  normalizeDaemonPort,
  parseDaemonPortInput,
  resolveDaemonWsUrl,
} from "../daemon-endpoint";
import { REMOTE_AUTH_SUBPROTOCOL_PREFIX } from "../generated/methods";
import { parseRemoteEndpoint, readRemoteEndpoint, remoteSocket } from "../remote-endpoint";

describe("daemon-endpoint", () => {
  it("resolveDaemonWsUrl(DEFAULT) matches the build-time constant", () => {
    expect(resolveDaemonWsUrl(DEFAULT_DAEMON_PORT)).toBe(__BSK_DAEMON_WS_URL__);
  });

  it("resolveDaemonWsUrl replaces only the port", () => {
    expect(resolveDaemonWsUrl(53200)).toBe("ws://127.0.0.1:53200");
  });

  it("normalizeDaemonPort falls back to default for invalid values", () => {
    expect(normalizeDaemonPort(undefined)).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort(0)).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort(65536)).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort("abc")).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort(1.5)).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort("53200abc")).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort("1.5")).toBe(DEFAULT_DAEMON_PORT);
    expect(normalizeDaemonPort("1e3")).toBe(DEFAULT_DAEMON_PORT);
  });

  it("normalizeDaemonPort accepts valid numbers and numeric strings", () => {
    expect(normalizeDaemonPort(53200)).toBe(53200);
    expect(normalizeDaemonPort("53200")).toBe(53200);
  });

  it("parseDaemonPortInput treats empty as default and rejects invalid", () => {
    expect(parseDaemonPortInput("")).toBe(DEFAULT_DAEMON_PORT);
    expect(parseDaemonPortInput("   ")).toBe(DEFAULT_DAEMON_PORT);
    expect(parseDaemonPortInput("abc")).toBeNull();
    expect(parseDaemonPortInput("0")).toBeNull();
    expect(parseDaemonPortInput("65536")).toBeNull();
  });

  it("parseDaemonPortInput accepts valid ports", () => {
    expect(parseDaemonPortInput("53200")).toBe(53200);
    expect(parseDaemonPortInput(` ${DEFAULT_DAEMON_PORT} `)).toBe(DEFAULT_DAEMON_PORT);
  });
});

describe("remote pairing boundary", () => {
  const token = "a".repeat(43);

  afterEach(() => vi.unstubAllGlobals());

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
    const localUrl = `ws://localhost:${DEFAULT_DAEMON_PORT}`;
    const remote = parseRemoteEndpoint(`wss://gateway.example/bsk#${token}`);
    remoteSocket(remote.url, remote);
    remoteSocket(localUrl, null);
    expect(calls).toEqual([
      [remote.url, [`${REMOTE_AUTH_SUBPROTOCOL_PREFIX}${token}`]],
      [localUrl],
    ]);
    expect(() => remoteSocket("wss://other.example/bsk", remote)).toThrow();
    expect(calls).toHaveLength(2);
  });
});
