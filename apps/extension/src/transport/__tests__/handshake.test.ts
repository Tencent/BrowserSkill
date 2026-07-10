import { describe, expect, it } from "vitest";
import {
  detectBrowserMeta,
  EXTENSION_VERSION,
  MIN_COMPATIBLE_PEER,
  MIN_COMPATIBLE_PROTOCOL,
  PROTOCOL_VERSION,
  performHandshake,
} from "../handshake";
import type { ConnectionStateHandler, FrameHandler, Transport } from "../transport";
import type { ConnectionState, HandshakeResult, ProtocolFrame } from "../types";

function fakeTransport(reply: (req: ProtocolFrame) => ProtocolFrame | null): Transport {
  const handlers = new Set<FrameHandler>();
  const t: Transport = {
    state: "connected" as ConnectionState,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    send: (msg) => {
      const response = reply(msg);
      if (response) {
        for (const h of handlers) h(response);
      }
    },
    onMessage: (h: FrameHandler) => {
      handlers.add(h);
      return {
        dispose: () => {
          handlers.delete(h);
        },
      };
    },
    onConnectionStateChange: (_h: ConnectionStateHandler) => ({
      dispose: () => {},
    }),
  };
  return t;
}

function deferredFakeTransport(): { transport: Transport; emit: (frame: ProtocolFrame) => void } {
  const handlers = new Set<FrameHandler>();
  const transport: Transport = {
    state: "connected" as ConnectionState,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    send: () => {},
    onMessage: (h: FrameHandler) => {
      handlers.add(h);
      return {
        dispose: () => {
          handlers.delete(h);
        },
      };
    },
    onConnectionStateChange: (_h: ConnectionStateHandler) => ({
      dispose: () => {},
    }),
  };
  return {
    transport,
    emit: (frame) => {
      for (const h of handlers) h(frame);
    },
  };
}

describe("performHandshake", () => {
  it("sends system.handshake with identity and both compat fields", async () => {
    let sentFrame: ProtocolFrame | null = null;
    const transport = fakeTransport((req) => {
      sentFrame = req;
      return {
        id: (req as { id: string }).id,
        result: {
          server: "browser-skill-daemon",
          version: "0.1.0",
          protocol_version: "1.0",
          min_compatible_peer: "0.0.0",
          min_compatible_protocol: "1.0",
        },
      };
    });
    const outcome = await performHandshake(transport, {
      instanceId: "abcdef01-2345-4678-89ab-cdef01234567",
      browser: { name: "chrome", version: "131.0" },
      label: "Personal Chrome",
      rpcId: "hs-test",
    });

    expect(sentFrame).toEqual({
      id: "hs-test",
      method: "system.handshake",
      params: {
        client: "browser-skill-extension",
        version: EXTENSION_VERSION,
        protocol_version: PROTOCOL_VERSION,
        instance_id: "abcdef01-2345-4678-89ab-cdef01234567",
        browser: { name: "chrome", version: "131.0" },
        label: "Personal Chrome",
        min_compatible_peer: MIN_COMPATIBLE_PEER,
        min_compatible_protocol: MIN_COMPATIBLE_PROTOCOL,
      },
    });
    expect(outcome.result.min_compatible_peer).toBe("0.0.0");
    expect(outcome.result.min_compatible_protocol).toBe("1.0");
  });

  it("accepts legacy daemon reply with only min_compatible_peer", async () => {
    const transport = fakeTransport((req) => ({
      id: (req as { id: string }).id,
      result: {
        server: "browser-skill-daemon",
        version: "0.1.0",
        protocol_version: "1.0",
        min_compatible_peer: "0.1.0",
      },
    }));
    const outcome = await performHandshake(transport, {
      instanceId: "x",
      browser: { name: "chrome", version: "131" },
      label: "",
      rpcId: "hs-legacy",
    });
    expect(outcome.result.protocol_version).toBe("1.0");
    expect(outcome.result.min_compatible_protocol).toBeUndefined();
  });

  it("accepts daemon reply without legacy min_compatible_peer", async () => {
    const response = {
      server: "browser-skill-daemon",
      version: "0.1.0",
      protocol_version: "1.0",
      min_compatible_protocol: "1.0",
    } satisfies HandshakeResult;
    const transport = fakeTransport((req) => ({
      id: (req as { id: string }).id,
      result: response,
    }));

    const outcome = await performHandshake(transport, {
      instanceId: "x",
      browser: { name: "chrome", version: "131" },
      label: "",
      rpcId: "hs-no-legacy-peer",
    });

    expect(outcome.result.min_compatible_peer).toBeUndefined();
    expect(outcome.result.min_compatible_protocol).toBe("1.0");
  });

  it("rejects when the daemon responds with an error", async () => {
    const transport = fakeTransport((req) => ({
      id: (req as { id: string }).id,
      error: { code: "version_too_old", message: "extension is too old" },
    }));
    await expect(
      performHandshake(transport, {
        instanceId: "x",
        browser: { name: "chrome", version: "131" },
        label: "",
        rpcId: "hs-err",
      }),
    ).rejects.toThrow(/version_too_old/);
  });

  it("ignores unrelated frames and resolves on the matching response id", async () => {
    const { transport, emit } = deferredFakeTransport();
    const pending = performHandshake(transport, {
      instanceId: "x",
      browser: { name: "chrome", version: "131" },
      label: "",
      rpcId: "hs-target",
    });

    emit({ event: "browser.event", payload: { ignored: true } });
    emit({
      id: "hs-other",
      result: {
        server: "browser-skill-daemon",
        version: "0.1.0",
        protocol_version: "1.0",
        min_compatible_peer: "0.0.0",
        min_compatible_protocol: "1.0",
      },
    });
    emit({
      id: "hs-target",
      result: {
        server: "browser-skill-daemon",
        version: "0.1.0",
        protocol_version: "1.0",
        min_compatible_peer: "0.0.0",
        min_compatible_protocol: "1.0",
      },
    });

    await expect(pending).resolves.toMatchObject({
      result: { server: "browser-skill-daemon", protocol_version: "1.0" },
    });
  });

  it("stops waiting immediately when the connection generation is aborted", async () => {
    const { transport } = deferredFakeTransport();
    const controller = new AbortController();
    const pending = performHandshake(
      transport,
      {
        instanceId: "x",
        browser: { name: "chrome", version: "131" },
        label: "",
        rpcId: "hs-abort",
      },
      { signal: controller.signal, timeoutMs: 60_000 },
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("detectBrowserMeta", () => {
  it("recognises Chrome", () => {
    const meta = detectBrowserMeta(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36",
    );
    expect(meta).toEqual({ name: "chrome", version: "131.0.6778.86" });
  });

  it("recognises Edge before the Chrome fallback", () => {
    const meta = detectBrowserMeta(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
    );
    expect(meta).toEqual({ name: "edge", version: "131.0.2903.70" });
  });

  it("falls back to chromium with unknown version for unknown UAs", () => {
    expect(detectBrowserMeta("Unknown Browser/1.0")).toEqual({
      name: "chromium",
      version: "unknown",
    });
  });
});
