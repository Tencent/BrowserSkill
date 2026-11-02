// Removes saved tab groups left behind by BrowserSkill 0.4.0 and earlier.
// Chrome persists closed tab groups as bookmarks on the bookmarks bar;
// the extension no longer creates these groups (0.4.1+), but existing
// ones are never deleted automatically. This cleans them up on startup.

export async function cleanupOrphanedBrowserSkillTabGroups(): Promise<void> {
  if (typeof chrome?.bookmarks?.search !== "function") return;
  try {
    const results = await chrome.bookmarks.search({ title: "BrowserSkill" });
    for (const node of results) {
      if (node.id) {
        try {
          await chrome.bookmarks.removeTree(node.id);
        } catch {
          try {
            await chrome.bookmarks.remove(node.id);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch (err) {
    console.warn("[browser-skill] failed to clean up orphaned tab groups", err);
  }
}
