import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/lib/instance-id";
import { LOCAL_PAIRING_MESSAGE } from "@/lib/local-pairing-bridge";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_WS_URL,
  LOCAL_PAIRING_FRAGMENT_PREFIX,
} from "@/transport/generated/methods";
import type { RemoteEndpoint } from "@/transport/remote-endpoint";
import { readRemoteConnection, readSavedRemoteConnection } from "@/transport/remote-storage";
import { ConnectionSettings } from "./connection-settings";

vi.mock("@/transport/remote-storage", () => ({
  REMOTE_CONNECTION_REVISION: "revision",
  REMOTE_CONNECTION_MODE: "mode",
  readRemoteConnection: vi.fn(),
  readSavedRemoteConnection: vi.fn(),
}));
vi.mock("./local-pairing", async (original) => ({
  ...(await original<typeof import("./local-pairing")>()),
  readLocalPairingInfo: vi.fn(),
}));

import type { LocalAuthStatus } from "@/transport/local-auth";
import v from "../../../../../crates/bsk-protocol/tests/fixtures/local-auth-v1.json";
import { readLocalPairingInfo } from "./local-pairing";

const localLink = `${DEFAULT_DAEMON_WS_URL}/#${LOCAL_PAIRING_FRAGMENT_PREFIX}${v.daemon_id}.${v.device_id}.${v.key}`;
const endpoint: RemoteEndpoint = {
  url: "wss://browser.example/extension",
  token: "a".repeat(43),
  deviceId: "b".repeat(32),
  expiresAt: "2099-01-01T00:00:00Z",
  renewAfter: "2098-01-01T00:00:00Z",
};
const pairing = `wss://other.example:8443/extension#${"c".repeat(43)}`;
let remote: RemoteEndpoint | null;
let storageFails: boolean;
let portWriteFails: boolean;
let store: Record<string, unknown>;
let listeners: Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>;
function notify(changes: Record<string, chrome.storage.StorageChange>) {
  for (const listener of listeners) listener(changes, "local");
}

