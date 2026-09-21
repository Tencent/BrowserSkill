import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { validateSkillDirectory } from "../packages/dsh-plugin-browserskill/scripts/validate-skill.mjs";

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

test("checks the DSH tool contract in deferred files as well as the entry point", (t) => {
  for (const reference of ["Run bsk click", "```sh\ncommand\n```", "browser_unknown({})"]) {
    const root = fixture(t, {
      "SKILL.md": `${metadata}browser_session [details](references/details.md)`,
      "references/details.md": reference,
    });
    assert.throws(() => validateSkillDirectory(root, { browserTools: ["browser_session"] }));
  }
});
