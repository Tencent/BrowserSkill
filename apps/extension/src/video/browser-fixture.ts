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