beforeEach(() => {
  remote = null;
  storageFails = false;
  portWriteFails = false;
  store = { [STORAGE_KEYS.DAEMON_PORT]: DEFAULT_DAEMON_PORT };
  listeners = new Set();
  vi.mocked(readLocalPairingInfo)
    .mockReset()
    .mockResolvedValue({
      policy: { skip: false },
      devices: [],
    });
  vi.mocked(readSavedRemoteConnection)
    .mockReset()
    .mockImplementation(async () => remote);
  vi.mocked(readRemoteConnection)
    .mockReset()
    .mockImplementation(async () => {
      if (storageFails) throw new Error("Storage unavailable");
      return remote;
    });
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn(async ({ pairing }: { pairing: string | null }) => {
      remote = pairing === null ? null : { ...endpoint, url: pairing.split("#")[0] };
      storageFails = false;
      notify({ mode: { newValue: remote ? "remote" : "local" } });
      return { url: remote?.url ?? null };
    }),
  };
  vi.stubGlobal("chrome", {
    runtime,
    storage: {
      local: {
        get: vi.fn((_keys: unknown, callback?: (value: typeof store) => void) => {
          callback?.({ ...store });
          return Promise.resolve({ ...store });
        }),
        set: vi.fn((items: typeof store, callback?: () => void) => {
          if (portWriteFails) {
            runtime.lastError = { message: "Write failed" };
            callback?.();
            runtime.lastError = undefined;
            return;
          }
          Object.assign(store, items);
          notify(
            Object.fromEntries(
              Object.entries(items).map(([key, value]) => [key, { newValue: value }]),
            ),
          );
          callback?.();
        }),
      },
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.add(listener),
        removeListener: (listener: Parameters<typeof listeners.delete>[0]) =>
          listeners.delete(listener),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function choose(name: "本机" | "远程") {
  const button = screen.getByRole("button", { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
function submit() {
  fireEvent.submit(document.querySelector("form")!);
}

it("shows the settings without a disclosure and the address under the selected tab", async () => {
  const { container } = render(<ConnectionSettings connectionEnabled />);
  const settings = container.querySelector('[data-slot="popup-connection-settings"]')!;
  expect(settings.tagName).toBe("SECTION");
  await waitFor(() => expect(settings.firstElementChild?.textContent).toContain("本机"));
  expect(settings.firstElementChild?.textContent).not.toContain("ws://");
  const address = settings.querySelector('[data-slot="popup-current-connection"]')!;
  expect(address.textContent).toBe(`本机 · ${DEFAULT_DAEMON_WS_URL}`);
  const tabs = screen.getByRole("group", { name: "连接方式" });
  expect(tabs.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await choose("远程");
  expect(settings.querySelector('[data-slot="popup-current-connection"]')).toBeNull();
});

it("explains what saving does only once there is a valid change to save", async () => {
  render(<ConnectionSettings connectionEnabled />);
  await choose("本机");
  const warning = () => document.querySelector('[data-slot="popup-save-warning"]');
  expect(warning()).toBeNull();
  fireEvent.change(screen.getByLabelText("本机端口"), { target: { value: "53300" } });
  expect(warning()?.textContent).toBe("保存后会结束当前任务，并在连接开启时重新连接。");
  fireEvent.change(screen.getByLabelText("本机端口"), { target: { value: "port" } });
  submit();
  await screen.findByText("请输入 1 到 65535 之间的端口号。");
  expect(warning()).toBeNull();
  fireEvent.change(screen.getByLabelText("本机端口"), {
    target: { value: String(DEFAULT_DAEMON_PORT) },
  });
  expect(warning()).toBeNull();
});

it("local: gives the pairing steps behind an info icon and keeps the remote hint in place", async () => {
  render(<ConnectionSettings connectionEnabled />);
  await choose("本机");
  const info = screen.getByRole("button", { name: "配对链接说明" });
  const steps = document.getElementById(info.getAttribute("aria-describedby")!)!;
  expect(steps.getAttribute("role")).toBe("tooltip");
  expect(steps.textContent).toBe("运行 bsk daemon pair 命令\n将输出的完整链接粘贴进输入框");
  expect(document.querySelector("form")?.textContent).not.toContain("自动识别");
  await choose("远程");
  expect(screen.queryByRole("button", { name: "配对链接说明" })).toBeNull();
  expect(screen.getByText("粘贴可信服务器的完整配对链接，端口已包含在内。")).toBeTruthy();
});

it("only changes the form until saved, and cancels both mode and port drafts without writes", async () => {
  render(<ConnectionSettings connectionEnabled />);
  await choose("本机");
  fireEvent.change(screen.getByLabelText("本机端口"), { target: { value: "53300" } });
  await choose("远程");
  expect(document.querySelector('[data-slot="popup-current-connection"]')).toBeNull();
  expect(screen.queryByLabelText("本机端口")).toBeNull();
  fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: pairing } });
  expect(screen.getByText("将连接到：wss://other.example:8443/extension")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
  expect((screen.getByLabelText("本机端口") as HTMLInputElement).value).toBe(
    String(DEFAULT_DAEMON_PORT),
  );
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("submits pairing on Enter, preserves the disabled switch and shows the configured address", async () => {
  const user = userEvent.setup();
  render(<ConnectionSettings connectionEnabled={false} />);
  await choose("远程");
  await user.type(screen.getByLabelText("配对链接"), pairing);
  await user.keyboard("{Enter}");
  expect(await screen.findByText("配对成功，连接开关当前关闭。开启后即可连接。")).toBeTruthy();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: "bsk-remote-authorization",
    pairing,
  });
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  expect(document.querySelector('[data-slot="popup-current-connection"]')?.textContent).toBe(
    "远程 · wss://other.example:8443/extension",
  );
  expect((screen.getByLabelText("配对链接") as HTMLInputElement).value).toBe("");
  expect(document.body.textContent).not.toContain(pairing.split("#")[1]);
});

it("rejects an invalid pairing link before messaging the background", async () => {
  render(<ConnectionSettings connectionEnabled />);
  await choose("远程");
  fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: "https://example.com" } });
  submit();
  expect(await screen.findByText(/配对链接不完整或格式不正确/)).toBeTruthy();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  await act(async () => notify({ revision: { newValue: "updated" } }));
  expect(screen.getByRole("alert").textContent).toContain("配对链接不完整");
  expect((screen.getByLabelText("配对链接") as HTMLInputElement).value).toBe("https://example.com");
});

it("shows progress and prevents duplicate pairing while the request is pending", async () => {
  let finish!: (reply: { url: string }) => void;
  vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<ConnectionSettings connectionEnabled />);
  await choose("远程");
  fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: pairing } });
  submit();
  submit();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "正在配对…" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "本机" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    remote = endpoint;
    finish({ url: endpoint.url });
  });
  expect(await screen.findByText("配对成功。")).toBeTruthy();
});

