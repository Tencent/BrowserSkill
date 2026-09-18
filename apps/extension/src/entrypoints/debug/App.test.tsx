import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  debugHistory,
  debugRequest,
  debugTasks,
  deleteRecording,
  recordingRequest,
} from "@/debug/client";
import type { DebugOperation, DebugRequest, DebugRun } from "@/debug/types";
import { DebugApp } from "./App";

vi.mock("@/debug/client", () => ({
  debugHistory: vi.fn(),
  debugRequest: vi.fn(),
  debugTasks: vi.fn(),
  deleteRecording: vi.fn(),
  recordingRequest: vi.fn(),
}));
const run: DebugRun = {
  id: "d1",
  session_id: "s1",
  tab_id: 7,
  name: "Save fails",
  url: "http://localhost:3000",
  started_at: 1000,
  state: "capturing",
  requests: 1,
  operations: 2,
  errors: 1,
  dropped_requests: 0,
  dropped_console: 0,
  dropped_operations: 0,
  coverage: [],
  next_since: 2,
};
const request: DebugRequest = {
  id: "d1:n1",
  run_id: "d1",
  sequence: 2,
  started_at: 1010,
  method: "POST",
  url: "http://localhost:3000/api/save",
  state: "complete",
  status: 200,
  request_body: { state: "available" },
  response_body: { state: "available" },
};
const operation: DebugOperation = {
  id: "d1:a1",
  run_id: "d1",
  sequence: 1,
  method: "tool.click",
  target: "#save",
  started_at: 1000,
  state: "completed",
  request_ids: [request.id],
  console_ids: [],
  truncated: false,
  before: { at: 1000, state: "available", text: "Ready" },
  after: { at: 1100, state: "available", text: "Save failed" },
};
const second: DebugOperation = {
  ...operation,
  id: "d1:a2",
  sequence: 2,
  started_at: 2000,
  after: { at: 2100, state: "available", text: "Saved" },
};

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  vi.mocked(debugTasks).mockResolvedValue({
    tasks: [{ session_id: "s1", created_at: 1000, tab_id: 7, title: "App", run }],
  });
  history.replaceState(null, "", "/debug.html?session=s1&run=d1");
  vi.mocked(debugHistory).mockResolvedValue({ runs: [run] });
  vi.mocked(debugRequest).mockResolvedValue({
    session_id: "s1",
    run: { ...run, state: "stopped" },
  });
  vi.mocked(recordingRequest).mockImplementation(async (params) => {
    const base = { session_id: "s1" };
    if (params.action === "status") return { ...base, runs: [run] };
    if (params.action === "requests") return { ...base, requests: [request], next_since: 2 };
    if (params.action === "operations") return { ...base, operations: [operation, second] };
    if (params.action === "operation")
      return {
        ...base,
        operation: params.id === second.id ? second : operation,
        requests: [request],
        console: [],
      };
    if (params.action === "request")
      return {
        ...base,
        request: {
          ...request,
          response_body: {
            state: "available",
            text: '{"ok":false}',
            offset: params.offset ?? 0,
            ...(params.offset ? {} : { next_offset: 4096 }),
          },
          request_headers: { authorization: "[redacted]" },
          response_headers: { "content-type": "application/json" },
        },
      };
    if (params.action === "console")
      return {
        ...base,
        console: [
          { id: "c1", at: 1000, last_at: 1000, count: 1, level: "error", text: "Startup failure" },
        ],
      };
    if (params.action === "pages")
      return {
        ...base,
        pages: [{ at: 1000, state: "available", title: "Page on load", text: "Loaded context" }],
      };
    if (params.action === "export")
      return {
        ...base,
        recording: {
          version: 1,
          saved_at: 3000,
          run,
          requests: [request],
          operations: [operation, second],
          console: [],
          pages: [],
        },
      };
    return { ...base, run: { ...run, state: "stopped" } };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("website evidence workspace", () => {
  it("drills into request projections, paginates bodies and returns to the timeline", async () => {
    render(<DebugApp />);
    fireEvent.click(await screen.findByText("/api/save"));
    expect(await screen.findByText('{"ok":false}')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一段" }));
    await waitFor(() =>
      expect(recordingRequest).toHaveBeenCalledWith(
        expect.objectContaining({ action: "request", id: "d1:n1", part: "response", offset: 4096 }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Headers" }));
    expect(await screen.findByText("[redacted]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回操作" }));
    fireEvent.click(screen.getAllByRole("button", { name: /点击 · #save/ })[0]);
    expect(await screen.findByText("Save failed")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });
  it("keeps history readable after the task ends, including global console and page context", async () => {
    vi.mocked(debugTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(debugHistory).mockResolvedValue({
      runs: [{ ...run, state: "stopped", stopped_at: 3000 }],
    });
    render(<DebugApp />);
    fireEvent.click(await screen.findByText("/api/save"));
    expect(await screen.findByText('{"ok":false}')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回操作" }));
    fireEvent.click(screen.getByRole("button", { name: /Console/ }));
    expect(await screen.findByText("Startup failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /页面上下文/ }));
    expect(await screen.findByText("Loaded context")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /对比/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启调试" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除记录" }));
    fireEvent.click(screen.getByRole("alertdialog").querySelectorAll("button")[1]);
    await waitFor(() => expect(deleteRecording).toHaveBeenCalledWith("d1"));
  });

  it("exports a historical record after the task ends", async () => {
    vi.mocked(debugTasks).mockResolvedValue({ tasks: [] });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recording");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DebugApp />);
    fireEvent.click(await screen.findByRole("button", { name: "导出 JSON" }));
    await waitFor(() =>
      expect(recordingRequest).toHaveBeenCalledWith({
        action: "export",
        session_id: "s1",
        run_id: "d1",
      }),
    );
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledOnce();
    create.mockRestore();
    click.mockRestore();
  });

  it("stops capture without stopping the task", async () => {
    render(<DebugApp />);
    fireEvent.click(await screen.findByRole("button", { name: "停止采集" }));
    await waitFor(() =>
      expect(debugRequest).toHaveBeenCalledWith({ action: "stop", session_id: "s1", run_id: "d1" }),
    );
  });

  it("renders the empty task state without issuing capture calls", async () => {
    vi.mocked(debugTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(debugHistory).mockResolvedValue({ runs: [] });
    history.replaceState(null, "", "/debug.html");
    render(<DebugApp />);
    expect(await screen.findByText("还没有调试记录")).toBeTruthy();
    expect(debugRequest).not.toHaveBeenCalled();
  });
});
