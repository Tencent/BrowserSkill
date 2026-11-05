import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "target/cooperation-preview"));
if (process.platform === "win32") throw new Error("This preview launcher targets macOS/Linux");
if (existsSync(output))
  throw new Error(`Preserving existing preview; choose a new output directory: ${output}`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
run("cargo", ["build", "--release", "--locked"]);
run("pnpm", ["ext:build"], { env: { ...process.env, BSK_DAEMON_WS_URL: "ws://127.0.0.1:52917" } });
run("pnpm", ["--filter", "@wxg-prc-cpg/browser-skill-dsh-plugin", "build"]);

mkdirSync(join(output, "bin"), { recursive: true });
mkdirSync(join(output, "libexec"));
copyFileSync(join(root, "target/release/bsk"), join(output, "libexec/bsk"));
cpSync(join(root, "apps/extension/dist/chrome-mv3"), join(output, "extension"), {
  recursive: true,
});
cpSync(join(root, "crates/bsk-cli/skill"), join(output, "skill"), { recursive: true });
copyFileSync(join(root, "docs/shared-browser-control.zh-CN.md"), join(output, "设计与验证.md"));
const plugin = join(root, "packages/dsh-plugin-browserskill");
run("npm", ["pack", "--ignore-scripts", "--pack-destination", output], { cwd: plugin });
const version = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).version;
const archive = `wxg-prc-cpg-browser-skill-dsh-plugin-${version}.tgz`;
if (!existsSync(join(output, archive))) throw new Error("Plugin archive was not created");

writeFileSync(
  join(output, "bin/bsk"),
  `#!/bin/sh
PREVIEW_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export BSK_HOME="$PREVIEW_DIR/runtime"
export BSK_AUTO_UPDATE=off
export BSK_AUTO_START=0
exec "$PREVIEW_DIR/libexec/bsk" "$@"
`,
);
writeFileSync(
  join(output, "启动体验版.command"),
  `#!/bin/sh
PREVIEW_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$PREVIEW_DIR/bin/bsk" daemon start --foreground --port 52917
`,
);
chmodSync(join(output, "bin/bsk"), 0o755);
chmodSync(join(output, "libexec/bsk"), 0o755);
chmodSync(join(output, "启动体验版.command"), 0o755);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
writeFileSync(
  join(output, "build.json"),
  JSON.stringify(
    { version, commit, dirty, platform: process.platform, arch: process.arch, port: 52917 },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(output, "README.md"),
  `# 人机协作体验版

构建基线：${commit}${dirty ? "（含未提交改动）" : ""}。本包使用独立端口 52917，运行数据保存在本目录的 runtime 中。

## 启动

1. 双击“启动体验版.command”，保持终端窗口打开。
2. 打开浏览器扩展管理页，启用开发者模式，选择“加载已解压的扩展”，选择本目录下的 extension 文件夹。体验时停用旧版扩展，避免两个版本同时显示页面控件。若复用了旧扩展的设置，将本地连接端口改为 52917。
3. 使用下面的 CLI 路径；不要混用全局旧版 CLI：

   ${join(output, "bin/bsk")}

结束体验时关闭这个终端、停用体验扩展，再启用旧扩展即可。正式版 Daemon 和运行目录不会被这套启动脚本替换。

## 让 Agent 开始

普通 CLI Agent：使用本目录 skill/SKILL.md 和上面的完整 CLI 路径，直接给出业务任务即可。无需在任务里额外要求人机协作；运行时默认启用，Skill 指导 Agent 同步、等待和继续。

打开任务页后，页面会出现协作控件，提供暂停与交回操作。你可以直接点页面，不必先暂停；编辑输入框时 Agent 会等待，点离输入框或点“交给 Agent”后继续。

## DSH 插件

本目录包含 ${archive}。在你要体验的 profile 中安装此本地包：

    dsh plugin --profile web add '${join(output, archive)}'

将该 profile 的 BrowserSkill 插件配置 bskPath 指向 '${join(output, "bin/bsk")}'，保留其余已有配置。重新启动该 profile，加载 /browser-skill，直接给出任务即可；新会话默认协作，无需要求 Agent 开启。对应工具是 bsk_session 的 share、sync、wait-user、cooperation-status；操作时传 contextId。

## 验证范围

真实浏览器验收检查人工误操作后纠正、人工编辑/输入法保持、iframe、导航、人工提前完成和重复调用；服务器独立检查每个任务只产生一次正确提交。详见“设计与验证.md”和 evidence 目录（若已附带）。

这是默认开启协作的体验版本。脚本、上传下载、长截图、设备模拟及浏览器管理复用原有能力，并在产生影响前检查最新控制权。已经发给浏览器的操作无法撤回，未知结果必须重新核对。封闭 Shadow DOM、纯画布及复杂编辑器需要后续专项验证。
`,
);
console.log(`Preview ready: ${output}`);
