/** Check the debugger methods and event listeners used by the extension. */
export function hasChromeDebugger(): boolean {
  const api = typeof chrome === "undefined" ? undefined : chrome.debugger;
  return (
    typeof api?.attach === "function" &&
    typeof api.detach === "function" &&
    typeof api.sendCommand === "function" &&
    [api.onEvent, api.onDetach].every(
      (event) =>
        typeof event?.addListener === "function" && typeof event.removeListener === "function",
    )
  );
}
