import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { DEFAULT_DAEMON_WS_URL } from "./src/transport/generated/methods";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    fileParallelism: false,
    include: process.env.BSK_VIDEO_STRESS
      ? ["src/**/*.browser.test.ts", "src/**/*.bench.ts"]
      : ["src/**/*.browser.test.ts"],
    globals: false,
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
