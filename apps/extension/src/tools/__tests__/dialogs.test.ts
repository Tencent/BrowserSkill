import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { PendingJavaScriptDialog } from "@/transport/types";
import { handleDialog, pendingDialogError } from "../dialogs";

async function fixture(remote = false) {
  const manager = new SessionManager({
    remote: () => remote,
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  await manager.start("test");
  const pending: PendingJavaScriptDialog = {
    id: "dialog-1",
    tab_id: 7,
    type: "prompt",
    message: "Name?",
    sequence: 1,
  };
  const cdp = {
    send: vi.fn(),
    pendingDialog: vi.fn(() => pending),
    dialogExecutionPending: vi.fn(() => false),
    handleDialog: vi.fn(async () => ({
      tab_id: 7,
      type: "prompt" as const,
      message: "Name?",
      sequence: 1,
      handled: "accepted" as const,
    })),
  };
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: "https://example.test",
  } as chrome.tabs.Tab;
  const tabs = { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) };
  return { manager, cdp, tab, tabs };
}

describe("dialog tool scope", () => {
  it("reads status from cached state without issuing renderer commands", async () => {
    const { manager, cdp, tabs } = await fixture();
    expect(
      await handleDialog(manager, { session_id: "test", action: "status" }, cdp, tabs),
    ).toMatchObject({ pending: { id: "dialog-1" } });
    expect(cdp.send).not.toHaveBeenCalled();
    expect(cdp.handleDialog).not.toHaveBeenCalled();
  });
  it.each([
    "status",
    "accept",
    "dismiss",
  ] as const)("rejects %s outside the session window", async (action) => {
    const { manager, cdp, tabs, tab } = await fixture();
    tab.windowId = 200;
    expect(
      await handleDialog(manager, { session_id: "test", tab_id: 7, action }, cdp, tabs),
    ).toMatchObject({ code: "permission_denied" });
    expect(
      await pendingDialogError(manager, { session_id: "test", tab_id: 7 }, cdp, tabs),
    ).toBeNull();
    expect(cdp.pendingDialog).not.toHaveBeenCalled();
    expect(cdp.handleDialog).not.toHaveBeenCalled();
  });
  it("rejects unclaimed remote tabs even inside the Agent Window", async () => {
    const { manager, cdp, tabs, tab } = await fixture(true);
    tab.id = 8;
    expect(
      await handleDialog(manager, { session_id: "test", tab_id: 8, action: "accept" }, cdp, tabs),
    ).toMatchObject({ code: "permission_denied" });
    expect(cdp.handleDialog).not.toHaveBeenCalled();
  });
  it("rejects stale IDs, invalid text and cancellation before mutation", async () => {
    const { manager, cdp, tabs } = await fixture();
    expect(
      await handleDialog(
        manager,
        { session_id: "test", action: "accept", dialog_id: "old" },
        cdp,
        tabs,
      ),
    ).toMatchObject({ code: "not_found" });
    expect(
      await handleDialog(
        manager,
        { session_id: "test", action: "dismiss", prompt_text: "bad" },
        cdp,
        tabs,
      ),
    ).toMatchObject({ code: "invalid_params" });
    const controller = new AbortController();
    controller.abort();
    expect(
      await handleDialog(
        manager,
        { session_id: "test", action: "accept" },
        cdp,
        tabs,
        controller.signal,
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(cdp.handleDialog).not.toHaveBeenCalled();
    await handleDialog(
      manager,
      { session_id: "test", action: "accept", prompt_text: "" },
      cdp,
      tabs,
    );
    expect(cdp.handleDialog).toHaveBeenCalledWith(7, "dialog-1", true, "");
  });
});
