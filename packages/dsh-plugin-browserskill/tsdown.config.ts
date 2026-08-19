import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { transform } from "lightningcss";
import { defineConfig, type UserConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

/**
 * Two build faces of the dual-face package:
 * - host: the Cordis tool plugin (lib/index.mjs, ESM, dsh packages external);
 * - client: the Web UI bundle (lib/client.cjs, CJS in a type:module package) in dsh's closure-factory shape —
 *   the artifact registers itself through `window.__ModuleLoader__.load`, with
 *   platform modules resolved from the loader's frozen module table and every
 *   other dependency inlined. Mirrors deepseek-harness `packages/client/tsdown.client.ts`.
 */

/** Module specifiers the dsh web shell shares into its frozen module table. */
const CLIENT_EXTERNALS: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
  "@deepseek-ai/dsh-client-runtime/client",
];

/** Wire/type layers with no shared runtime identity: safe to inline. */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand|attachment)(\/|$)/;
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/;

const CSS_VIRTUAL_PREFIX = "\0bsk-css:";
const CSS_VIRTUAL_SUFFIX = ".mjs";
// The web shell resolves client bundles from its module table by package name
// (dsh's own bundles register the same way), so this must never drift from
// package.json.
const CLIENT_ID = pkg.name;

const client: UserConfig = {
  name: `${CLIENT_ID}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Anything not in the loader module table must inline; an unanswerable
  // require() is a guaranteed runtime throw.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    "import.meta.env.MODE": JSON.stringify(process.env.NODE_ENV ?? "production"),
    "import.meta.env": JSON.stringify({ MODE: process.env.NODE_ENV ?? "production" }),
  },
  plugins: [
    {
      // Bundle purity gate: platform modules stay external, wire layers
      // inline, every other @deepseek-ai value import is a build error.
      name: "bsk-client-bundle-purity",
      resolveId(source: string) {
        if (!source.startsWith("@deepseek-ai/")) return null;
        if (CLIENT_EXTERNALS.includes(source)) return null;
        if (VENDORED_LIBRARY.test(source)) return null;
        if (INLINE_SAFE.test(source)) return null;
        throw new Error(
          `client bundle purity: "${source}" is not a platform module or an inline-safe wire layer — ` +
            "collaborate through cordis services (type-only imports are erased and never reach this gate)",
        );
      },
    },
    {
      name: "bsk-css-modules-inline",
      resolveId(source: string, importer: string | undefined) {
        // `.module.css` gets hashed class maps; `.nomodule.css` is injected
        // verbatim (minified) — used for the scope-prefixed BSK utility sheet
        // and tokens, whose selectors must survive untouched.
        if (!source.endsWith(".module.css") && !source.endsWith(".nomodule.css")) return null;
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source;
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX;
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null;
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length);
        this.addWatchFile(fileId);
        const source = await readFile(fileId);
        const isModule = fileId.endsWith(".module.css");
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          ...(isModule ? { cssModules: { pattern: "[hash]_[local]" } } : {}),
          minify: true,
        });
        const classMap: Record<string, string> = {};
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name;
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${CLIENT_ID}/${basename(fileId)}`)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(CLIENT_ID)};`,
          "  tag.dataset.pluginCss = tagId;",
          "  tag.textContent = css;",
          "  document.head.appendChild(tag);",
          "}",
          `export default ${JSON.stringify(classMap)};`,
        ].join("\n");
      },
    },
  ],
  outputOptions: {
    entryFileNames: "client.cjs",
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    outDir: "lib",
    // dsh host packages are provided by the profile the plugin is installed into.
    external: [/^@deepseek-ai\//],
  },
  client,
]);