it("keeps the current grant and draft when pairing fails", async () => {
  remote = endpoint;
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ error: "Unable to pair" });
  render(<ConnectionSettings connectionEnabled />);
  await choose("远程");
  fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: pairing } });
  submit();
  expect(await screen.findByText(/配对未完成/)).toBeTruthy();
  expect(document.querySelector('[data-slot="popup-current-connection"]')?.textContent).toBe(
    `远程 · ${endpoint.url}`,
  );
  expect((screen.getByLabelText("配对链接") as HTMLInputElement).value).toBe(pairing);
  expect(remote).toBe(endpoint);
});

it("keeps the remote grant when the proposed local port is invalid or cannot be saved", async () => {
  remote = endpoint;
  render(<ConnectionSettings connectionEnabled />);
  await choose("本机");
  expect(screen.getByText(/远程配对会保留/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("本机端口"), { target: { value: "65536" } });
  submit();
  expect(await screen.findByText("请输入 1 到 65535 之间的端口号。")).toBeTruthy();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  portWriteFails = true;
  fireEvent.change(screen.getByLabelText("本机端口"), { target: { value: "53300" } });
  submit();
  expect(await screen.findByText("端口保存失败，请重试。")).toBeTruthy();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(remote).toBe(endpoint);
  portWriteFails = false;
  submit();
  expect(await screen.findByText("已切换到本机服务。")).toBeTruthy();
  expect(store[STORAGE_KEYS.DAEMON_PORT]).toBe(53300);
  expect(remote).toBeNull();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: "bsk-remote-authorization",
    pairing: null,
  });
});

it("offers explicit local recovery when remote storage cannot be read", async () => {
  storageFails = true;
  render(<ConnectionSettings connectionEnabled />);
  expect((await screen.findByRole("alert")).textContent).toContain("无法读取连接设置");
  expect(screen.getByText("无法读取连接设置")).toBeTruthy();
  await choose("本机");
  submit();
  expect(await screen.findByText("已切换到本机服务。")).toBeTruthy();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: "bsk-remote-authorization",
    pairing: null,
  });
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
});

it("shows remote-specific guidance for a disconnected remote connection", async () => {
  remote = endpoint;
  render(<ConnectionSettings connectionEnabled disconnected />);
  expect(await screen.findByText("无法连接远程服务，请检查服务器、网络或授权状态。")).toBeTruthy();
  expect(screen.queryByText("无法连接，请确认 daemon 已启动且端口一致。")).toBeNull();
});

