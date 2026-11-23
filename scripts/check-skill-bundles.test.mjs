import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateSkillDirectory } from "./lib/validate-skill.mjs";

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "bsk-skill-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const metadata =
  "---\nname: browser-skill\ndescription: |\n  Read pages and\n  fill forms.\n---\n\n";

test("validates metadata and linked resources without injecting their bodies", (t) => {
  const root = fixture(t, {
    "SKILL.md": `${metadata}[details](references/details.md)`,
    "references/details.md": "Conditional instructions",
  });
  const skill = validateSkillDirectory(root, { maxEntryBytes: 500 });
  assert.equal(skill.description, "Read pages and fill forms.");
  assert.equal(skill.content, "[details](references/details.md)\n");
  assert.equal(skill.files.size, 2);
});

test("LF and CRLF multiline metadata agree without changing resource bytes", (t) => {
  for (const style of ["|", ">"]) {
    for (const newline of ["\n", "\r\n"]) {
      const files = {
        "SKILL.md": `${metadata.replace("description: |", `description: ${style}`)}[details](references/details.md)\n\nBody\n`,
        "references/details.md": "Instructions\nSecond line\n",
      };
      for (const name of Object.keys(files)) files[name] = files[name].replaceAll("\n", newline);
      const root = fixture(t, files);
      const skill = validateSkillDirectory(root);
      assert.equal(skill.name, "browser-skill");
      assert.equal(skill.description, "Read pages and fill forms.");
      for (const [name, source] of Object.entries(files)) {
        assert.equal(skill.files.get(name), source);
        assert.deepEqual(readFileSync(join(root, name)), Buffer.from(source));
      }
    }
  }
});

test("canonical skill package validates in LF and CRLF checkouts", (t) => {
  const maxEntryBytes = 2_000;
  const original = validateSkillDirectory(
    fileURLToPath(new URL("../crates/bsk-cli/skill", import.meta.url)),
    { maxEntryBytes },
  );
  for (const newline of ["\n", "\r\n"]) {
    const files = Object.fromEntries(
      [...original.files].map(([name, content]) => [name, content.replace(/\r?\n/g, newline)]),
    );
    const skill = validateSkillDirectory(fixture(t, files), { maxEntryBytes });
    assert.equal(skill.name, original.name);
    assert.equal(skill.description, original.description);
    assert.deepEqual(Object.fromEntries(skill.files), files);
  }
});

test("rejects missing, escaping and unrouted resources", (t) => {
  for (const [body, resources] of [
    ["[missing](references/missing.md)", {}],
    ["[escape](../outside.md)", {}],
    ["No routing", { "references/forgotten.md": "Hidden instructions" }],
  ]) {
    assert.throws(() =>
      validateSkillDirectory(fixture(t, { "SKILL.md": metadata + body, ...resources })),
    );
  }
});

test("enforces entry point budget independently of reference size", (t) => {
  const root = fixture(t, {
    "SKILL.md": `${metadata}[details](references/details.md)`,
    "references/details.md": "detail\n".repeat(1000),
  });
  assert.doesNotThrow(() => validateSkillDirectory(root, { maxEntryBytes: 500 }));
  assert.throws(() => validateSkillDirectory(root, { maxEntryBytes: 10 }), /budget/);
});
