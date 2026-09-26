# BrowserSkill

<p align="center">
  <img src="docs/assets/browserskill-readme-banner.png" alt="BrowserSkill — 将 AI Agent 连接到你的浏览器" />
</p>

<p align="center">
  <strong>让 AI Agent 在你已登录的浏览器里工作，你继续做自己的事。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#网站调试">网站调试</a> ·
  <a href="#deepseek-harness-插件">DSH 插件</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

**BrowserSkill 把你的 AI Agent 连接到 Chrome 或 Microsoft Edge，直接使用你已有的登录状态。** 你可以让它读取页面、填写表单、完成网站操作、截取长图，也可以让它调查某个请求为什么失败。任务在独立、可见的 **Agent Window（代理窗口）** 中运行；需要操作已有标签页时，显式借用，任务结束后归还。

Cursor、Claude Code、Codex、OpenClaw、CodeBuddy、WorkBuddy、Pi、Hermes Agent 等能调用 Shell 的 Agent，都可以通过 `bsk` CLI 使用。**DeepSeek Harness** 还提供专用插件，直接使用浏览器工具并查看任务预览。Agent 和模型由你选择，BrowserSkill 负责连接浏览器。

## 能做什么

| 能力 | 你可以用它做什么 |
| --- | --- |
| **使用已有账号工作** | 复用浏览器登录态，读取文档、搜索内部网站、填写表单，完成需要登录的网站流程。 |
| **看得见的浏览器任务** | 给 Agent 一个独立窗口，需要时借用已有标签页；遇到登录、验证等步骤，可以由你接手。 |
| **读取、操作与截图** | 读取页面文本和控件，点击、输入、管理标签页，截取可见区域或完整页面，在本地模式上传和下载文件。 |
| **带着证据调试网站** | 把操作与请求、响应正文、控制台和页面变化关联起来，检查性能、慢接口与疑似重复请求，用明确配置的 HTTP 规则或请求重放验证问题。 |
| **选对浏览器和账号** | 为浏览器实例命名，让任务绑定指定 Profile；也可以让服务器上的 Agent 连接你电脑上的浏览器。 |
| **回看任务过程** | 重新打开浏览器本地的调试历史、导出 JSON，或单独开启操作审计，查看任务执行记录。 |

看看 Agent 如何完成一次浏览器任务：

https://github.com/user-attachments/assets/db782c92-b1d4-4aae-a255-039675937a90

## 快速开始

本地自动化需要 **AI Agent + `bsk` CLI + 浏览器扩展**。CLI 自带后台守护进程（daemon），skill 则负责告诉 Agent 如何使用这些工具。

