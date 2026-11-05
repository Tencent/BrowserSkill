import { i18n } from "@browser-skill/i18n";
import { afterEach, expect, it, vi } from "vitest";
import type { SnapshotInfo } from "../connection-controller";
import { attachDaemonUpgradeNotice } from "../daemon-upgrade-notice";

const upgrade = {
  daemonVersion: "0.3.3",
  daemonProtocolVersion: "1.3",
  requiredProtocolVersion: "1.5",
};
const clean: SnapshotInfo = {
  state: "disconnected",
  instanceId: "test-browser",
  label: "Test",
  extensionVersion: "0.4.0",
  handshake: null,
  lastError: null,
  connectionEnabled: true,
};
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
});

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    emit: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function fixture(saved: Record<string, unknown> = {}) {
  let snapshot = { ...clean };
  let listener: (next: SnapshotInfo) => void = () => {};
  let recording = false;
  let endpoint = "local:52800";
  const action = {
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    openPopup: vi.fn(async () => {}),
  };
  const notifications = {
    create: vi.fn(async () => "bsk-daemon-upgrade-required"),
    clear: vi.fn(async () => true),
    onClicked: event<[string]>(),
    onButtonClicked: event<[string, number]>(),
  };
  const storage = {
    session: {
      get: vi.fn(async (_key: string) => ({ ...saved })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(saved, values);
      }),
    },
  };
  const tabs = { create: vi.fn(async () => ({})) };
  vi.stubGlobal("chrome", {
    action,
    notifications,
    storage,
    tabs,
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
  const notice = attachDaemonUpgradeNotice({
    controller: {
      snapshot: () => snapshot,
      subscribe: (next) => {
        listener = next;
        listener(snapshot);
        return () => {};
      },
    },
    connectionKey: () => endpoint,
    isRecording: () => recording,
  });
  disposers.push(notice.dispose);
  return {
    action,
    notifications,
    storage,
    tabs,
    notice,
    update: async (patch: Partial<SnapshotInfo>) => {
      snapshot = { ...snapshot, ...patch };
      listener(snapshot);
      await notice.refresh();
    },
    setRecording: async (value: boolean) => {
      recording = value;
      await notice.refresh();
    },
    setEndpoint: async (value: string) => {
      endpoint = value;
      await notice.refresh();
    },
  };
}

it("keeps the upgrade badge above REC, notifies once during retries, and recovers", async () => {
  const f = fixture();
  await f.update({ daemonUpgradeRequired: upgrade });
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  expect(f.action.setTitle).toHaveBeenLastCalledWith({
    title: i18n.t("popup.daemonUpgrade.toolbarTitle", { ns: "extension" }),
  });
  await f.setRecording(true);
  await f.update({ state: "connecting" });
  await f.update({ state: "disconnected" });
  await f.setRecording(false);
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  expect(f.notifications.create).toHaveBeenCalledTimes(1);
  await f.setRecording(true);
  await f.update({ state: "connected", daemonUpgradeRequired: null });
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "REC" });
  expect(f.action.setTitle).toHaveBeenLastCalledWith({ title: "BrowserSkill" });
  expect(f.notifications.clear).toHaveBeenCalledWith("bsk-daemon-upgrade-required");
  await f.setRecording(false);
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
});

it("retains deduplication across worker restarts without hiding another daemon's problem", async () => {
  const saved: Record<string, unknown> = {};
  const first = fixture(saved);
  await first.update({ daemonUpgradeRequired: upgrade });
  expect(first.notifications.create).toHaveBeenCalledTimes(1);
  first.notice.dispose();
  const second = fixture(saved);
  await second.notice.refresh();
  expect(second.notifications.clear).not.toHaveBeenCalled();
  await second.update({ daemonUpgradeRequired: upgrade });
  expect(second.notifications.create).not.toHaveBeenCalled();
  expect(second.notifications.clear).not.toHaveBeenCalled();
  expect(second.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  await second.setEndpoint("remote:server:device");
  expect(second.notifications.create).toHaveBeenCalledTimes(1);
});

it("does not label ordinary disconnection as an upgrade or notify after disabling", async () => {
  const f = fixture();
  await f.update({ lastError: "Connection refused" });
  expect(f.notifications.create).not.toHaveBeenCalled();
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  await f.update({ daemonUpgradeRequired: upgrade, connectionEnabled: false });
  expect(f.notifications.create).not.toHaveBeenCalled();
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
});

it("keeps the badge and avoids notification storms when notifications fail", async () => {
  const f = fixture();
  f.notifications.create.mockRejectedValueOnce(new Error("Notifications disabled"));
  await f.update({ daemonUpgradeRequired: upgrade });
  await f.update({ state: "connecting" });
  expect(f.notifications.create).toHaveBeenCalledTimes(1);
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
});

it("does not publish an outdated notice after a pending storage read", async () => {
  const f = fixture();
  let resolve!: (value: Record<string, unknown>) => void;
  f.storage.session.get.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  const failed = f.update({ daemonUpgradeRequired: upgrade });
  await vi.waitFor(() => expect(f.storage.session.get).toHaveBeenCalledTimes(1));
  const recovered = f.update({ state: "connected", daemonUpgradeRequired: null });
  resolve({});
  await Promise.all([failed, recovered]);
  expect(f.notifications.create).not.toHaveBeenCalled();
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
});

it("clears an outdated notification if recovery occurs while Chrome creates it", async () => {
  const f = fixture();
  let resolve!: (value: string) => void;
  f.notifications.create.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  const failed = f.update({ daemonUpgradeRequired: upgrade });
  await vi.waitFor(() => expect(f.notifications.create).toHaveBeenCalledTimes(1));
  const recovered = f.update({ state: "connected", daemonUpgradeRequired: null });
  resolve("bsk-daemon-upgrade-required");
  await Promise.all([failed, recovered]);
  expect(f.notifications.clear).toHaveBeenCalledWith("bsk-daemon-upgrade-required");
  expect(f.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
});

it("opens upgrade instructions on click, with a tab fallback on older Chromium", async () => {
  const f = fixture();
  await f.update({ daemonUpgradeRequired: upgrade });
  f.notifications.onClicked.emit("unrelated");
  expect(f.action.openPopup).not.toHaveBeenCalled();
  f.notifications.onClicked.emit("bsk-daemon-upgrade-required");
  await vi.waitFor(() => expect(f.action.openPopup).toHaveBeenCalledTimes(1));
  f.action.openPopup.mockRejectedValueOnce(new Error("Not available"));
  f.notifications.onButtonClicked.emit("bsk-daemon-upgrade-required", 0);
  await vi.waitFor(() =>
    expect(f.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://test/popup.html" }),
  );
});
