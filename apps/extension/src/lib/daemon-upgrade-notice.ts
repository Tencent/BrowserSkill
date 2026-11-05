import { i18n } from "@browser-skill/i18n";
import type { ConnectionController, SnapshotInfo } from "./connection-controller";

const NOTIFICATION_ID = "bsk-daemon-upgrade-required";
const NOTIFIED_KEY = "daemonUpgradeNotifications";

interface UpgradeNoticeOptions {
  controller: Pick<ConnectionController, "subscribe" | "snapshot">;
  /** Public endpoint identity only; never include a remote credential. */
  connectionKey: () => string;
  isRecording: () => boolean;
}

/** One owner for the shared toolbar badge, plus a notice once per browser session. */
export function attachDaemonUpgradeNotice(options: UpgradeNoticeOptions) {
  let snapshot = options.controller.snapshot();
  let disposed = false;
  let badge = "";
  let notificationNeedsClear = false;
  let pending = Promise.resolve();
  const notified = new Set<string>();

  const copy = (key: "title" | "toolbarTitle" | "notificationMessage" | "notificationButton") =>
    i18n.t(`popup.daemonUpgrade.${key}`, { ns: "extension" });

  const currentIssue = () => (snapshot.connectionEnabled ? snapshot.daemonUpgradeRequired : null);
  const issueKey = () => {
    const issue = currentIssue();
    return issue
      ? JSON.stringify([
          options.connectionKey(),
          snapshot.extensionVersion,
          issue.daemonVersion,
          issue.daemonProtocolVersion,
          issue.requiredProtocolVersion,
        ])
      : null;
  };

  async function render() {
    if (disposed) return;
    const issue = currentIssue();
    const text = issue ? "!" : options.isRecording() ? "REC" : "";
    const title = issue ? copy("toolbarTitle") : "BrowserSkill";
    const signature = JSON.stringify([text, title]);
    if (badge !== signature) {
      // Commit only after success so a transient API failure can recover.
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
      await chrome.action.setBadgeText({ text });
      await chrome.action.setTitle({ title });
      badge = signature;
    }

    const key = issueKey();
    if (!key) {
      // A new MV3 worker starts without a handshake. That is not evidence
      // that a previous upgrade problem has gone away.
      if (notificationNeedsClear) {
        await chrome.notifications.clear(NOTIFICATION_ID);
        notificationNeedsClear = false;
      }
      return;
    }
    if (notified.has(key)) return;
    // Mark before asynchronous work: a reconnect or failed notification must
    // not produce a storm. Session storage survives MV3 worker suspension.
    notified.add(key);
    let seen: string[] = [];
    try {
      const saved = (await chrome.storage.session.get(NOTIFIED_KEY))[NOTIFIED_KEY];
      if (Array.isArray(saved)) seen = saved.filter((value) => typeof value === "string");
      if (seen.includes(key)) return;
      if (disposed || issueKey() !== key) {
        notified.delete(key);
        return;
      }
      await chrome.storage.session.set({ [NOTIFIED_KEY]: [...seen.slice(-31), key] });
    } catch {
      // The toolbar and popup remain useful even if session storage is unavailable.
    }
    if (disposed || issueKey() !== key) return;
    await chrome.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/logo.png"),
      title: copy("title"),
      message: copy("notificationMessage"),
      buttons: [{ title: copy("notificationButton") }],
    });
    // An update or disable may finish while Chrome is creating the notice.
    if (disposed || issueKey() !== key) await chrome.notifications.clear(NOTIFICATION_ID);
  }

  function refresh() {
    // Serialize Chrome writes so an older REC update cannot erase the warning.
    pending = pending.then(render).catch((error) => {
      console.debug("[bsk upgrade notice] update failed", error);
    });
    return pending;
  }

  const showInstructions = (id: string) => {
    if (id !== NOTIFICATION_ID) return;
    void (async () => {
      try {
        // Available on newer Chromium; older supported versions use a tab.
        await chrome.action.openPopup();
      } catch {
        await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
      }
      await chrome.notifications.clear(NOTIFICATION_ID);
    })().catch((error) => console.debug("[bsk upgrade notice] open failed", error));
  };
  const onButtonClicked = (id: string, index: number) => {
    if (index === 0) showInstructions(id);
  };
  chrome.notifications.onClicked.addListener(showInstructions);
  chrome.notifications.onButtonClicked.addListener(onButtonClicked);
  const unsubscribe = options.controller.subscribe((next) => {
    const previouslyRequired = currentIssue();
    snapshot = next;
    if (
      (previouslyRequired && !currentIssue()) ||
      !snapshot.connectionEnabled ||
      snapshot.state === "connected" ||
      snapshot.state === "version_skew"
    ) {
      notificationNeedsClear = true;
    }
    refresh();
  });
  i18n.on("languageChanged", refresh);

  return {
    refresh,
    dispose() {
      disposed = true;
      unsubscribe();
      i18n.off("languageChanged", refresh);
      chrome.notifications.onClicked.removeListener(showInstructions);
      chrome.notifications.onButtonClicked.removeListener(onButtonClicked);
    },
  };
}
