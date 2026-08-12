import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleSessionStart } from "../session";
import { handleWindowResize, type WindowResizeApi } from "../window";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  const create = vi.fn(async () => {
    const id = ids[i++];
    if (id === undefined) throw new Error("ran out of fake ids");
    return id;
  });
  const remove = vi.fn(async () => {});
  const ensureActiveTab = vi.fn(async () => {});
  return { create, remove, ensureActiveTab };
}

async function makeManager(): Promise<SessionManager> {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  await sm.start("aa11");
  return sm;
}

function fakeUpdateApi(opts?: { throw?: boolean }) {
  const calls: Array<{ windowId: number; width: number; height: number }> = [];
  const api: WindowResizeApi = {
    update: vi.fn(async (windowId: number, updateInfo: { width: number; height: number }) => {
      if (opts?.throw) throw new Error("simulated chrome failure");
      calls.push({ windowId, width: updateInfo.width, height: updateInfo.height });
      return undefined;
    }),
  };
  return { api, calls };
}

describe("handleWindowResize", () => {
  it("resizes the session's Agent Window", async () => {
    const sm = await makeManager();
    const { api, calls } = fakeUpdateApi();
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      api,
    );
    expect(result).toEqual({ window_id: 100, width: 1280, height: 800 });
    expect(calls).toEqual([{ windowId: 100, width: 1280, height: 800 }]);
  });

  it("rejects an unknown session", async () => {
    const sm = await makeManager();
    const { api } = fakeUpdateApi();
    const result = await handleWindowResize(
      sm,
      { session_id: "zz99", width: 1280, height: 800 },
      api,
    );
    expect(result).toMatchObject({ code: "not_found" });
  });

  it("rejects missing session_id", async () => {
    const sm = await makeManager();
    const { api } = fakeUpdateApi();
    const result = await handleWindowResize(sm, { session_id: "", width: 1280, height: 800 }, api);
    expect(result).toMatchObject({ code: "invalid_params" });
  });

  it("rejects missing dimensions", async () => {
    const sm = await makeManager();
    const { api, calls } = fakeUpdateApi();
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11" } as unknown as { session_id: string; width: number; height: number },
      api,
    );
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(calls).toEqual([]);
  });

  it.each([
    [99, 800],
    [100, 7681],
    [1280.5, 800],
    [Number.NaN, 800],
  ])("rejects out-of-range or non-integer dimensions (%s, %s)", async (width, height) => {
    const sm = await makeManager();
    const { api, calls } = fakeUpdateApi();
    const result = await handleWindowResize(sm, { session_id: "aa11", width, height }, api);
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(calls).toEqual([]);
  });

  it("maps chrome API failures to protocol_error", async () => {
    const sm = await makeManager();
    const { api } = fakeUpdateApi({ throw: true });
    const result = await handleWindowResize(
      sm,
      { session_id: "aa11", width: 1280, height: 800 },
      api,
    );
    expect(result).toMatchObject({ code: "protocol_error", message: "simulated chrome failure" });
  });
});

describe("handleSessionStart window size", () => {
  it("passes width/height through to Agent Window creation", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const result = await handleSessionStart(sm, { session_id: "aa11", width: 1280, height: 800 });
    expect(result).toEqual({ agent_window_id: 100 });
    expect(aw.create).toHaveBeenCalledWith("about:blank", { size: { width: 1280, height: 800 } });
  });

  it("creates the window without size when width/height are omitted", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const result = await handleSessionStart(sm, { session_id: "aa11" });
    expect(result).toEqual({ agent_window_id: 100 });
    expect(aw.create).toHaveBeenCalledWith("about:blank", {});
  });

  it("forwards focused: false to the Agent Window", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const result = await handleSessionStart(sm, { session_id: "aa11", focused: false });
    expect(result).toEqual({ agent_window_id: 100 });
    expect(aw.create).toHaveBeenCalledWith("about:blank", { focused: false });
  });

  it("rejects a lone width without height", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const result = await handleSessionStart(sm, { session_id: "aa11", width: 1280 });
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(sm.has("aa11")).toBe(false);
  });

  it.each([
    [99, 800],
    [1280, 7681],
    [1280.5, 800],
  ])("rejects invalid dimensions (%s, %s)", async (width, height) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const result = await handleSessionStart(sm, { session_id: "aa11", width, height });
    expect(result).toMatchObject({ code: "invalid_params" });
    expect(sm.has("aa11")).toBe(false);
  });
});
