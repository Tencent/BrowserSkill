// Shared source/package validation. No dependencies, so it also runs in release CI.
import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function validateSkillDirectory(directory, { maxEntryBytes, browserTools } = {}) {
  const root = resolve(directory);
  const files = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert(!entry.name.startsWith("."), `Hidden skill resource: ${path}`);
      if (entry.isDirectory()) walk(path);
      else {
        assert(entry.isFile(), `Skill resources must be regular files: ${path}`);
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
      }
    }
  }
  walk(root);
  const source = files.get("SKILL.md");
  assert(source, `Missing SKILL.md in ${root}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  assert(frontmatter, `Missing frontmatter in ${root}`);
  const name = /^name: (.+)$/m.exec(frontmatter[1])?.[1].trim();
  const description = /^description: (.+(?:\n[ \t]+[^\n]+)*)/m
    .exec(frontmatter[1])?.[1]
    .replace(/^[|>]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  assert(name === "browser-skill" && description, `Invalid skill metadata in ${root}`);
  if (maxEntryBytes) {
    assert(
      Buffer.byteLength(source) <= maxEntryBytes,
      `SKILL.md exceeds ${maxEntryBytes} byte budget: ${root}`,
    );
  }
  const linked = new Set();
  const mentionedTools = new Set();
  for (const [file, content] of files) {
    if (!file.endsWith(".md")) continue;
    for (const [, href] of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(href)) continue;
      const path = resolve(dirname(join(root, file)), href.split("#")[0]);
      const local = relative(root, path);
      assert(
        !isAbsolute(local) && !local.split(sep).includes(".."),
        `Link escapes skill: ${file}: ${href}`,
      );
      assert(lstatSync(path).isFile(), `Broken skill link: ${file}: ${href}`);
      if (file === "SKILL.md") linked.add(local.split(sep).join("/"));
    }
    if (browserTools) {
      assert(!/\bbsk\b/i.test(content), `DSH skill exposes internal CLI: ${file}`);
      assert(
        !/```(?:bash|sh|shell)\b/i.test(content),
        `DSH skill contains shell commands: ${file}`,
      );
      for (const tool of content.match(/\bbrowser_[a-z][a-z_]*\b/g) ?? []) {
        assert(browserTools.includes(tool), `Unsupported DSH tool ${tool} in ${file}`);
        mentionedTools.add(tool);
      }
    }
  }
  for (const file of files.keys()) {
    if (file.startsWith("references/"))
      assert(linked.has(file), `Reference not routed from SKILL.md: ${file}`);
  }
  for (const tool of browserTools ?? [])
    assert(mentionedTools.has(tool), `DSH skill omits ${tool}`);
  return { name, description, content: `${source.slice(frontmatter[0].length).trim()}\n`, files };
}

export const DSH_BROWSER_TOOLS = [
  "browser_session",
  "browser_page",
  "browser_inspect",
  "browser_interact",
  "browser_tabs",
  "browser_assist",
];
