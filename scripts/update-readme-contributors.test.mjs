import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  fetchContributors,
  updateReadmes,
  verifyContributorChanges,
} from "./update-readme-contributors.mjs";

const names = ["README.md", "README.zh-CN.md"];
const empty = "<!-- CONTRIBUTORS:START -->\n<!-- CONTRIBUTORS:END -->";
const person = (id, login = `user-${id}`) => ({ id, login, type: "User" });
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "bsk-contributors-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const directory = pathToFileURL(`${path}/`);
  for (const name of names)
    await writeFile(new URL(name, directory), `# ${name}\n\n${empty}\n\nKeep this footer.\n`);
  return directory;
}

test("preserves prose and account order; repeat/reordered API results are a no-op", async (t) => {
  const directory = await fixture(t);
  await updateReadmes([person(20), person(10)], directory);
  const first = await readFile(new URL(names[0], directory), "utf8");
  assert.ok(first.startsWith("# README.md\n\n"));
  assert.ok(first.endsWith("\n\nKeep this footer.\n"));
  const file = new URL(names[0], directory);
  const before = await stat(file);
  const unchanged = await updateReadmes([person(10), person(20), person(10)], directory);
  assert.deepEqual(unchanged.changed, []);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await updateReadmes([person(5), person(20), person(10, "renamed")], directory);
  const updated = await readFile(file, "utf8");
  assert.deepEqual(
    [...updated.matchAll(/githubusercontent.com\/u\/(\d+)\?/g)].map((m) => Number(m[1])),
    [10, 20, 5],
  );
  assert.match(updated, /alt="renamed"/);
});

test("filters bots/anonymous authors and rejects empty or malformed data without writing", async (t) => {
  const directory = await fixture(t);
  const result = await updateReadmes(
    [person(1), { ...person(2), type: "Bot" }, { type: "Anonymous" }],
    directory,
  );
  assert.equal(result.count, 1);
  const before = await Promise.all(names.map((name) => readFile(new URL(name, directory), "utf8")));
  for (const data of [[], {}, [person(-1)], [person(1, '"><script>')]]) {
    await assert.rejects(updateReadmes(data, directory));
  }
  assert.deepEqual(
    await Promise.all(names.map((name) => readFile(new URL(name, directory), "utf8"))),
    before,
  );
});

test("validates both marker pairs before changing either README", async (t) => {
  const directory = await fixture(t);
  const first = await readFile(new URL(names[0], directory), "utf8");
  for (const invalid of [
    "No markers",
    `${empty}\n${empty}`,
    "<!-- CONTRIBUTORS:END --><!-- CONTRIBUTORS:START -->",
  ]) {
    await writeFile(new URL(names[1], directory), invalid);
    await assert.rejects(updateReadmes([person(1)], directory), /exactly one/);
    assert.equal(await readFile(new URL(names[0], directory), "utf8"), first);
  }
});

test("authenticates each API page and fails closed after a later-page error", async () => {
  const calls = [];
  const data = await fetchContributors({
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () =>
          calls.length === 1 ? Array.from({ length: 100 }, (_, i) => person(i + 1)) : [person(101)],
      };
    },
  });
  assert.equal(data.length, 101);
  assert.match(calls[1].url, /page=2$/);
  assert.ok(calls.every(({ options }) => options.headers.Authorization === "Bearer test-token"));
  let page = 0;
  await assert.rejects(
    fetchContributors({
      token: "do-not-print",
      fetchImpl: async () =>
        ++page === 1
          ? { ok: true, json: async () => Array.from({ length: 100 }, (_, i) => person(i + 1)) }
          : { ok: false, status: 403 },
    }),
    (error) => error.message.includes("403") && !error.message.includes("do-not-print"),
  );
  assert.equal(page, 2);
});

test("push guard permits contributor changes and refuses unrelated branch/worktree edits", async (t) => {
  const directory = await fixture(t);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
  await updateReadmes([person(1)], directory);
  assert.doesNotThrow(() => verifyContributorChanges("HEAD", undefined, directory));
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "avatars");
  assert.doesNotThrow(() => verifyContributorChanges("HEAD~", "HEAD", directory));
  const path = new URL(names[0], directory);
  await writeFile(path, `Unrelated edit\n${await readFile(path, "utf8")}`);
  assert.throws(
    () => verifyContributorChanges("HEAD", undefined, directory),
    /outside contributor blocks/,
  );
  git("restore", "README.md");
  await writeFile(new URL("unrelated.txt", directory), "not an avatar");
  git("add", "unrelated.txt");
  assert.throws(() => verifyContributorChanges("HEAD", undefined, directory), /unrelated.txt/);
});
