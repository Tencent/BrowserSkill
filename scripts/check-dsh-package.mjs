// Run after building `@wxg-prc-cpg/browser-skill-dsh-plugin`.
// Packs the actual npm tarball, unpacks it outside the repository, verifies
// every bundled skill/installer asset byte-for-byte against the canonical repo
// sources, and exercises the packed plugin inside a real Cordis + SkillRegistry runtime.
import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSkillDirectory } from "./lib/validate-skill.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const pkgDir = join(repoRoot, "packages", "dsh-plugin-browserskill");
const pkgRequire = createRequire(join(pkgDir, "package.json"));
const canonicalSkillDir = join(repoRoot, "crates", "bsk-cli", "skill");
const temp = mkdtempSync(join(tmpdir(), "bsk-dsh-package-"));
const originalCwd = process.cwd();

let skillFiber;
let pluginFiber;

try {
  const packResult = JSON.parse(
    execSync("npm pack --ignore-scripts --json", {
      cwd: pkgDir,
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
  const [archive] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  assert(typeof archive?.filename === "string", "npm pack did not return an archive");

  execFileSync("tar", ["-xzf", join(temp, archive.filename), "-C", temp]);
  const unpacked = join(temp, "package");

  const options = { maxEntryBytes: 2_000 };
  const canonical = validateSkillDirectory(canonicalSkillDir, options);
  const packed = validateSkillDirectory(join(unpacked, "skill"), options);
  assert.deepEqual(
    packed.files,
    canonical.files,
    "npm tarball must ship every canonical crates/bsk-cli/skill resource unchanged",
  );

  for (const rootAsset of ["install.sh", "install.ps1", "AGENT_INSTALL.md", "LICENSE"]) {
    assert.deepEqual(
      readFileSync(join(unpacked, rootAsset)),
      readFileSync(join(repoRoot, rootAsset)),
      `npm tarball must ship ${rootAsset} unchanged`,
    );
  }
  assert.deepEqual(
    readFileSync(join(unpacked, "cordis.patch.yml")),
    readFileSync(join(pkgDir, "cordis.patch.yml")),
    "npm tarball must ship cordis.patch.yml unchanged",
  );

  symlinkSync(join(pkgDir, "node_modules"), join(unpacked, "node_modules"), "junction");
  process.chdir(temp);

  const { Context } = await import(pathToFileURL(pkgRequire.resolve("@deepseek-ai/cordis")).href);
  const { SkillRegistry } = await import(
    pathToFileURL(pkgRequire.resolve("@deepseek-ai/dsh-skill")).href
  );
  const packedPlugin = await import(pathToFileURL(join(unpacked, "lib/index.mjs")).href);

  const root = new Context();
  skillFiber = root.plugin(SkillRegistry);
  pluginFiber = root.plugin(packedPlugin);
  await skillFiber;
  await pluginFiber;

  const skill = await skillFiber.ctx.skills.get("browser-skill");
  assert(skill, "packed plugin must register browser-skill in SkillRegistry");
  assert.equal(skill.name, packed.name);
  assert.equal(skill.description, packed.description);
  assert(
    skill.content.endsWith(packed.content),
    "registered body must end with canonical SKILL.md body",
  );
  assert.equal(skill.resourceBase.kind, "directory");
  assert.equal(
    realpathSync(skill.resourceBase.path),
    realpathSync(join(unpacked, "skill")),
    "resourceBase must resolve inside unpacked npm package, never repository source",
  );

  for (const [relPath, content] of packed.files) {
    assert.equal(readFileSync(join(skill.resourceBase.path, relPath), "utf8"), content);
    if (relPath.startsWith("references/")) {
      assert(!skill.content.includes(content.trim()), "references must stay deferred");
    }
  }

  const probe = spawnSync(process.execPath, [join(unpacked, "bin/install-bsk.mjs"), "--check"], {
    cwd: temp,
    encoding: "utf8",
  });
  assert(
    probe.status === 0 || probe.status === 1,
    `bundled install-bsk.mjs --check failed unexpectedly: ${probe.stderr}`,
  );

  console.log(
    `npm bundle verified: ${packed.files.size} canonical skill files + installer assets resolved outside repository`,
  );
} finally {
  try {
    if (pluginFiber) await pluginFiber.dispose();
    if (skillFiber) await skillFiber.dispose();
  } finally {
    process.chdir(originalCwd);
    rmSync(temp, { recursive: true, force: true });
  }
}
