import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Mirror wxt.config.ts's version-injection so unit tests see the same
// `__BSK_EXT_VERSION__` define the production build will inline (review
// M3 fix to round-1). Pull from `package.json` once so a release bump
// stays in lockstep across runtime, build, and tests.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
    setupFiles: ["./src/vitest-setup.ts"],
  },
  define: {
    __BSK_EXT_VERSION__: JSON.stringify(pkg.version),
    __BSK_DAEMON_WS_URL__: JSON.stringify(process.env.BSK_DAEMON_WS_URL ?? "ws://127.0.0.1:52800"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@browser-skill/i18n/react": path.resolve(__dirname, "../../packages/i18n/src/react.tsx"),
      "@browser-skill/i18n": path.resolve(__dirname, "../../packages/i18n/src/index.ts"),
    },
  },
});
