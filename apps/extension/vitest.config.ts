import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { DEFAULT_DAEMON_WS_URL } from "./src/transport/generated/methods";

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
    pool: "threads",
    globals: false,
    setupFiles: ["./src/vitest-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit-node",
          environment: "node",
          include: ["src/transport/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts", "src/**/*.bench.ts", "src/**/*.live.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "unit-dom",
          environment: "happy-dom",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: [
            "src/transport/**/*.test.ts",
            "src/**/*.browser.test.ts",
            "src/**/*.bench.ts",
            "src/**/*.live.test.ts",
          ],
        },
      },
    ],
  },
  define: {
    __BSK_EXT_VERSION__: JSON.stringify(pkg.version),
    __BSK_DAEMON_WS_URL__: JSON.stringify(process.env.BSK_DAEMON_WS_URL ?? DEFAULT_DAEMON_WS_URL),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@browser-skill/i18n/react": path.resolve(__dirname, "../../packages/i18n/src/react.tsx"),
      "@browser-skill/i18n": path.resolve(__dirname, "../../packages/i18n/src/index.ts"),
    },
  },
});
