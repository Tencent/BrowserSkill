import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Resolve the extension's own version once at config-evaluation time
// so every entrypoint sees the same string. Reading package.json this
// way avoids the "JSON-import the entire manifest into the bundle"
// trap (review M3 fix to round-1) — only the `version` field reaches
// the production bundle via Vite's `define`.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as { version: string };
const EXTENSION_VERSION = pkg.version;
const LOGO_PATH = resolve(here, "assets/logo.png");

const resolvePackageSource = (pkg: string) => resolve(here, `../../packages/${pkg}/src/index.ts`);

// browser-skill extension: MV3, talks to local bsk daemon over WebSocket.
export default defineConfig({
  srcDir: "src",
  outDir: "dist",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "BrowserSkill",
    description:
      "Let AI agents use your logged-in browser in a separate Agent Window—without interrupting your work. Powered by the bsk CLI.",
    permissions: ["alarms", "debugger", "notifications", "tabs", "storage", "windows"],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "icon/logo.png",
      32: "icon/logo.png",
      48: "icon/logo.png",
      128: "icon/logo.png",
    },
    action: {
      default_title: "BrowserSkill",
      default_icon: {
        16: "icon/logo.png",
        32: "icon/logo.png",
        48: "icon/logo.png",
        128: "icon/logo.png",
      },
    },
  },
  vite: () => ({
    plugins: [
      tailwindcss(),
      {
        name: "browser-skill-intern-logo-icon",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "icon/logo.png",
            source: readFileSync(LOGO_PATH),
          });
        },
      },
    ],
    define: {
      __BSK_EXT_VERSION__: JSON.stringify(EXTENSION_VERSION),
      __BSK_DAEMON_WS_URL__: JSON.stringify(
        process.env.BSK_DAEMON_WS_URL ?? "ws://127.0.0.1:52800",
      ),
    },
    resolve: {
      alias: {
        "@browser-skill/i18n/react": resolve(here, "../../packages/i18n/src/react.tsx"),
        "@browser-skill/i18n": resolvePackageSource("i18n"),
      },
    },
  }),
});
