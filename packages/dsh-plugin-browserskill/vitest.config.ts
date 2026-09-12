import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
// @browser-skill/ui ships raw source and peers on react ^19, while the dsh
// shell — and therefore the production client bundle, where react is
// external — runs react 18. Pin every react import in tests to this
// package's react 18 copy, or elements created inside ui components come out
// as react-19 "transitional" elements that the react-18 renderer rejects.
const reactDir = path.dirname(require.resolve("react/package.json"));
const reactDomDir = path.dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  resolve: {
    alias: {
      react: reactDir,
      "react-dom": reactDomDir,
    },
  },
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
