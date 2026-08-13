import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  outDir: "lib",
  // dsh host packages are provided by the profile the plugin is installed into.
  external: [/^@deepseek-ai\//],
});
