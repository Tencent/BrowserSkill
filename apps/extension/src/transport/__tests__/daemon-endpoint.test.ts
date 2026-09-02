import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_PORT,
  normalizeDaemonPort,
  parseDaemonPortInput,
  resolveDaemonWsUrl,
} from "../daemon-endpoint";

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
    expect(parseDaemonPortInput(" 52800 ")).toBe(52800);
  });
});
