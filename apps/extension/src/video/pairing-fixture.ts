import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Bundle a test entry only; the installed background remains unchanged. */
export async function buildPairingFixture(directory: string, version: string): Promise<string> {
  const input = path.join(directory, "pairing-entry.js");
  await writeFile(
    input,
    `import { verifyLocalPairing } from '@/transport/pairing-verifier';
     import { getOrCreateInstanceId } from '@/lib/instance-id';
     export async function pair(link) {
       return verifyLocalPairing(link, await getOrCreateInstanceId(),
         chrome.runtime.getURL('').replace(/\\/$/, ''));
     }`,
  );
  const require = createRequire(import.meta.url);
  const { build } = await import(require.resolve("vite", { paths: [require.resolve("vitest")] }));
  const bundle = await build({
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": path.resolve("src") } },
    define: {
      __BSK_EXT_VERSION__: JSON.stringify(version),
      __BSK_DAEMON_WS_URL__: JSON.stringify("ws://127.0.0.1:52800"),
    },
    build: {
      write: false,
      lib: { entry: input, formats: ["iife"], name: "PairingFixture" },
    },
  });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  return result.output[0].code;
}