it("shows an expired grant and asks for a new pairing without deleting it", async () => {
  remote = { ...endpoint, expiresAt: "2020-01-01T00:00:00Z" };
  render(<ConnectionSettings connectionEnabled disconnected />);
  expect(await screen.findByText("授权已过期，请使用新的配对链接重新连接。")).toBeTruthy();
  expect(screen.getByText(/授权到期时间：/)).toBeTruthy();
  expect(screen.getByText("需要关注")).toBeTruthy();
  expect(screen.queryByText("无法连接远程服务，请检查服务器、网络或授权状态。")).toBeNull();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it("distinguishes a failed renewal from an expired grant", async () => {
  remote = { ...endpoint, pendingToken: "c".repeat(43), renewalFailure: "unavailable" };
  render(<ConnectionSettings connectionEnabled />);
  expect(await screen.findByText(/续期暂未成功/)).toBeTruthy();
  expect(screen.queryByText(/授权已过期/)).toBeNull();
  expect(document.body.textContent).not.toContain(endpoint.token);
});

it("does not declare an unconfirmed rotation invalid based on its old local expiry", async () => {
  remote = { ...endpoint, expiresAt: "2020-01-01T00:00:00Z", pendingToken: "c".repeat(43) };
  render(<ConnectionSettings connectionEnabled />);
  expect(await screen.findByText(/此前续期可能已成功/)).toBeTruthy();
  expect(screen.queryByText("授权已过期，请使用新的配对链接重新连接。")).toBeNull();
});

it("pair: opens local pairing immediately and recognizes local links from either tab", async () => {
  render(
    <ConnectionSettings
      connectionEnabled
      instanceId="a1b2c3d4"
      localAuth={{ state: "pairing_required" }}
    />,
  );
  await choose("远程");
  fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: localLink } });
  expect(screen.getByRole("button", { name: "本机" }).getAttribute("aria-pressed")).toBe("true");
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ ok: true });
  submit();
  await screen.findByText("配对成功。");
  expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: LOCAL_PAIRING_MESSAGE,
    action: "pair",
    link: localLink,
  });
  expect(document.body.textContent).not.toContain(v.key);
});
function pairedInfo(skip = false) {
  vi.mocked(readLocalPairingInfo).mockResolvedValue({
    policy: { skip },
    devices: [
      {
        daemonId: v.daemon_id,
        deviceId: v.device_id,
        endpoint: `${DEFAULT_DAEMON_WS_URL}/`,
      },
    ],
  });
}
it("connected/settings: the new-link input and advanced settings stay hidden until asked for", async () => {
  pairedInfo();
  render(
    <ConnectionSettings
      connectionEnabled
      localAuth={{ state: "verified", daemonId: v.daemon_id }}
    />,
  );
  const newLink = await screen.findByRole("button", { name: "使用新的配对链接" });
  expect(newLink.getAttribute("data-variant")).toBe("outline");
  expect(document.querySelector<HTMLDetailsElement>('[data-slot="local-advanced"]')?.open).toBe(
    false,
  );
  expect(screen.queryByLabelText("配对链接")).toBeNull();
  fireEvent.click(screen.getByText("使用新的配对链接"));
  expect(screen.getByLabelText("配对链接")).toBeTruthy();
});
it.each([
  ["already_paired", /bsk daemon pair --replace a1b2c3d4/],
  ["replace_mismatch", /bsk daemon revoke a1b2c3d4/],
] as const)("%s: replacement requires confirmation and a rejected link preserves the current grant", async (error, guidance) => {
  pairedInfo();
  render(
    <ConnectionSettings
      connectionEnabled
      instanceId="b7e2f019"
      localAuth={{ state: "verified", daemonId: v.daemon_id }}
    />,
  );
  fireEvent.click(await screen.findByText("使用新的配对链接"));
  fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: localLink } });
  submit();
  expect(screen.getByRole("alertdialog").textContent).toContain("替换成功后当前任务会结束");
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ error, browserId: "a1b2c3d4" });
  fireEvent.click(screen.getByText("继续配对"));
  expect(await screen.findByText(guidance)).toBeTruthy();
  expect((screen.getByLabelText("配对链接") as HTMLInputElement).value).toBe(localLink);
  expect(document.querySelector('[data-slot="local-paired-info"]')).toBeTruthy();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
});
it("skip: requires confirmation and keeps restore guidance visible without a click", async () => {
  pairedInfo();
  const { rerender } = render(<ConnectionSettings connectionEnabled />);
  await screen.findByText("使用新的配对链接");
  fireEvent.click(screen.getByRole("switch", { name: "跳过本机验证" }));
  expect(screen.getByRole("alertdialog").textContent).toContain("bsk daemon trust-local on");
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ ok: true });
  pairedInfo(true);
  fireEvent.click(screen.getByText("确认跳过"));
  await screen.findByText("恢复验证");
  expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: LOCAL_PAIRING_MESSAGE,
    action: "skip",
    value: true,
  });
  rerender(
    <ConnectionSettings
      connectionEnabled
      localAuth={{ state: "unverified_local", reason: "skip" }}
    />,
  );
  expect(
    document.querySelector('[data-slot="local-pairing-notice"]')?.closest("details"),
  ).toBeNull();
  pairedInfo(false);
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ ok: true });
  fireEvent.click(screen.getByText("恢复验证"));
  expect(await screen.findByText(/bsk daemon trust-local off/)).toBeTruthy();
});
it.each([
  [{ state: "unverified_local", reason: "unpaired" }, /连接身份尚未验证/],
  [{ state: "server_unverified" }, /服务未通过验证/],
  [{ state: "daemon_too_old" }, /本机 bsk 版本过旧/],
] satisfies [
  LocalAuthStatus,
  RegExp,
][])("renders the %j state without revealing credentials", async (status, message) => {
  render(<ConnectionSettings connectionEnabled localAuth={status} />);
  if (status.state === "unverified_local")
    fireEvent.click(screen.getByRole("button", { name: "未配对" }));
  await screen.findByText(message);
  if (["server_unverified", "daemon_too_old"].includes(status.state)) {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByText("重试"));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      kind: LOCAL_PAIRING_MESSAGE,
      action: "retry",
    });
  }
  expect(document.body.textContent).not.toContain(v.key);
});
it("unpaired: keeps the advice behind a warning icon and offers optional pairing and official security guidance", async () => {
  render(
    <ConnectionSettings
      connectionEnabled
      localAuth={{ state: "unverified_local", reason: "unpaired" }}
    />,
  );
  const settings = document.querySelector('[data-slot="popup-connection-settings"]')!;
  const toggle = screen.getByRole("button", { name: "未配对" });
  expect(settings.firstElementChild?.contains(toggle)).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[data-slot="local-pairing-notice"]')).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(settings.contains(document.querySelector('[data-slot="local-pairing-notice"]'))).toBe(
    true,
  );
  expect(screen.getByText(/连接身份尚未验证/)).toBeTruthy();
  const help = screen.getByRole("link", { name: "为什么建议配对？" });
  expect(help.getAttribute("href")).toBe("https://browserskill.weixin.qq.com/#security");
  expect(help.getAttribute("target")).toBe("_blank");
  fireEvent.click(screen.getByRole("button", { name: "去配对" }));
  expect(document.activeElement).toBe(screen.getByLabelText("配对链接"));
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  expect(document.querySelector('[data-slot="local-pairing-notice"]')).toBeNull();
});
it("remote: resumes retained authorization before expiry without asking for a new link", async () => {
  vi.mocked(readSavedRemoteConnection).mockResolvedValue(endpoint);
  render(<ConnectionSettings connectionEnabled />);
  await choose("远程");
  expect(screen.getByText(/授权到期时间/)).toBeTruthy();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ url: endpoint.url });
  fireEvent.click(screen.getByText("切回远程"));
  await screen.findByText("配对成功。");
  expect(chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
    kind: "bsk-remote-authorization",
    resume: true,
  });
});
