import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export type BrowserSend = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

/** Chrome may also start built-in extension workers named background.js. Match
 * the fixture manifest instead of accidentally attaching to a component worker. */
export async function attachVideoBackground(send: BrowserSend, name: string) {
  let found: { sessionId: string; origin: string } | undefined;
  await expect
    .poll(
      async () => {
        const { targetInfos } = await send<{
          targetInfos: { targetId: string; url: string; type: string }[];
        }>("Target.getTargets");
        for (const target of targetInfos) {
          if (target.type !== "service_worker" || !target.url.startsWith("chrome-extension://"))
            continue;
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          });
          try {
            const reply = await send<{ result: { value?: string } }>(
              "Runtime.evaluate",
              {
                expression: "chrome.runtime.getManifest().name",
                returnByValue: true,
              },
              sessionId,
            );
            if (reply.result.value === name) {
              found = { sessionId, origin: target.url.split("/").slice(0, 3).join("/") };
              return true;
            }
          } finally {
            if (found?.sessionId !== sessionId)
              await send("Target.detachFromTarget", { sessionId });
          }
        }
        return false;
      },
      { timeout: 15_000, message: `Wait for extension background: ${name}` },
    )
    .toBe(true);
  return found!;
}

/** Evidence is best effort: its failure must never replace the regression's result. */
export async function saveVideoEvidence(
  name: string,
  details: unknown,
  video?: string | Uint8Array | (() => Promise<Uint8Array>),
) {
  const directory = process.env.BSK_VIDEO_ARTIFACTS;
  if (!directory) return;
  try {
    await mkdir(directory, { recursive: true });
    // Save the MP4 first, even if diagnostic metadata cannot be serialized.
    const destination = path.join(directory, `${name}.mp4`);
    if (typeof video === "function") await writeFile(destination, await video());
    else if (typeof video === "string") await copyFile(video, destination);
    else if (video) await writeFile(destination, video);
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(details, null, 2));
  } catch (error) {
    console.warn(`Could not save video evidence ${name}:`, error);
  }
}
