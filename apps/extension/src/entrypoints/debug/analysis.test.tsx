import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRequest } from "@/debug/client";
import type { DebugResult } from "@/debug/types";
import { AnalysisPanel } from "./analysis";

vi.mock("@/debug/client", () => ({ recordingRequest: vi.fn() }));
afterEach(cleanup);

const modes = [
  { action: "aggregate", label: "接口聚合", other: "疑似重复", otherAction: "duplicates" },
  { action: "duplicates", label: "疑似重复", other: "接口聚合", otherAction: "aggregate" },
] as const;

function result(action: string, offset: number): DebugResult {
  const url = `https://site.test/${action}/${offset}`;
  return {
    session_id: "s1",
    next_offset: offset === 0 ? 20 : undefined,
    aggregates: [
      {
        id: url,
        method: "GET",
        endpoint: url,
        count: 2,
        failed: 0,
        http_errors: 0,
        pending: 0,
        interrupted: 0,
        statuses: { "200": 2 },
        slow: 0,
        timing_samples: 2,
        transfer_bytes: 100,
        transfer_samples: 2,
        cached: 0,
        service_worker: 0,
        controlled: 0,
        replayed: 0,
        request_ids: ["d1:n1", "d1:n2"],
        refs_truncated: false,
      },
    ],
    duplicates: [
      {
        id: url,
        method: "GET",
        url,
        count: 2,
        extra_requests: 1,
        started_at: 100,
        ended_at: 150,
        overlap_count: 1,
        possible_retry: false,
        request_ids: ["d1:n1", "d1:n2"],
        operation_ids: [],
        refs_truncated: false,
      },
    ],
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks();
  vi.mocked(recordingRequest).mockImplementation(async ({ action, offset = 0 }) =>
    result(action, offset),
  );
});

describe("analysis of a stopped recording", () => {
  it.each(modes)("keeps $action results when reselecting the current mode", async (mode) => {
    render(<AnalysisPanel session="s1" run="d1" pulse={5} onRequest={() => {}} />);
    await screen.findByRole("heading", { name: "GET https://site.test/aggregate/0" });
    fireEvent.click(screen.getByRole("button", { name: mode.label }));
    const heading = `GET https://site.test/${mode.action}/0`;
    await screen.findByRole("heading", { name: heading });
    const reads = vi.mocked(recordingRequest).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: mode.label }));

    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByText("正在读取…")).toBeNull();
    expect(recordingRequest).toHaveBeenCalledTimes(reads);

    fireEvent.click(screen.getByRole("button", { name: mode.other }));
    await screen.findByRole("heading", {
      name: `GET https://site.test/${mode.otherAction}/0`,
    });
    expect(recordingRequest).toHaveBeenCalledTimes(reads + 1);
    expect(recordingRequest).toHaveBeenLastCalledWith({
      session_id: "s1",
      run_id: "d1",
      action: mode.otherAction,
      offset: 0,
      limit: 20,
    });
  });

  it.each(modes)("keeps the current $action page when reselecting its mode", async (mode) => {
    render(<AnalysisPanel session="s1" run="d1" pulse={5} onRequest={() => {}} />);
    await screen.findByRole("heading", { name: "GET https://site.test/aggregate/0" });
    fireEvent.click(screen.getByRole("button", { name: mode.label }));
    await screen.findByRole("heading", { name: `GET https://site.test/${mode.action}/0` });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    const heading = `GET https://site.test/${mode.action}/20`;
    await screen.findByRole("heading", { name: heading });
    const reads = vi.mocked(recordingRequest).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: mode.label }));

    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(recordingRequest).toHaveBeenCalledTimes(reads);
    expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: mode.other }));
    await screen.findByRole("heading", {
      name: `GET https://site.test/${mode.otherAction}/0`,
    });
    expect(recordingRequest).toHaveBeenCalledTimes(reads + 1);
    expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
