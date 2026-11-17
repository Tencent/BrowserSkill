import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";
import { renderSkillContent, SkillRegistry } from "@deepseek-ai/dsh-skill";
import { afterEach, describe, expect, it } from "vitest";
import { validateSkillDirectory } from "../../../scripts/lib/validate-skill.mjs";
import * as BrowserSkillPlugin from "../src/index.mjs";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const isWin = process.platform === "win32";
const exeName = isWin ? "bsk.exe" : "bsk";

function findPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
}

function writeExecutableBsk(dir: string, versionOutput = "bsk 0.5.0"): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, exeName);
  if (isWin) {
    // Copy node.exe or cmd.exe? On Windows, a tiny .cmd wrapper wouldn't match `bsk.exe`,
    // so compile-free tests on Windows can copy process.execPath only if needed; here on
    // POSIX a shell script with +x is a real executable, and on Windows a minimal PE or cmd check.
    // Wait: on Windows `spawnSync("bsk.exe", ["--version"])` needs a valid PE executable!
    // Copying `where.exe` / `hostname.exe` exits 0 or we can copy `process.execPath`?
    // `node.exe --version` prints `v22.x.x` and exits 0!
    writeFileSync(target, readFileSync(process.execPath));
  } else {
    writeFileSync(target, `#!/bin/sh\necho "${versionOutput}"\n`, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return target;
}

function pathWithoutBsk(basePath: string): string {
  return basePath
    .split(delimiter)
    .filter((dir) => {
      if (!dir.trim()) return false;
      try {
        readFileSync(join(dir, exeName));
        return false;
      } catch {
        return true;
      }
    })
    .join(delimiter);
}

describe("@wxg-prc-cpg/browser-skill-dsh-plugin end-to-end integration", () => {
  const pathKey = findPathKey(process.env);
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    BSK_INSTALL_DIR: process.env.BSK_INSTALL_DIR,
    PATH: process.env[pathKey],
  };
  const tempDirs: string[] = [];

  function makeTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "bsk-dsh-e2e-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (savedEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.HOME;
    if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedEnv.USERPROFILE;
    if (savedEnv.BSK_INSTALL_DIR === undefined) delete process.env.BSK_INSTALL_DIR;
    else process.env.BSK_INSTALL_DIR = savedEnv.BSK_INSTALL_DIR;
    process.env[pathKey] = savedEnv.PATH ?? "";

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves package identity and keeps peerDependencies free of DSH host rc locks", () => {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      name: string;
      peerDependencies: Record<string, string>;
      dsh: { bundle: { patch: string } };
    };
    const patch = readFileSync(join(pkgRoot, manifest.dsh.bundle.patch), "utf8");

    expect(BrowserSkillPlugin.name).toBe("@wxg-prc-cpg/browser-skill-dsh-plugin");
    expect(manifest.name).toBe(BrowserSkillPlugin.name);
    expect(patch).toContain(`name: "${BrowserSkillPlugin.name}"`);

    const hostLockedPeers = Object.keys(manifest.peerDependencies).filter(
      (dep) => dep === "@deepseek-ai/dsh" || dep.startsWith("@deepseek-ai/dsh-"),
    );
    expect(hostLockedPeers).toEqual([]);
  });

  it("guides on-demand bsk installation when missing, heals PATH, and switches to lean canonical skill once installed", async () => {
    const home = makeTempHome();
    const installDir = join(home, ".local", "bin");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.BSK_INSTALL_DIR = installDir;
    process.env[pathKey] = pathWithoutBsk(savedEnv.PATH ?? "");

    const canonical = validateSkillDirectory(join(repoRoot, "crates", "bsk-cli", "skill"), {
      maxEntryBytes: 2_000,
    });

    // Mount our plugin BEFORE SkillRegistry to verify Cordis `ctx.inject(["skills"])`
    // works regardless of plugin load order in cordis.patch.yml.
    const root = new Context();
    const pluginFiber = root.plugin(BrowserSkillPlugin);
    const skillFiber = root.plugin(SkillRegistry);
    await pluginFiber;
    await skillFiber;

    // 1. Default ~/.local/bin was appended to host PATH automatically.
    expect((process.env[pathKey] ?? "").split(delimiter)).toContain(installDir);

    // 2. Bundled installer --check reports missing bsk before installation.
    const installerScript = join(pkgRoot, "bin", "install-bsk.mjs");
    const checkBefore = spawnSync(process.execPath, [installerScript, "--check"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(checkBefore.status).toBe(1);

    // 3. Stale ~/.agents/skills/browser-skill in preset layer must NOT shadow the plugin,
    // and Conversation 1 receives the on-demand setup guidance because bsk is missing.
    const presetKey = { preset: "standard" };
    const presetScope = createScope(skillFiber.ctx, presetKey);
    presetScope.ctx.skills.register({
      name: "browser-skill",
      description: "Stale external skill",
      content: "Outdated instructions",
      source: "user-agents",
    });

    const agent1Key = { agent: "conv-1" };
    const agent1Scope = createScope(skillFiber.ctx, agent1Key, { parent: presetKey });
    const agent1 = { id: "conv-1", ctx: agent1Scope.ctx };
    await root.serial(scopeTarget(agent1, agent1Key), "agent/created", {
      agent: agent1,
      source: "startup",
    });

    const conv1Skill = await skillFiber.ctx.skills.get("browser-skill", { scope: agent1Key });
    expect(conv1Skill).toBeDefined();
    expect(conv1Skill?.source).toBe("bundled");
    expect(conv1Skill?.description).toBe(canonical.description);
    expect(conv1Skill?.content).toContain("## First-time setup (`bsk` CLI not detected)");
    expect(conv1Skill?.content).toContain(JSON.stringify(installerScript));
    expect(conv1Skill?.content).toContain(join(pkgRoot, "AGENT_INSTALL.md"));
    expect(conv1Skill?.content.endsWith(canonical.content)).toBe(true);

    const rendered1 = renderSkillContent(conv1Skill!);
    expect(rendered1).toContain("Base directory for this skill:");
    expect(realpathSync(conv1Skill!.resourceBase!.path)).toBe(realpathSync(join(pkgRoot, "skill")));

    // 4. After on-demand installation places `bsk` into ~/.local/bin:
    //    - `install-bsk.mjs` is idempotent and verifies the binary;
    //    - `bsk --version` resolves directly through the healed DSH host PATH;
    //    - Conversation 2 automatically receives the lean canonical SKILL.md without setup overhead.
    writeExecutableBsk(installDir, "bsk 0.5.0");

    const runIdempotentInstall = spawnSync(process.execPath, [installerScript], {
      encoding: "utf8",
      env: process.env,
    });
    expect(runIdempotentInstall.status).toBe(0);
    expect(runIdempotentInstall.stdout).toContain("already installed");
    expect(runIdempotentInstall.stdout).toContain("bsk doctor");

    const directBsk = spawnSync(exeName, ["--version"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(directBsk.status).toBe(0);

    const agent2Key = { agent: "conv-2" };
    const agent2Scope = createScope(skillFiber.ctx, agent2Key, { parent: presetKey });
    const agent2 = { id: "conv-2", ctx: agent2Scope.ctx };
    await root.serial(scopeTarget(agent2, agent2Key), "agent/created", {
      agent: agent2,
      source: "startup",
    });

    const conv2Skill = await skillFiber.ctx.skills.get("browser-skill", { scope: agent2Key });
    expect(conv2Skill?.content).toBe(canonical.content);
    expect(conv2Skill?.content).not.toContain("First-time setup");

    await agent2Scope.dispose();
    await agent1Scope.dispose();
    await presetScope.dispose();
    await pluginFiber.dispose();
    await skillFiber.dispose();
  });

  it("prepends configured bskPath directory to PATH and unwinds it on plugin dispose", async () => {
    const home = makeTempHome();
    const customDir = join(home, "custom-bsk");
    const customBin = writeExecutableBsk(customDir, "bsk 0.5.0-custom");

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.BSK_INSTALL_DIR = join(home, ".local", "bin");
    process.env[pathKey] = pathWithoutBsk(savedEnv.PATH ?? "");

    const root = new Context();
    const skillFiber = root.plugin(SkillRegistry);
    const pluginFiber = root.plugin(BrowserSkillPlugin, {
      bskPath: `~/custom-bsk/${exeName}`,
    });
    await skillFiber;
    await pluginFiber;

    expect((process.env[pathKey] ?? "").split(delimiter)[0]).toBe(customDir);
    expect(BrowserSkillPlugin.resolveBskExecutable(`~/custom-bsk/${exeName}`)).toBe(customBin);

    const globalSkill = await skillFiber.ctx.skills.get("browser-skill");
    expect(globalSkill?.source).toBe("bundled");
    expect(globalSkill?.content).not.toContain("First-time setup");

    await pluginFiber.dispose();
    expect((process.env[pathKey] ?? "").split(delimiter)).not.toContain(customDir);
    await skillFiber.dispose();
  });

  it("executes bundled platform installer via bin/install-bsk.mjs when bsk is absent and verifies installed binary", () => {
    const home = makeTempHome();
    const installDir = join(home, ".local", "bin");
    const isolatedPkg = makeTempHome();
    mkdirSync(join(isolatedPkg, "bin"), { recursive: true });
    writeFileSync(
      join(isolatedPkg, "bin", "install-bsk.mjs"),
      readFileSync(join(pkgRoot, "bin", "install-bsk.mjs")),
    );
    writeFileSync(join(isolatedPkg, "AGENT_INSTALL.md"), "# Guide\n");

    if (isWin) {
      writeFileSync(
        join(isolatedPkg, "install.ps1"),
        `$dir = $env:BSK_INSTALL_DIR\nNew-Item -ItemType Directory -Force -Path $dir | Out-Null\nCopy-Item -LiteralPath "${process.execPath.replace(/"/g, '""')}" -Destination (Join-Path $dir "bsk.exe")\n`,
      );
    } else {
      writeFileSync(
        join(isolatedPkg, "install.sh"),
        '#!/bin/sh\nset -eu\nmkdir -p "$BSK_INSTALL_DIR"\nprintf \'#!/bin/sh\\necho "bsk 0.5.0-installed"\\n\' > "$BSK_INSTALL_DIR/bsk"\nchmod 0755 "$BSK_INSTALL_DIR/bsk"\n',
        { mode: 0o755 },
      );
    }

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.BSK_INSTALL_DIR = installDir;
    process.env[pathKey] = pathWithoutBsk(savedEnv.PATH ?? "");

    const runInstall = spawnSync(process.execPath, [join(isolatedPkg, "bin", "install-bsk.mjs")], {
      cwd: home,
      encoding: "utf8",
      env: process.env,
    });
    expect(runInstall.status).toBe(0);
    expect(runInstall.stdout).toContain("Verified");
    expect(runInstall.stdout).toContain(join(installDir, exeName));
    expect(runInstall.stdout).toContain("AGENT_INSTALL.md");
  });
});
