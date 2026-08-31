import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { lookupSnapshotRef, resolveSnapshotRef } from "../snapshot-ref";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return id;
    },
    remove: async () => {},
    ensureActiveTab: async () => {},
  };
}

describe("lookupSnapshotRef", () => {
  it("resolves @e3 and e3 to the same backendNodeId", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });

    expect(lookupSnapshotRef(ctx, "@e3", 4)).toEqual({
      backendNodeId: 1234,
      refKey: "e3",
      kind: "dom",
      capabilities: ["interact", "screenshot"],
    });
    expect(lookupSnapshotRef(ctx, "e3", 4)).toEqual({
      backendNodeId: 1234,
      refKey: "e3",
      kind: "dom",
      capabilities: ["interact", "screenshot"],
    });
  });

  it("returns null for unknown ref", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    expect(lookupSnapshotRef(ctx, "@e99", 4)).toBeNull();
  });

  it("returns null when ref belongs to another tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    expect(lookupSnapshotRef(ctx, "@e3", 5)).toBeNull();
  });
});

describe("resolveSnapshotRef", () => {
  it("preserves the frame and child session needed to route iframe refs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, {
      tabId: 4,
      frameId: "child-frame",
      cdpSessionId: "child-session",
      kind: "dom",
      capabilities: ["interact", "screenshot"],
    });

    const expected = {
      backendNodeId: 1234,
      refKey: "e3",
      frameId: "child-frame",
      cdpSessionId: "child-session",
      kind: "dom" as const,
      capabilities: ["interact", "screenshot"] as const,
    };
    expect(lookupSnapshotRef(ctx, "@e3", 4)).toEqual(expected);
    expect(resolveSnapshotRef(ctx, "@e3", 4)).toEqual(expected);
  });

  it("returns not_found for unknown ref", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const res = resolveSnapshotRef(ctx, "@e99", 4);
    expect(res).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found" },
      message: "ref @e99 unknown for tab 4 in session aa11",
    });
  });

  it("returns not_found when ref belongs to another tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e7", 4242, { tabId: 4 });
    const res = resolveSnapshotRef(ctx, "@e7", 5);
    expect(res).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found" },
      message: "ref @e7 unknown for tab 5 in session aa11",
    });
  });

  it("preserves original ref string in error message for bare eN form", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const res = resolveSnapshotRef(ctx, "e99", 4);
    expect(res).toMatchObject({
      code: "not_found",
      message: "ref e99 unknown for tab 4 in session aa11",
    });
  });

  it("returns backendNodeId and refKey on success", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    expect(resolveSnapshotRef(ctx, "@e3", 4)).toEqual({
      backendNodeId: 1234,
      refKey: "e3",
      kind: "dom",
      capabilities: ["interact", "screenshot"],
    });
  });

  it("rejects an operation outside the ref's declared capabilities", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, {
      tabId: 4,
      kind: "surface",
      capabilities: ["screenshot"],
    });

    expect(resolveSnapshotRef(ctx, "@e3", 4, "interact")).toMatchObject({
      code: "permission_denied",
      message: "ref @e3 does not support interact",
      data: {
        reason: "ref_capability_denied",
        required_capability: "interact",
        kind: "surface",
      },
    });
  });
});
