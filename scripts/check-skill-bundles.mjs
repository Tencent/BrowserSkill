import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DSH_BROWSER_TOOLS,
  validateSkillDirectory,
} from "../packages/dsh-plugin-browserskill/scripts/validate-skill.mjs";

const root = new URL("../", import.meta.url);
assert(
  !existsSync(new URL("skill", root)),
  "Maintain the universal skill only in crates/bsk-cli/skill",
);
for (const [path, maxEntryBytes, browserTools] of [
  ["crates/bsk-cli/skill", 7_000],
  ["packages/dsh-plugin-browserskill/skill", 4_500, DSH_BROWSER_TOOLS],
]) {
  const { files } = validateSkillDirectory(fileURLToPath(new URL(path, root)), {
    maxEntryBytes,
    browserTools,
  });
  console.log(
    `${path}: valid (${files.size} files, ${Buffer.byteLength(files.get("SKILL.md"))} entry bytes)`,
  );
}
