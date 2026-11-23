/** Chrome can activate a background window when native input opens a page.
 * Restore a previously focused Chrome window only for an observed task popup.
 * This is recovery after activation, not a guarantee against transient focus.
 * Never activate Chrome when the user was working in another application. */
export function watchPopupFocus(windowId: number) {
  const windows = globalThis.chrome?.windows;
  if (!windows?.getAll) return { arm() {}, async finish(_restore: () => boolean) {} };
  let focused = -1;
  let revision = 0;
  let state: chrome.windows.Window["state"];
  let before: { focused: number; state: typeof state } | undefined;
  let userSwitched = false;
  let taskActivated = false;
  const onFocus = (id: number) => {
    // Some Linux window managers emit WINDOW_ID_NONE between Chrome windows.
    // An activation followed by WINDOW_ID_NONE needs a fresh focus check.
    if (before && id === windowId) taskActivated = true;
    if (before && id >= 0 && id !== windowId && id !== focused) userSwitched = true;
    focused = id;
    revision++;
  };
  const onBounds = (window: chrome.windows.Window) => {
    if (window.id === windowId) state = window.state;
  };
  windows.onFocusChanged.addListener(onFocus);
  windows.onBoundsChanged.addListener(onBounds);
  void windows
    .getAll()
    .then((all) => {
      if (revision === 0) focused = all.find((window) => window.focused)?.id ?? -1;
      state ??= all.find((window) => window.id === windowId)?.state;
    })
    .catch(() => {});
  return {
    arm() {
      // Missing focus disables recovery. Reading window state must not delay
      // input dispatch or extend the popup observation interval.
      before ??= { focused, state };
    },
    async finish(restore: () => boolean) {
      try {
        if (
          !restore() ||
          !before ||
          userSwitched ||
          before.focused < 0 ||
          before.focused === windowId ||
          !taskActivated ||
          (focused !== windowId && focused !== -1)
        )
          return;
        const expected = revision;
        const previous = await windows.get(before.focused).catch(() => undefined);
        if (!previous || expected !== revision || !restore()) return;
        if (focused === -1) {
          const task = await windows.get(windowId).catch(() => undefined);
          if (!task?.focused || expected !== revision || !restore()) return;
        }
        if (before.state === "minimized") {
          // Minimize the window Chrome just restored; this does not select a
          // user tab or bring a different application into the foreground.
          await windows.update(windowId, { state: "minimized" });
        } else {
          await windows.update(before.focused, { focused: true });
        }
      } catch (error) {
        console.debug("[bsk] could not restore focus after task popup", error);
      } finally {
        windows.onFocusChanged.removeListener(onFocus);
        windows.onBoundsChanged.removeListener(onBounds);
      }
    },
  };
}
