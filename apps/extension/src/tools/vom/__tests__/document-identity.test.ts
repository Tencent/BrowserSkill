import { describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "../../shared";
import { verifyDocumentIdentity, verifyVisualTargetIdentity } from "../document-identity";
import type { VisualCandidate } from "../visual-discovery";

const candidate: VisualCandidate = {
  document: {
    attachmentId: "attached",
    target: { tabId: 4, sessionId: "child-session" },
    frameId: "child-frame",
    documentElementBackendNodeId: 10,
  },
  backendNodeId: 20,
  parentBackendNodeId: 10,
  region: {
    status: "available",
    borderBox: { x: 0, y: 0, width: 10, height: 10 },
    crop: { x: 0, y: 0, width: 10, height: 10 },
  },
};

function fixture(
  options: {
    connected?: boolean;
    sameDocument?: boolean;
    root?: number;
    missing?: boolean;
    fail?: string;
    abortAt?: string;
    detachAt?: string;
  } = {},
) {
  const controller = new AbortController();
  let attachment = "attached";
  const send = vi.fn(
    async (_tab: number, _session: string, method: string, params: Record<string, unknown>) => {
      if (options.abortAt === method) controller.abort();
      if (options.detachAt === method) attachment = "new-attachment";
      if (options.fail === method) throw new Error("CDP failed");
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "DOM.resolveNode")
        return options.missing ? {} : { object: { objectId: "anchor" } };
      if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
        let root: unknown = {};
        if (method === "Runtime.callFunctionOn") {
          const document = { documentElement: {} };
          // Exercise the actual predicate, including connection and owner checks.
          root = new Function("document", `return (${params.functionDeclaration}).call(this)`).call(
            {
              isConnected: options.connected ?? true,
              ownerDocument: options.sameDocument === false ? {} : document,
            },
            document,
          );
        }
        return {
          result: {
            deepSerializedValue:
              root === null
                ? { type: "null" }
                : { type: "node", value: { backendNodeId: options.root ?? 10 } },
          },
        };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected ${method}`);
    },
  );
  const cdp = {
    send: vi.fn(),
    sendToTarget: (
      target: { tabId: number; sessionId?: string },
      method: string,
      params: Record<string, unknown>,
    ) => send(target.tabId, target.sessionId!, method, params),
    getAttachmentId: () => attachment,
  } as unknown as CdpRunner;
  return { cdp, send, controller };
}

describe("visual target identity", () => {
  it("uses the exact frame and target with bounded local reads and releases objects", async () => {
    const { cdp, send } = fixture();
    expect(await verifyVisualTargetIdentity(cdp, candidate)).toBe("current");
    expect(send.mock.calls.map((c) => c[2])).toEqual([
      "Page.createIsolatedWorld",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.releaseObjectGroup",
    ]);
    expect(
      send.mock.calls.every(([tab, session]) => tab === 4 && session === "child-session"),
    ).toBe(true);
    expect(send.mock.calls[0][3]).toMatchObject({ frameId: "child-frame" });
    expect(send.mock.calls[1][3]).toMatchObject({ backendNodeId: 20, executionContextId: 7 });
    expect(send.mock.calls[2][3]).toMatchObject({ objectId: "anchor" });
    expect(send.mock.calls[3][3].objectGroup).toBe(send.mock.calls[1][3].objectGroup);
  });

  it.each([
    { connected: false },
    { sameDocument: false },
    { root: 11 },
  ])("rejects detached/adopted/replaced DOM: %j", async (options) => {
    const { cdp } = fixture(options);
    expect(await verifyVisualTargetIdentity(cdp, candidate)).toBe("changed");
  });

  it("does not add anchor reads to existing capture identity verification", async () => {
    const { cdp, send } = fixture();
    expect(await verifyDocumentIdentity(cdp, candidate.document)).toBe("current");
    expect(send.mock.calls.map((c) => c[2])).toEqual([
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
      "Runtime.releaseObjectGroup",
    ]);
  });

  it.each([
    "Page.createIsolatedWorld",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
  ])("fails closed and cleans up when %s fails", async (fail) => {
    const { cdp, send } = fixture({ fail });
    expect(await verifyVisualTargetIdentity(cdp, candidate)).toBe("unavailable");
    expect(send.mock.calls.at(-1)?.[2]).toBe("Runtime.releaseObjectGroup");
  });

  it("rejects attachment changes before and during verification", async () => {
    const first = fixture();
    expect(
      await verifyVisualTargetIdentity({ ...first.cdp, getAttachmentId: () => "other" }, candidate),
    ).toBe("changed");
    expect(first.send).not.toHaveBeenCalled();
    const second = fixture({ detachAt: "Runtime.callFunctionOn" });
    expect(await verifyVisualTargetIdentity(second.cdp, candidate)).toBe("changed");
    const missing = fixture({ missing: true });
    expect(await verifyVisualTargetIdentity(missing.cdp, candidate)).toBe("unavailable");
  });

  it.each([
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
  ])("propagates cancellation at %s after releasing the object group", async (abortAt) => {
    const { cdp, send, controller } = fixture({ abortAt });
    await expect(
      verifyVisualTargetIdentity(cdp, candidate, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(send.mock.calls.at(-1)?.[2]).toBe("Runtime.releaseObjectGroup");
  });
});
