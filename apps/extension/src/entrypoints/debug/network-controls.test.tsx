import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugRequest, recordingRequest } from "@/debug/client";
import type { DebugRequest, DebugRule } from "@/debug/types";
import { ReplayEditor, RuleEditor, RulesPanel } from "./network-controls";

afterEach(cleanup);
vi.mock("@/debug/client", () => ({ debugRequest: vi.fn(), recordingRequest: vi.fn() }));
const request: DebugRequest = {
  id: "d1:n1",
  run_id: "d1",
  sequence: 1,
  started_at: 0,
  url: "https://site.test/save",
  method: "POST",
  resource_type: "Fetch",
  integrity: { url: "complete", metadata: "complete" },
  state: "complete",
  request_headers: { cookie: "[redacted]", "content-type": "application/json" },
  request_body: { state: "available", replay_safe: true, text: '{"name":"Alice"}' },
  response_body: { state: "empty" },
};
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks();
  vi.mocked(debugRequest).mockResolvedValue({ session_id: "s1" });
  vi.mocked(recordingRequest).mockResolvedValue({ session_id: "s1", request, rules: [] });
});
describe("request control UI", () => {
  it.each([
    "block",
    "mock",
  ] as const)("preserves Document scope when creating a %s rule", async (initial) => {
    render(
      <RuleEditor
        session="s1"
        run="d1"
        request={{ ...request, resource_type: "Document" }}
        initial={initial}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "启用规则" }));
    await waitFor(() =>
      expect(debugRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          rule: expect.objectContaining({
            match: { url: request.url, method: "POST", resource_type: "Document" },
            effect: expect.objectContaining({ type: initial }),
          }),
        }),
      ),
    );
  });

  it.each([
    "Image",
    undefined,
  ])("prevents rules for unsupported or unknown resource types: %s", (resource_type) => {
    render(
      <RuleEditor
        session="s1"
        run="d1"
        request={{ ...request, resource_type }}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "启用规则" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("资源类型不支持或未知");
    fireEvent.click(button);
    expect(debugRequest).not.toHaveBeenCalled();
  });

  it("does not turn a truncated URL or legacy body draft into an implicit replacement", async () => {
    const entry: DebugRequest = {
      ...request,
      integrity: { url: "truncated", metadata: "complete" },
      request_body: { state: "available", text: '{"orderId":9007199254740992}' },
    };
    vi.mocked(recordingRequest).mockResolvedValue({ session_id: "s1", request: entry });
    render(
      <ReplayEditor
        session="s1"
        request={entry}
        onChange={() => {}}
        onCancel={() => {}}
        onRequest={() => {}}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain(
        "9007199254740992",
      ),
    );
    const url = screen.getByRole("textbox", { name: /^URL/ }) as HTMLInputElement;
    const send = screen.getByRole("button", { name: "发送一次" }) as HTMLButtonElement;
    expect(url.value).toBe("");
    expect(send.disabled).toBe(true);
    fireEvent.change(url, { target: { value: "https://site.test/save?mode=dry-run" } });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("正文"), {
      target: { value: '{"orderId":9007199254740993}' },
    });
    fireEvent.click(send);
    await waitFor(() => expect(debugRequest).toHaveBeenCalledTimes(1));
    expect(debugRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        replay: expect.objectContaining({
          url: "https://site.test/save?mode=dry-run",
          body: '{"orderId":9007199254740993}',
        }),
      }),
    );
  });

  it("reuses verified evidence by ID without supplying untouched drafts as overrides", async () => {
    render(
      <ReplayEditor
        session="s1"
        request={request}
        onChange={() => {}}
        onCancel={() => {}}
        onRequest={() => {}}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("Alice"),
    );
    fireEvent.click(screen.getByRole("button", { name: "发送一次" }));
    await waitFor(() => expect(debugRequest).toHaveBeenCalledTimes(1));
    const replay = vi.mocked(debugRequest).mock.calls[0][0].replay!;
    expect(replay).not.toHaveProperty("body");
    expect(replay).not.toHaveProperty("url");
  });
  it("creates a one-shot mock from a selected request without changing its URL/method", async () => {
    const done = vi.fn();
    render(
      <RuleEditor session="s1" run="d1" request={request} onDone={done} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: '{"name":"Mock"}' } });
    fireEvent.click(screen.getByRole("button", { name: "启用规则" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(debugRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rule_add",
        session_id: "s1",
        run_id: "d1",
        rule: expect.objectContaining({
          match: { url: request.url, method: "POST", resource_type: "Fetch" },
          effect: expect.objectContaining({ type: "mock", status: 503, body: '{"name":"Mock"}' }),
          times: 1,
        }),
      }),
    );
  });
  it("keeps archived rules visible without showing execution controls", async () => {
    const rule: DebugRule = {
      id: "d1:r1",
      name: "Mock saved response",
      match: { url: request.url },
      effect: { type: "mock", status: 200, body: "{}" },
      state: "stopped",
      hits: 1,
      failures: 0,
      created_at: 0,
      times: 1,
    };
    vi.mocked(recordingRequest).mockResolvedValue({ session_id: "s1", rules: [rule] });
    render(<RulesPanel session="s1" run="d1" pulse={0} active={false} onChange={() => {}} />);
    expect(await screen.findByText("Mock saved response")).toBeDefined();
    expect(screen.queryByRole("button", { name: "添加规则" })).toBeNull();
    expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
    expect(debugRequest).not.toHaveBeenCalled();
  });
  it("loads a replay draft and sends one attempt with an idempotency key and source linkage", async () => {
    const open = vi.fn();
    vi.mocked(debugRequest).mockResolvedValue({
      session_id: "s1",
      replay: {
        id: "replay1",
        key: "key",
        source_request_id: request.id,
        request_id: "d1:n2",
        state: "complete",
      },
    });
    render(
      <ReplayEditor
        session="s1"
        request={request}
        onChange={() => {}}
        onCancel={() => {}}
        onRequest={open}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("Alice"),
    );
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: '{"name":"Bob"}' } });
    fireEvent.click(screen.getByRole("button", { name: "发送一次" }));
    await screen.findByRole("button", { name: "查看重放请求" });
    expect(debugRequest).toHaveBeenCalledTimes(1);
    expect(debugRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "replay",
        id: request.id,
        replay: expect.objectContaining({
          key: expect.any(String),
          body: '{"name":"Bob"}',
          headers: { "content-type": "application/json" },
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "发送一次" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看重放请求" }));
    expect(open).toHaveBeenCalledWith("d1:n2");
  });
});