| 组件 | 支持环境 |
| --- | --- |
| CLI / daemon | macOS：Apple Silicon、Intel；Linux：x64、ARM64；Windows：x64 |
| 浏览器扩展 | 基于 Chromium 125 或更新版本的 Chrome、Microsoft Edge。其他 Chromium 浏览器可能可用，但不保证兼容。 |
| Agent 接入 | 能调用 Shell 的 Agent 配合 BrowserSkill skill，或 DeepSeek Harness 配合 [DSH 插件](#deepseek-harness-插件)。 |

### 让 Agent 帮你安装

把下面这句话发给 Agent：

```text
按照 https://raw.githubusercontent.com/Tencent/BrowserSkill/main/AGENT_INSTALL.md 的说明，在本机安装并配置 browser-skill。
```

安装指南会引导 Agent 安装 CLI、选择对应的 skill 或 DSH 插件、检查连接，并完成第一次浏览器任务。你仍需在想使用的浏览器中安装扩展：

**[安装 Chrome 扩展](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi)** · **[安装 Edge 扩展](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg)**

<details>
<summary><b>手动安装步骤</b></summary>

#### 1. 安装 CLI

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
export PATH="${BSK_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
```

默认安装到 `~/.local/bin`。在实际使用工具的终端或 Agent 环境中检查：

```sh
bsk --version
```

如果已启动的 Agent 找不到 `bsk`，重启 Agent 以加载新的 PATH，或配置安装后二进制的绝对路径。

#### 2. 连接扩展

从 [Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi) 或 [Edge 加载项商店](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg) 安装扩展。打开弹窗，开启本地连接，在 CLI 启动后检查连接状态。

#### 3. 给 Agent 安装 skill

```sh
bsk install-skill
```

按 **空格** 选择使用的 Agent，按 **Enter** 安装。非交互安装时显式指定目标，例如：

```sh
bsk install-skill --harness cursor --json
```

用 `bsk install-skill --list` 查看支持的目标和安装路径。已有安装默认跳过，只有显式使用 `--force` 才会覆盖。其他 Agent 可将完整的 [`crates/bsk-cli/skill/`](crates/bsk-cli/skill/) 目录复制到其 skill 目录下，命名为 `browser-skill/`，保留其中的 `references/`。

DSH 用户安装 [插件](#deepseek-harness-插件) 即可，插件已包含 skill。

#### 4. 验证连接

```sh
bsk doctor
```

解决失败项，确认扩展显示**已连接**。再开启一个新的 Agent 会话，确认能发现 `browser-skill`；doctor 通过并不代表 Agent 已加载 skill。

</details>

### 试一个任务

连接成功后，对 Agent 说：

```text
使用 browser-skill 打开 https://example.com，总结页面内容，完成后结束浏览器会话。
```

Agent 应打开代理窗口、读取页面、返回总结，并结束任务。支持 skill 斜杠命令的 Agent，也可以通过 `/browser-skill` 调用。

<details>
<summary><b>直接试用 CLI</b></summary>

先创建会话，记下返回的 `session_id`：

```sh
bsk session start --no-focus --json
```

将下面每条命令中的 `<id>` 替换为该值。有多个浏览器连接时，在创建会话时用 `--browser <实例 ID 或名称>` 选择目标。

```sh
bsk navigate https://example.com --session <id>
bsk observe --session <id>
bsk screenshot --session <id> --out example.png
bsk session stop <id>
```

通过 `bsk --help` 或 `bsk <命令> --help` 查看参数。完成或失败后都应结束会话；借用的标签页会归还到原窗口。

</details>

如果 Agent 沙盒会在每条命令后回收后台进程，请使用[沙盒配置指南](docs/sandboxed-agents.md)：在宿主环境保持 daemon 运行，Agent 通过共享的 `BSK_HOME` 和 `BSK_AUTO_START=0` 连接。

## DeepSeek Harness 插件

[DSH 插件](packages/dsh-plugin-browserskill/README.md) 在 DeepSeek Harness Web UI 中提供原生 `browser_*` 工具、浏览器任务预览和截图结果。它使用同一套 `bsk` CLI 与扩展，并自带 BrowserSkill skill。

安装好 DeepSeek Harness、pnpm 和 `bsk`，连接扩展后，将插件加入你的 profile：

```sh
dsh plugin --profile web add @wxg-prc-cpg/browser-skill-dsh-plugin
dsh --profile web
```

将 `web` 替换为自己的 profile 名称。确保启动 DSH 的环境能通过 PATH 找到 `bsk`，或配置插件的 `bskPath`。在对话中调用 `/browser-skill` 并描述任务即可，无需再执行 `bsk install-skill`。

[插件使用与配置](packages/dsh-plugin-browserskill/README.md) · [npm 包](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

## 网站调试

**让 Agent 看到问题发生时的浏览器证据。** 在你有权调试的网站上，先开启采集，再复现问题，随后在扩展中查看，或交给 Agent 分析。

- **沿着操作找原因**：查看一次操作关联的请求、控制台输出、表单字段值，以及即时或延后的页面变化；既记录 Agent 操作，也记录受支持的手动操作。
- **展开请求看细节**：读取已保留的请求头、提交数据、响应正文、耗时与错误，筛选流量或直接查看某个 JSON 字段。
- **检查性能和接口**：查看页面加载指标、接口耗时统计和疑似重复请求；缺失或不完整的数据会明确标记。
- **验证并保留证据**：配置任务内的请求修改、拦截、模拟响应或同源请求重放，导出 JSON，供后续复查和分享。

例如可以这样交代任务：

```text
使用 browser-skill 排查 http://localhost:3000 的表单保存失败问题。复现前开启网站调试，检查请求、响应和控制台，最后导出调试证据并结束会话。
```

也可以在扩展中打开**快捷功能 → 网站调试**，对已有任务启动采集。调试页将操作时间线、请求、控制台、页面状态、性能和 API 分析放在一起。任务结束后，即使没有连接 daemon，仍可打开历史查看记录；新的 Agent 任务需要你提供导出的文件，才能分析已结束任务的历史。

请求重放会使用页面当前会话发送一次新请求，可能改变服务端数据。采集和脱敏均有限制，保存的证据仍可能包含敏感信息。完整流程、CLI 示例及限制见[网站调试指南](docs/website-debugging.md)。

## 更多用法

### 截取完整页面

打开**快捷功能 → 长截图**，选择自动滚动、手动滚动拼接长图或截取可见区域。这个扩展功能无需连接 Agent 或 daemon，也可以独立使用。

对 Agent 会话中的页面，可以执行：

```sh
bsk screenshot --session <id> --full-page --out page.png
```

Agent 截图支持后台标签页，无需将窗口切到前台；原文档仍可访问时，完成后会恢复滚动位置。长截图沿页面文档滚动，嵌套滚动面板和虚拟列表存在支持限制。详见[长截图指南](docs/long-screenshot.md)。

### 使用指定浏览器 Profile

在目标 Profile 的扩展弹窗中点击**复制此 Profile 的指令**，将指令和任务一起发给 Agent。也可以设置唯一的**浏览器名称**，再显式选择：

```sh
bsk browsers
bsk session start --browser "工作账号" --no-focus --json
```

这个名称由你在 BrowserSkill 中设置，不会自动读取 Chrome 的 Profile 名称。每个会话固定使用选定的实例。详见[Profile 选择指南](docs/browser-profiles.md)。

### Agent 在服务器，浏览器在本机

保留本机浏览器和登录态，让 Agent、CLI 与 daemon 在服务器运行。扩展通过经过鉴权的 WSS 与服务器配对，由浏览器主动建立连接，本机无需开放入站端口。

内置服务端支持设备配对、续期和撤销授权。远程模式目前不支持文件上传和下载。详见[远程连接指南](docs/remote-extension-connection.md)。

## 浏览器控制与隐私

代理窗口共享所选 Profile 的登录态，**它不是独立账号，也不是安全沙盒**。Agent 可以使用已登录网站授予的权限执行操作，请选择你信任的 Agent 和任务。

扩展提供两个默认开启、相互独立的**自动化设置**：

| 设置 | 控制什么 |
| --- | --- |
| **借用标签页前确认** | Agent 接管你已有的标签页之前，先请求确认。关闭后允许免确认借用。 |
| **允许请求人工协助** | 允许 Agent 请你处理登录、验证或其他需要本人参与的步骤。 |

浏览器中保存的设置对已有和新建会话生效。旧的 `--unattended`、`tab borrow --no-confirm`、`BSK_REQUEST_HELP=off` 不能覆盖这些设置。关闭人工协助不代表待处理步骤已经完成。关闭代理窗口可以停止其中的任务。

BrowserSkill 没有必须使用的云服务，也不收集产品遥测。自动化结果交给你选定的 daemon 或网关，以及使用它的 Agent；对应 Agent 或服务可能按自身政策处理或保留数据。扩展不会自行调用 AI 提供商。

| 可选历史记录 | 保存位置 | 需要知道的事 |
| --- | --- | --- |
| **网站调试** | 当前浏览器配置中，远程模式也一样 | 保存采集到的数据，包括可获取的正文和字段值。已停止记录 30 天后过期，保留预算为 50 条／50 MiB，达到限制时可能提前清理。删除记录前需先停止采集。 |
| **操作审计** | daemon 所在主机的 `BSK_HOME/audit` | 默认关闭。记录任务与操作元数据，不记录输入值、页面正文、截图或文件内容。已结束任务 30 天后过期。 |

两者均可导出和删除。结束任务或断开连接不会删除已保存的历史，过期记录会在访问历史或执行清理时处理。导出的文件、Agent 或网关已经收到的副本需要另行管理。调试数据会过滤已知敏感信息，但不能保证完全脱敏。

[隐私政策](apps/extension/PRIVACY.zh-CN.md) · [操作审计](docs/operation-audit.md) · [调试历史与保留限制](docs/website-debugging.md#history-and-export)

## 升级

先结束正在执行的浏览器任务，再更新 CLI：

```sh
bsk update --yes
```

默认本地配置下，这条命令会在 daemon 继续服务的同时安装新版本并检查它能否运行，然后用新版本重启 daemon。重启后的 daemon 没有就绪时，会放回旧版本并用它重启 daemon。如果使用安装脚本替换了二进制，请随后执行 `bsk daemon restart`。

由 `bsk` 在后台启动的 daemon 还会每 30 分钟检查一次新版本。没有 Agent 会话时，它按同样方式安装新版本，再用新版本启动一个 daemon，等新 daemon 开始响应后才退出。新 daemon 退出，或 20 秒内没有就绪时，当前 daemon 会放回旧版本，在原端口继续服务，6 小时后再尝试这个版本。交接期间浏览器连接会短暂断开并自动重连。通过 `--foreground` 启动的 daemon 归所在终端或进程管理器管理，只提示新版本，请按下方步骤升级。bsk 无法在可执行文件所在目录写入时，也只提示新版本，请用原来的安装脚本或包管理器升级。设置 `BSK_AUTO_UPDATE=off` 可关闭 daemon 自动升级，手动 `bsk update` 仍然可用。

`bsk doctor` 会显示最近一次更新的结果；bsk home 下的 `update-state.json` 记录了它的阶段、结果和错误原因。更新确认成功前，旧版本会以 `.bsk.old-*`（Windows 上为 `.bsk.exe.old-*`）的名字留在新版本旁边；仍在运行的旧版本会保留到对应进程退出，之后再启动 daemon 时会清理。Windows 上的自更新依赖重命名正在运行的可执行文件，NTFS 支持这一操作；文件系统不支持时，更新会失败，已安装的版本保持不变。bsk 支持 Windows 10 和 Windows Server 2016 及以上版本。

扩展通过浏览器商店更新。DSH 插件需要单独更新，完成后重启对应 profile：

```sh
dsh plugin --profile web update @wxg-prc-cpg/browser-skill-dsh-plugin --latest
```

通过 `bsk --version`、`bsk status` 和 `bsk doctor` 检查版本与连接。使用新功能时，保持 CLI、正在运行的 daemon、扩展和可选 DSH 插件版本匹配。本 README 介绍当前仓库的能力，商店版本可能因审核而滞后；已发布内容以[更新日志](CHANGELOG.md)和 [Releases](https://github.com/Tencent/BrowserSkill/releases) 为准。

受管理的 CLI skill 在文件未被修改时，会随 daemon 启动、`session start` 或 `doctor` 自动同步；本地修改和自定义 skill 会保留。开启新的 Agent 会话以加载更新后的指令，doctor 会提示暂停同步的安装。

<details>
<summary><b>自定义端口、沙盒宿主和远程服务器</b></summary>

在 daemon 所属宿主或进程管理器中停止服务，执行 `bsk update --yes --no-restart-daemon`，再使用原参数与 `BSK_HOME` 启动。管理期间，在 Agent 命令中设置 `BSK_AUTO_START=0`。具体步骤见[沙盒](docs/sandboxed-agents.md)或[远程连接](docs/remote-extension-connection.md)指南。

</details>

## 文档导航

| 你想做什么 | 文档 |
| --- | --- |
| 让 Agent 安装并验证连接 | [安装指南](AGENT_INSTALL.md) |
| 排查网站或接口问题 | [网站调试](docs/website-debugging.md) |
| 截取长页面 | [长截图](docs/long-screenshot.md) |
| 使用指定账号或 Profile | [浏览器 Profile](docs/browser-profiles.md) |
| 连接服务器上的 Agent | [远程浏览器连接](docs/remote-extension-connection.md) |
| 在沙盒中使用 | [沙盒环境配置](docs/sandboxed-agents.md) |
| 回看任务操作元数据 | [操作审计](docs/operation-audit.md) |
| 接入 DeepSeek Harness | [DSH 插件](packages/dsh-plugin-browserskill/README.md) |
| 了解项目实现 | [架构](docs/architecture.md) · [协议](crates/bsk-protocol/README.md) |

## 面向开发者

项目使用 Rust + pnpm workspace。源码构建需要 Rust stable、Node.js 22，以及 `package.json` 声明的 pnpm 版本：

```sh
pnpm install --frozen-lockfile
cargo build --release --locked
pnpm ext:build
```

CLI 产物位于 `target/release/`；将 `apps/extension/dist/chrome-mv3/` 作为解压后的扩展加载。开发扩展时使用 `pnpm ext:dev`。

| 目录 | 内容 |
| --- | --- |
| `crates/bsk-cli` | CLI、daemon 和内置 Agent skill |
| `crates/bsk-protocol` | 通信类型与 JSON Schema |
| `apps/extension` | 浏览器自动化、调试工作区和扩展界面 |
| `packages/dsh-plugin-browserskill` | DeepSeek Harness 集成 |
| `packages/ui`、`packages/i18n`、`packages/vom` | 共享 UI、多语言和页面观察 |
| `evals/browser` | 本地测试页面与浏览器能力评测 |

相关检查包括 `cargo test --workspace --locked`、`pnpm ext:test` 和 `pnpm lint`。可复现的浏览器用例见[评测指南](evals/browser/README.zh-CN.md)。欢迎通过 [GitHub Issues](https://github.com/Tencent/BrowserSkill/issues) 报告问题，或提交聚焦的 PR；附上浏览器证据前，请移除敏感数据。

扩展界面支持英语、简体中文、繁体中文、韩语、日语、法语、意大利语、西班牙语、德语和巴西葡萄牙语。翻译贡献见[多语言说明](packages/i18n/README.md)。

## 许可证

[MIT](LICENSE)
