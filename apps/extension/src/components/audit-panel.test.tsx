import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditRequest, openAuditPage } from "@/lib/audit";
import { AuditPanel } from "./audit-panel";

vi.mock("@/lib/audit", () => ({
  AUDIT_ENABLED_KEY: "bsk_audit_enabled",
  auditRequest: vi.fn(),
  openAuditPage: vi.fn(),
}));
const request = auditRequest as ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("chrome", {
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("audit popup", () => {
  it("shows only the toggle when disabled and does not query history", async () => {
    request.mockResolvedValue({ enabled: false });
    render(<AuditPanel />);
    await waitFor(() => expect(screen.queryByText("正在加载…")).toBeNull());
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("查看全部")).toBeNull();
    expect(request.mock.calls.map((call) => call[0])).toEqual(["state"]);
  });
  it("shows recent tasks and opens the selected task in an extension page", async () => {
    request.mockImplementation(async (action) =>
      action === "state"
        ? { enabled: true }
        : {
            runs: [
              {
                id: "run-a",
                name: "检查天气",
                status: "ended",
                operations: 3,
                errors: 0,
                partial: false,
              },
            ],
            total: 1,
          },
    );
    render(<AuditPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /检查天气/ }));
    expect(openAuditPage).toHaveBeenCalledWith("run-a");
    expect(request).toHaveBeenCalledWith("list", { limit: 5 });
  });
  it("distinguishes disconnection from empty history", async () => {
    request.mockImplementation(async (action) => {
      if (action === "state") return { enabled: true };
      throw new Error("disconnected");
    });
    render(<AuditPanel />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/还没有任务记录/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
