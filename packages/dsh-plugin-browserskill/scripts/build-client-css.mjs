#!/usr/bin/env node
/**
 * Build the scoped BrowserSkill-UI utility sheet for the dsh client bundle.
 *
 * The overlay reuses @browser-skill/ui components (shadcn-style, Tailwind v4
 * utility classes). Those classes need a stylesheet — but a global utility
 * sheet inside the dsh page would collide with the host UI, so the compiled
 * output is scope-prefixed under `.bsk-obs` (the overlay root class):
 *   1. tailwindcss compiles the utilities used by packages/ui + our client;
 *   2. postcss-prefix-selector nests every rule under .bsk-obs.
 * Token values themselves live in src/client/bsk-tokens.nomodule.css
 * (hand-mirrored from packages/ui/src/styles/tailwind.css).
 *
 * Output: src/client/bsk-ui.nomodule.css (gitignored build artifact).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import prefixer from "postcss-prefix-selector";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const input = join(pkgRoot, ".bsk-ui.input.css");
const rawOut = join(pkgRoot, ".bsk-ui.raw.css");
const finalOut = join(pkgRoot, "src/client/bsk-ui.nomodule.css");

// The canonical sheet can't be imported directly (its own `@import
// "tailwindcss"` must resolve from a package that has it), so we inline the
// canonical @theme block read from packages/ui at build time.
const canonical = readFileSync(join(pkgRoot, "..", "ui", "src", "styles", "tailwind.css"), "utf8");
const themeBlock = canonical.match(/@theme inline \{[\s\S]*?\n\}/)?.[0];
if (themeBlock === undefined) throw new Error("canonical @theme inline block not found");
writeFileSync(
  input,
  [
    '@import "tailwindcss";',
    "@custom-variant dark (&:is(.dark *));",
    themeBlock,
    '@source "../ui/src";',
    '@source "./src/client";',
    "",
  ].join("\n"),
);

execFileSync(
  process.execPath,
  [
    join(pkgRoot, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs"),
    "-i",
    input,
    "-o",
    rawOut,
  ],
  { cwd: pkgRoot, stdio: "inherit" },
);

const result = await postcss([
  prefixer({
    prefix: ".bsk-obs",
    transform(prefix, selector, prefixedSelector) {
      // Root-level anchors collapse onto the scope root itself.
      if (selector === ":root" || selector === "html" || selector === "body") return prefix;
      if (selector.startsWith(prefix)) return selector;
      return prefixedSelector;
    },
  }),
]).process(readFileSync(rawOut, "utf8"), { from: rawOut });

mkdirSync(dirname(finalOut), { recursive: true });
writeFileSync(finalOut, result.css);
console.log(`bsk-ui sheet: ${result.css.length} bytes -> ${finalOut}`);
