import { readTiledScreenshot, screenshotRoot } from "./tiles";

export const SCREENSHOT_HISTORY_LIMIT = 5;
export const SCREENSHOT_HISTORY_AGE_MS = 24 * 60 * 60 * 1000;
const POPUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep recent popup captures and exempt any still in use. Agent exports have a
 * separate lifecycle. Query current ownership only when about to delete a directory. */
export async function pruneScreenshots(
  keep: (id: string) => boolean | Promise<boolean>,
  now = Date.now(),
) {
  let root: FileSystemDirectoryHandle;
  try {
    root = await screenshotRoot();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  const entries: { id: string; createdAt: number }[] = [];
  for await (const [id, handle] of root.entries()) {
    if (handle.kind !== "directory" || !POPUP_ID.test(id)) continue;
    try {
      const shot = await readTiledScreenshot(id);
      entries.push({ id, createdAt: Number.isFinite(shot?.createdAt) ? shot!.createdAt : 0 });
    } catch (error) {
      if (error instanceof SyntaxError) entries.push({ id, createdAt: 0 });
      // A transient storage error is not evidence that a capture is corrupt.
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let retained = 0;
  let failure: unknown;
  for (const { id, createdAt } of entries) {
    if (createdAt > now - SCREENSHOT_HISTORY_AGE_MS && retained < SCREENSHOT_HISTORY_LIMIT) {
      retained++;
      continue;
    }
    try {
      if (await keep(id)) continue;
      await root.removeEntry(id, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) failure ??= error;
    }
  }
  if (failure) throw failure;
}
