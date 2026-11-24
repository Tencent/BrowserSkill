import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("summarize accepts an unexpanded report wildcard", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "bsk reports "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ["one.json", "two.json"]) {
    await writeFile(join(cwd, name), JSON.stringify({ results: [{ adapter: "bsk-direct" }] }));
  }
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
  const rows = JSON.parse(
    execFileSync(process.execPath, [cli, "summarize", "*.json", "--json"], {
      cwd,
      encoding: "utf8",
    }),
  );
  assert.equal(rows[0].runs, 2);
});
