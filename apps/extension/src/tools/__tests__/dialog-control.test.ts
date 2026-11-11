import { afterEach, describe, expect, it, vi } from "vitest";
import { CooperationController } from "@/cooperation/controller";
import { SessionManager } from "@/session-manager/manager";
import type { PendingJavaScriptDialog } from "@/transport/types";
import { handleDialog } from "../dialog-control";
import type { CdpRunner } from "../shared";

const pending: PendingJavaScriptDialog = {
  id: "native-dialog",
  tab_id: 7,
  type: "prompt",
  message: "Name",
  default_prompt: "anonymous",
  sequence: 1,
  decision_deadline: 60000,
};

async function fixture() {
  let windowId = 42;
  const sessions = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => {
        const id = windowId++;
        return { windowId: id, initialTabIds: [id === 42 ? 7 : 8] };
      }),
      remove: vi.fn(),
      ensureActiveTab: vi.fn(),
    },
  });
  await sessions.start("owner");
  await sessions.start("other");
  const tabs = { get: vi.fn(async () => ({ id: 7, windowId: 42 })) };
  vi.stubGlobal("chrome", { tabs });
  const authority = new CooperationController({
    sessions,
    changed: () => {},
    readFrames: async () => {
      throw new Error("Renderer is blocked");
    },
    resumeFrames: async () => {},
  });
  authority.startSession("owner");
  const nativeDecision = vi.fn();
  const cdp = {
    send: vi.fn(() => {
      throw new Error("Renderer is blocked");
    }),
    pendingDialogs: vi.fn(() => [pending]),
    resolveDialog: vi.fn(async (_id, accept, text, guard) => {
      guard?.onDispatch?.();
      nativeDecision(accept, text);
      return { ...pending, handled: accept ? "accepted" : "dismissed" };
    }),
  } as unknown as CdpRunner;
  return { sessions, cdp, tabs, authority, nativeDecision };
}

afterEach(() => vi.unstubAllGlobals());

describe("native dialog control", () => {
  it("reads cached status without asking the blocked renderer or revealing another session", async () => {
    const { sessions, cdp, tabs } = await fixture();
    expect(
      await handleDialog(sessions, "tool.dialog_status", { session_id: "owner" }, cdp),
    ).toMatchObject({ dialogs: [pending] });
    expect(
      await handleDialog(sessions, "tool.dialog_status", { session_id: "other" }, cdp),
    ).toMatchObject({ dialogs: [] });
    expect(cdp.send).not.toHaveBeenCalled();
    expect(tabs.get).not.toHaveBeenCalled();
  });

  it.each([
    "Chosen by agent",
    "",
  ])("passes exact prompt input %j without page evaluation", async (text) => {
    const { sessions, cdp } = await fixture();
    expect(
      await handleDialog(
        sessions,
        "tool.dialog_accept",
        { session_id: "owner", dialog_id: pending.id, text },
        cdp,
      ),
    ).toMatchObject({ dialog: { handled: "accepted" } });
    expect(cdp.resolveDialog).toHaveBeenCalledWith(pending.id, true, text, {
      signal: undefined,
      onDispatch: undefined,
    });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("refuses another session's id and a tab moved out of the Agent Window", async () => {
    const { sessions, cdp, tabs } = await fixture();
    expect(
      await handleDialog(
        sessions,
        "tool.dialog_accept",
        { session_id: "other", dialog_id: pending.id },
        cdp,
      ),
    ).toMatchObject({ code: "not_found" });
    tabs.get.mockResolvedValue({ id: 7, windowId: 99 });
    expect(
      await handleDialog(
        sessions,
        "tool.dialog_accept",
        { session_id: "owner", dialog_id: pending.id },
        cdp,
      ),
    ).toMatchObject({ code: "permission_denied" });
    expect(cdp.resolveDialog).not.toHaveBeenCalled();
  });

  it("blocks acceptance on hold but leaves status and dismissal available", async () => {
    const { sessions, cdp, authority, nativeDecision } = await fixture();
    await authority.control(7, authority.view(7)!.revision, "hold");
    const options = { authority };
    const params = { session_id: "owner", dialog_id: pending.id };
    expect(await handleDialog(sessions, "tool.dialog_accept", params, cdp, options)).toMatchObject({
      code: "permission_denied",
      data: { reason: "control_authority_required", effect_state: "none" },
    });
    expect(nativeDecision).not.toHaveBeenCalled();
    expect(await handleDialog(sessions, "tool.dialog_status", params, cdp, options)).toMatchObject({
      dialogs: [pending],
    });
    expect(await handleDialog(sessions, "tool.dialog_dismiss", params, cdp, options)).toMatchObject(
      { dialog: { handled: "dismissed" } },
    );
    expect(nativeDecision).toHaveBeenCalledWith(false, undefined);
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("fences a hold arriving during asynchronous browser metadata lookup", async () => {
    const { sessions, cdp, authority, tabs, nativeDecision } = await fixture();
    tabs.get.mockImplementationOnce(async () => {
      await authority.control(7, authority.view(7)!.revision, "hold");
      return { id: 7, windowId: 42 };
    });
    expect(
      await handleDialog(
        sessions,
        "tool.dialog_accept",
        { session_id: "owner", dialog_id: pending.id },
        cdp,
        { authority },
      ),
    ).toMatchObject({
      code: "permission_denied",
      data: { reason: "control_authority_required", effect_state: "none" },
    });
    expect(nativeDecision).not.toHaveBeenCalled();
  });

  it("allows a decision without reading the renderer while retaining stopped errors", async () => {
    const { sessions, cdp, authority } = await fixture();
    const params = { session_id: "owner", dialog_id: pending.id, text: "chosen" };
    expect(
      await handleDialog(sessions, "tool.dialog_accept", params, cdp, { authority }),
    ).toMatchObject({ dialog: { handled: "accepted" } });
    authority.stopSession("owner");
    expect(
      await handleDialog(sessions, "tool.dialog_accept", params, cdp, { authority }),
    ).toMatchObject({ code: "user_aborted" });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("rejects text on a dismiss command and text beyond the bounded input", async () => {
    const { sessions, cdp } = await fixture();
    for (const [method, text] of [
      ["tool.dialog_dismiss", "ignored"],
      ["tool.dialog_accept", "x".repeat(4097)],
    ]) {
      expect(
        await handleDialog(
          sessions,
          method,
          { session_id: "owner", dialog_id: pending.id, text },
          cdp,
        ),
      ).toMatchObject({ code: "invalid_params" });
    }
    expect(cdp.resolveDialog).not.toHaveBeenCalled();
  });
});
