import { afterEach, describe, expect, it, vi } from "vitest";
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
  const cdp = {
    send: vi.fn(() => {
      throw new Error("Renderer is blocked");
    }),
    pendingDialogs: vi.fn(() => [pending]),
    resolveDialog: vi.fn(async () => ({ ...pending, handled: "accepted" })),
  } as unknown as CdpRunner;
  return { sessions, cdp, tabs };
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
    expect(cdp.resolveDialog).toHaveBeenCalledWith(pending.id, true, text, undefined);
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
