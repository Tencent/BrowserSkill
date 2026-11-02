// Check the target's own root, then its hosts: closed shadow roots are not
// reachable via host.shadowRoot. DOM focus remains meaningful in background tabs.
export const FOCUS_CHECK = `function() {
  if (!this.isConnected) return false;
  let element = this;
  while (element) {
    const root = element.getRootNode();
    if (root.activeElement !== element) return false;
    element = root.host;
  }
  return true;
}`;
