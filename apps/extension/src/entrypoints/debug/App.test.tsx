import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
import { RequestDetail, RequestList } from "./evidence";
import { useRequests } from "./use-requests";

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
  it("keeps a rule draft through the first operation and manual panel changes", async () => {
    let actions: DebugOperation[] = [];
    const read = vi.mocked(recordingRequest).getMockImplementation()!;
    vi.mocked(recordingRequest).mockImplementation(async (params) =>
      params.action === "operations" ? { session_id: "s1", operations: actions } : read(params),
    );
    vi.mocked(debugHistory).mockResolvedValue({ runs: [{ ...run, operations: 0, next_since: 0 }] });
    render(<DebugApp />);
    await screen.findByText("暂无已记录的操作。");
    fireEvent.click(screen.getByRole("button", { name: /请求规则/ }));
    fireEvent.click(await screen.findByRole("button", { name: "添加规则" }));
    fireEvent.change(screen.getByLabelText("规则名称"), { target: { value: "Keep my draft" } });
    fireEvent.change(screen.getByLabelText("匹配网址（路径可使用 *）"), {
      target: { value: "https://site.test/api/*" },
    });
    actions = [operation];
    vi.mocked(debugHistory).mockResolvedValue({ runs: [{ ...run, next_since: 3 }] });
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByRole("button", { name: /点击 · #save/ });
    expect((screen.getByRole("textbox", { name: "规则名称" }) as HTMLInputElement).value).toBe(
      "Keep my draft",
    );
    fireEvent.click(screen.getByRole("button", { name: /Console/ }));
    await screen.findByText("Startup failure");
    const ruleReads = vi
      .mocked(recordingRequest)
      .mock.calls.filter(([p]) => p.action === "rules").length;
    const operationReads = vi
      .mocked(recordingRequest)
      .mock.calls.filter(([p]) => p.action === "operations").length;
    vi.mocked(debugHistory).mockResolvedValue({ runs: [{ ...run, next_since: 4 }] });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(
        vi.mocked(recordingRequest).mock.calls.filter(([p]) => p.action === "operations"),
      ).toHaveLength(operationReads + 1),
    );
    expect(
      vi.mocked(recordingRequest).mock.calls.filter(([p]) => p.action === "rules"),
    ).toHaveLength(ruleReads);
    fireEvent.click(screen.getByRole("button", { name: /请求规则/ }));
    expect((screen.getByRole("textbox", { name: "规则名称" }) as HTMLInputElement).value).toBe(
      "Keep my draft",
    );
    expect((screen.getByLabelText("匹配网址（路径可使用 *）") as HTMLInputElement).value).toBe(
      "https://site.test/api/*",
    );
  });

  it("does not override a panel chosen before the initial operation read completes", async () => {
    const read = vi.mocked(recordingRequest).getMockImplementation()!;
    let finish!: (value: { session_id: string; operations: DebugOperation[] }) => void;
    vi.mocked(recordingRequest).mockImplementation((params) =>
      params.action === "operations"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : read(params),
    );
    render(<DebugApp />);
    fireEvent.click(await screen.findByRole("button", { name: /请求规则/ }));
    await screen.findByRole("button", { name: "添加规则" });
    finish({ session_id: "s1", operations: [operation] });
    await screen.findByRole("button", { name: /点击 · #save/ });
    expect(screen.getByRole("button", { name: "添加规则" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /请求规则/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

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

describe("request detail navigation", () => {
  it.each([
    { part: "response", label: "响应正文", content: '{"ok":false}' },
    { part: "headers", label: "Headers", content: "[redacted]" },
  ] as const)("keeps loaded $part evidence when its selected tab is clicked again", async ({
    part,
    label,
    content,
  }) => {
    render(
      <RequestDetail
        session="s1"
        request={request}
        pulse={2}
        initialPart={part}
        onClose={() => {}}
      />,
    );
    await screen.findByText(content);
    const reads = vi.mocked(recordingRequest).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByText(content)).toBeTruthy();
    expect(screen.queryByText("正在读取…")).toBeNull();
    expect(recordingRequest).toHaveBeenCalledTimes(reads);
  });
});

describe("incremental request list", () => {
  it("shows the newest request immediately without changing operation-list order", () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({
      ...request,
      id: `d:n${i}`,
      started_at: i,
      url: `https://site.test/request-${i}`,
    }));
    const { rerender } = render(<RequestList requests={entries} onSelect={() => {}} newestFirst />);
    expect(screen.getByText("/request-149")).toBeTruthy();
    expect(screen.queryByText("/request-0")).toBeNull();
    const next = { ...request, id: "d:new", started_at: 151, url: "https://site.test/newest" };
    rerender(<RequestList requests={[...entries, next]} onSelect={() => {}} newestFirst />);
    expect(screen.getByText("/newest")).toBeTruthy();
    rerender(<RequestList requests={entries} onSelect={() => {}} />);
    expect(screen.getByText("/request-0")).toBeTruthy();
    expect(screen.queryByText("/request-149")).toBeNull();
  });

  it("merges updates, resyncs on retention, and pauses when its panel is hidden", async () => {
    let current = { ...run, next_since: 101 };
    let retained = Array.from({ length: 101 }, (_, i) => ({
      ...request,
      id: `d1:n${i + 1}`,
      sequence: i + 1,
      started_at: 1000 + i,
    }));
    vi.mocked(recordingRequest).mockImplementation(async (params) => {
      const page = retained
        .filter((entry) => entry.sequence > (params.since ?? 0))
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, params.limit);
      return {
        session_id: "s1",
        run: current,
        requests: page,
        next_since: page.at(-1)?.sequence ?? current.next_since,
      };
    });
    const { result, rerender } = renderHook(({ run, enabled }) => useRequests(run, enabled), {
      initialProps: { run: current, enabled: true },
    });
    await waitFor(() => expect(result.current.requests).toHaveLength(101));
    expect(vi.mocked(recordingRequest).mock.calls.map(([p]) => p.since)).toEqual([0, 100]);
    retained[0] = { ...retained[0], status: 500, sequence: 102 };
    retained.push({ ...request, id: "d1:new", sequence: 103 });
    current = { ...current, next_since: 103 };
    rerender({ run: current, enabled: true });
    await waitFor(() => expect(result.current.requests).toHaveLength(102));
    expect(recordingRequest).toHaveBeenLastCalledWith(expect.objectContaining({ since: 101 }));
    expect(result.current.requests.find((entry) => entry.id === "d1:n1")!.status).toBe(500);
    retained = retained.filter((entry) => entry.id !== "d1:n2");
    current = { ...current, next_since: 104, dropped_requests: 1 };
    const before = vi.mocked(recordingRequest).mock.calls.length;
    rerender({ run: current, enabled: true });
    await waitFor(() => expect(result.current.requests).toHaveLength(101));
    expect(vi.mocked(recordingRequest).mock.calls[before][0].since).toBe(0);
    expect(result.current.requests.some((entry) => entry.id === "d1:n2")).toBe(false);
    const calls = vi.mocked(recordingRequest).mock.calls.length;
    current = { ...current, next_since: 105 };
    rerender({ run: current, enabled: false });
    expect(recordingRequest).toHaveBeenCalledTimes(calls);
    rerender({ run: current, enabled: true });
    await waitFor(() => expect(recordingRequest).toHaveBeenCalledTimes(calls + 1));
    expect(recordingRequest).toHaveBeenLastCalledWith(expect.objectContaining({ since: 103 }));
  });

  it("serializes overlapping refreshes and keeps progress made by a superseded page", async () => {
    let finish: (value: Awaited<ReturnType<typeof recordingRequest>>) => void = () => {};
    vi.mocked(recordingRequest)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        session_id: "s1",
        requests: [{ ...request, id: "d1:n2", sequence: 3 }],
        next_since: 3,
      });
    const { result, rerender } = renderHook((value) => useRequests(value, true), {
      initialProps: run,
    });
    await waitFor(() => expect(recordingRequest).toHaveBeenCalledTimes(1));
    rerender({ ...run, next_since: 3 });
    expect(recordingRequest).toHaveBeenCalledTimes(1);
    finish({ session_id: "s1", requests: [request], next_since: 2 });
    await waitFor(() => expect(result.current.requests).toHaveLength(2));
    expect(recordingRequest).toHaveBeenLastCalledWith(expect.objectContaining({ since: 2 }));
  });

  it("restarts if retention changes during a read, without keeping removed rows", async () => {
    vi.mocked(recordingRequest)
      .mockResolvedValueOnce({ session_id: "s1", requests: [request], next_since: 2 })
      .mockResolvedValueOnce({
        session_id: "s1",
        run: { ...run, dropped_requests: 1 },
        requests: [],
        next_since: 3,
      })
      .mockResolvedValueOnce({
        session_id: "s1",
        run: { ...run, dropped_requests: 1 },
        requests: [{ ...request, id: "d1:n2", sequence: 3 }],
        next_since: 3,
      });
    const { result, rerender } = renderHook((value) => useRequests(value, true), {
      initialProps: run,
    });
    await waitFor(() => expect(result.current.requests[0]?.id).toBe(request.id));
    rerender({ ...run, next_since: 3 });
    await waitFor(() => expect(result.current.requests[0]?.id).toBe("d1:n2"));
    expect(result.current.requests).toHaveLength(1);
    expect(vi.mocked(recordingRequest).mock.calls.map(([p]) => p.since)).toEqual([0, 2, 0]);
  });

  it("rechecks older evidence after an incomplete storage fallback", async () => {
    const fallbackRun = { ...run, coverage: ["evidence_read_failed"] };
    vi.mocked(recordingRequest)
      .mockResolvedValueOnce({
        session_id: "s1",
        run: fallbackRun,
        requests: [{ ...request, id: "d1:new", sequence: 50 }],
        next_since: 50,
      })
      .mockResolvedValueOnce({
        session_id: "s1",
        run: fallbackRun,
        requests: [request, { ...request, id: "d1:new", sequence: 50 }],
        next_since: 51,
      });
    const { result, rerender } = renderHook((value) => useRequests(value, true), {
      initialProps: run,
    });
    await waitFor(() => expect(result.current.requests).toHaveLength(1));
    rerender({ ...run, next_since: 51 });
    await waitFor(() => expect(result.current.requests).toHaveLength(2));
    expect(vi.mocked(recordingRequest).mock.calls.map(([p]) => p.since)).toEqual([0, 0]);
  });

  it("resumes after a failed page instead of discarding earlier progress", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      ...request,
      id: `d1:n${i + 1}`,
      sequence: i + 1,
    }));
    vi.mocked(recordingRequest)
      .mockResolvedValueOnce({ session_id: "s1", requests: page, next_since: 100 })
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({
        session_id: "s1",
        requests: [{ ...request, id: "d1:last", sequence: 101 }],
        next_since: 101,
      });
    const { result, rerender } = renderHook((value) => useRequests(value, true), {
      initialProps: run,
    });
    await waitFor(() => expect(result.current.error).toBe("storage unavailable"));
    expect(result.current.requests).toHaveLength(100);
    rerender({ ...run, next_since: 101 });
    await waitFor(() => expect(result.current.requests).toHaveLength(101));
    expect(result.current.error).toBe("");
    expect(vi.mocked(recordingRequest).mock.calls.map(([p]) => p.since)).toEqual([0, 100, 100]);
  });

  it("ignores a previous run's late response after the selection changes", async () => {
    let finish: (value: Awaited<ReturnType<typeof recordingRequest>>) => void = () => {};
    vi.mocked(recordingRequest)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        session_id: "s2",
        requests: [{ ...request, id: "d2:n1", run_id: "d2" }],
        next_since: 2,
      });
    const { result, rerender } = renderHook((value) => useRequests(value, true), {
      initialProps: run,
    });
    await waitFor(() => expect(recordingRequest).toHaveBeenCalledTimes(1));
    rerender({ ...run, id: "d2", session_id: "s2" });
    await waitFor(() => expect(result.current.requests[0]?.id).toBe("d2:n1"));
    finish({ session_id: "s1", requests: [request], next_since: 2 });
    await Promise.resolve();
    expect(result.current.requests.map((entry) => entry.id)).toEqual(["d2:n1"]);
    expect(recordingRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ session_id: "s2", run_id: "d2", since: 0 }),
    );
  });
});
