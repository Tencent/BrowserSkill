import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuditEvent, type AuditRun, auditRequest } from "@/lib/audit";
import { AuditApp } from "./App";

vi.mock("@/lib/audit", () => ({ auditRequest: vi.fn() }));
const request = vi.mocked(auditRequest);
const run: AuditRun = {
  id: "task-a",
  browser_id: "browser-a",
  session_id: "abcd",
  name: "查询配送",
  site: "example.com",
  status: "ended",
  partial: false,
  operations: 1,
  errors: 0,
  started_at: 1,
  recorded_at: 1,
  updated_at: 3,
};
beforeEach(() => {
  window.history.replaceState(null, "", "/audit.html?id=task-a");
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("audit history page", () => {
  it("exports every page up to a fixed boundary while the task keeps growing", async () => {
    const events: AuditEvent[] = Array.from({ length: 503 }, (_, i) => ({
      at: i,
      kind: "started",
      data: {},
    }));
    let growing = false;
    request.mockImplementation(async (_action, params) => ({
      run: { ...run, status: "running" },
      events: events.slice(
        Number(params?.offset || 0),
        Number(params?.offset || 0) + Number(params?.limit || 500),
      ),
      total: growing ? 999 : 503,
    }));
    const create = vi.fn(() => "blob:export");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AuditApp />);
    const button = await screen.findByRole("button", { name: "导出记录" });
    expect(screen.queryByRole("button", { name: "删除记录" })).toBeNull();
    request.mockImplementation(async (_action, params) => {
      const total = growing ? 999 : 503;
      growing = true;
      return {
        run,
        events: events.slice(
          Number(params?.offset || 0),
          Number(params?.offset || 0) + Number(params?.limit || 500),
        ),
        total,
      };
    });
    fireEvent.click(button);
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("get", { id: "task-a", offset: 500, limit: 3 });
    expect(request.mock.calls.filter(([, params]) => Number(params?.offset) >= 503)).toHaveLength(
      0,
    );
  });

  it("requires confirmation to delete an ended task and returns to the updated list", async () => {
    request.mockImplementation(async (action) => {
      if (action === "get") return { run, events: [], total: 0 };
      if (action === "delete") return { deleted: true };
      return { runs: [], total: 0, directory: "/audit", enabled: true, retention_days: 30 };
    });
    render(<AuditApp />);
    fireEvent.click(await screen.findByRole("button", { name: "删除记录" }));
    expect(request.mock.calls.some(([action]) => action === "delete")).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("无法恢复");
    fireEvent.click(screen.getAllByRole("button", { name: "删除记录" })[1]);
    await screen.findByRole("heading", { name: "全部任务" });
    expect(request).toHaveBeenCalledWith("delete", { id: "task-a" });
    expect(window.location.search).toBe("");
  });
});
