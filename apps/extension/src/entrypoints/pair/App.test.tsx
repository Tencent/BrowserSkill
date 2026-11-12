import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairTicketPreview } from "@/lib/local-pairing-bridge";
import { PairApp } from "./App";

const PREVIEW: PairTicketPreview = {
  port: 52844,
  hostPort: "127.0.0.1:52844",
  endpoint: "ws://127.0.0.1:52844",
  daemonFingerprint: "AbCdEf12",
  deviceFingerprint: "98XyZwVu",
  instanceId: "deadbeef",
  existingPairing: "unpaired",
  expiresAt: Date.now() + 300_000,
};

function dispatchClick(element: HTMLElement, trusted: boolean): void {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "isTrusted", { value: trusted, configurable: true });
  act(() => {
    element.dispatchEvent(event);
  });
}

describe("PairApp confirmation page", () => {
  const sendMessage = vi.fn();

  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    window.history.replaceState(null, "", "/pair.html?ticket=test-ticket-123");
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });
  });

  afterEach(async () => {
    cleanup();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    await i18n.changeLanguage("zh-CN");
  });

  it("ignores untrusted synthetic clicks and approves only on trusted user clicks", async () => {
    sendMessage.mockImplementation(async (msg: { action: string }) => {
      if (msg.action === "inspect_ticket") return { preview: PREVIEW };
      if (msg.action === "approve_ticket") return { ok: true, connectionEnabled: true };
      return { error: "unexpected" };
    });

    render(
      <I18nextProvider i18n={i18n}>
        <PairApp />
      </I18nextProvider>,
    );

    const approveButton = await screen.findByRole("button", { name: "Approve & Pair" });
    expect(screen.getByText("Pair BrowserSkill with Local CLI")).toBeTruthy();
    expect(screen.getByText("ws://127.0.0.1:52844")).toBeTruthy();
    expect(screen.getByText("AbCdEf12")).toBeTruthy();
    expect(screen.queryByText(/skip/i)).toBeNull();

    // Default synthetic click (isTrusted === false) must be ignored!
    fireEvent.click(approveButton);
    dispatchClick(approveButton, false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      kind: "bsk-local-pairing",
      action: "inspect_ticket",
      ticket: "test-ticket-123",
    });

    // Real trusted click (isTrusted === true) triggers approve_ticket and shows verified banner.
    dispatchClick(approveButton, true);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        kind: "bsk-local-pairing",
        action: "approve_ticket",
        ticket: "test-ticket-123",
      }),
    );
    expect(await screen.findByText("✓ Connected · Verified")).toBeTruthy();
  });

  it("shows bsk setup --re-pair guidance when the browser is already paired", async () => {
    await i18n.changeLanguage("zh-CN");
    sendMessage.mockImplementation(async (msg: { action: string }) => {
      if (msg.action === "inspect_ticket") {
        return { preview: { ...PREVIEW, existingPairing: "same_daemon" } };
      }
      if (msg.action === "approve_ticket") {
        return { error: "already_paired", browserId: "deadbeef" };
      }
      return { error: "unexpected" };
    });

    render(
      <I18nextProvider i18n={i18n}>
        <PairApp />
      </I18nextProvider>,
    );

    const approveButton = await screen.findByRole("button", { name: "批准并配对" });
    dispatchClick(approveButton, true);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("bsk setup --re-pair");
    expect(alert.textContent).toContain("deadbeef");
  });

  it("renders clear error state when ticket is missing or expired", async () => {
    window.history.replaceState(null, "", "/pair.html");
    render(
      <I18nextProvider i18n={i18n}>
        <PairApp />
      </I18nextProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("bsk setup");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
