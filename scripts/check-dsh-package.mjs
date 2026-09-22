// Run after the plugin build. Inspect an actual npm archive, then load its runtime
// from an unrelated directory with a fake runner (no browser/daemon side effects).
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DSH_BROWSER_TOOLS,
  validateSkillDirectory,
} from "../packages/dsh-plugin-browserskill/scripts/validate-skill.mjs";

const pkg = fileURLToPath(new URL("../packages/dsh-plugin-browserskill/", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "bsk-package-"));
const cwd = process.cwd();
const disposers = [];
try {
  const [archive] = JSON.parse(
    // The shell launches npm.cmd on Windows. Pass paths through npm's config
    // environment so spaces and shell metacharacters remain literal path bytes.
    execSync("npm pack --ignore-scripts --json", {
      cwd: pkg,
      encoding: "utf8",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !/^npm_config_(?:cache|pack_destination)$/i.test(name),
          ),
        ),
        npm_config_cache: join(temp, "npm-cache"),
        npm_config_pack_destination: temp,
      },
    }),
  );
  execFileSync("tar", ["-xzf", join(temp, archive.filename), "-C", temp]);
  const unpacked = join(temp, "package");
  const options = { maxEntryBytes: 4_500, browserTools: DSH_BROWSER_TOOLS };
  const original = validateSkillDirectory(join(pkg, "skill"), options);
  const packed = validateSkillDirectory(join(unpacked, "skill"), options);
  assert.deepEqual(packed.files, original.files, "npm must ship every skill resource unchanged");
  // Supply the installed peer dependencies, while executing the actual packed JS.
  symlinkSync(join(pkg, "node_modules"), join(unpacked, "node_modules"), "junction");
  process.chdir(temp);
  const { apply } = await import(pathToFileURL(join(unpacked, "lib/index.mjs")).href);
  let skill;
  const ctx = {
    tools: { register: () => () => {} },
    get: (name) =>
      name === "skills"
        ? {
            register: (value) => {
              skill = value;
              return () => {};
            },
          }
        : undefined,
    inject: () => {},
    effect: (factory) => disposers.push(factory()),
  };
  apply(
    ctx,
    { observationEnabled: false, lazyTools: false },
    {
      runnerFactory: () => ({
        run: async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false, aborted: false }),
        killAll() {},
        killFor: () => 0,
      }),
      startJournal: { records: new Map(), save() {}, release() {} },
    },
  );
  assert.equal(skill.name, packed.name);
  assert.equal(skill.description, packed.description);
  assert.equal(skill.content, packed.content, "embedded body must match the authored entry point");
  assert.equal(skill.resourceBase.kind, "directory");
  assert.equal(
    fileURLToPath(pathToFileURL(skill.resourceBase.path)).replace(/[\\/]$/, ""),
    realpathSync(join(unpacked, "skill")),
  );
  for (const [path, content] of packed.files) {
    assert.equal(readFileSync(join(skill.resourceBase.path, path), "utf8"), content);
    if (path.startsWith("references/"))
      assert(!skill.content.includes(content.trim()), "references must stay deferred");
  }
  console.log(
    `npm bundle verified: ${packed.files.size} skill files; runtime resources resolve outside the repository`,
  );
} finally {
  try {
    await Promise.all(disposers.map((dispose) => dispose()));
  } finally {
    process.chdir(cwd);
    rmSync(temp, { recursive: true, force: true });
  }
}
