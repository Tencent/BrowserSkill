import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSkillDirectory } from "./lib/validate-skill.mjs";

const root = new URL("../", import.meta.url);
assert(
  !existsSync(new URL("skill", root)),
  "Maintain the universal skill only in crates/bsk-cli/skill",
);
const path = "crates/bsk-cli/skill";
const { files } = validateSkillDirectory(fileURLToPath(new URL(path, root)), {
  maxEntryBytes: 2_000,
});
console.log(
  `${path}: valid (${files.size} files, ${Buffer.byteLength(files.get("SKILL.md"))} entry bytes)`,
);
