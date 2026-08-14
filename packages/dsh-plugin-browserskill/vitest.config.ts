import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    server: {
      deps: {
        // dsh client packages ship ESM with CSS imports; run them through the
        // transform pipeline (where CSS is stubbed) instead of Node's loader.
        inline: [/@deepseek-ai\//],
      },
    },
  },
});
