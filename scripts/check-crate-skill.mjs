import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateSkillDirectory } from "../packages/dsh-plugin-browserskill/scripts/validate-skill.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { files } = validateSkillDirectory(`${root}crates/bsk-cli/skill`, { maxEntryBytes: 7_000 });
const packaged = new Set(
  execFileSync("cargo", ["package", "--list", "--allow-dirty", "--locked", "-p", "bsk"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/),
);
for (const file of files.keys())
  assert(packaged.has(`skill/${file}`), `Cargo package omits skill/${file}`);
assert(
  packaged.has("src/skill_install/legacy-digests.txt"),
  "Cargo package omits legacy migration data",
);
console.log(`Cargo package includes all ${files.size} canonical skill files and migration data`);
