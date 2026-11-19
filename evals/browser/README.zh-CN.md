# 浏览器能力测试语料库

这里是一套供 BrowserSkill 以及各类命令行或 MCP Agent 共用的本地确定性浏览器测试环境。
case、测试页面、`bsk` 直连流程和断言都会自动发现；新增 case 不需要修改中央 `switch`。

[English](README.md)

## 核心原则

- 与 Agent 无关：prompt 只描述可观察的页面目标，同一套 case 可以被不同 Agent 和
  adapter 使用。
- 本地且确定：页面只依赖本地服务，使用稳定 marker 和按 run 隔离的事件。
- 可扩展：manifest、fixture 和 workflow 都从目录自动发现。
- 可复现：生成式页面的所有变化由 seed 决定，报告会保留 seed。
- 如实验证：页面事件、回答文本和 adapter 外部证据分别统计；拿不到的证据标为
  `unverified`，不会冒充通过。
- 隐私安全：用户 badcase 必须先缩减为合成 DOM 和匿名数据，再进入仓库。

当前有 6 个稳定的 `core` case 和 1 个 seed 驱动的 `matrix` case。30 表示浏览器操作能力
清单，并不是 case 数量；同一种操作可以在不同页面结构、时序和浏览器状态下由多个 case
重复覆盖。

## 快速使用

不启动浏览器的校验：

```sh
pnpm eval:browser validate
pnpm eval:browser list
pnpm eval:browser coverage
pnpm eval:browser:test
```

使用仓库当前代码编译 `bsk`，再跑真实 CLI、daemon、扩展、小窗和页面链路：

```sh
cargo build -p bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --suite core --bsk ./target/debug/bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --suite matrix --seed 4,7,14 --bsk ./target/debug/bsk
```

每个 smoke case 都会创建独立 session，并在 `finally` 中关闭。JSON 报告和截图输出到已被
Git 忽略的 `evals/browser/results/`。

也可以写成 `pnpm run eval:browser -- coverage`；CLI 已兼容 pnpm 传入的前导 `--`。

## 可选的 Agent PR 前自测

对浏览器交互、页面观察、控制策略或 CLI／扩展通信等较大改动，推荐在提交 PR 前运行
[BrowserSkill发版前测试](skills/browserskill-release-test/SKILL.md)。这项检查可选：未运行或遇到
环境阻塞不影响提交或合并 PR，仍需执行与改动相关的现有检查。

直接给有仓库与浏览器访问能力的 Agent 以下指令即可，不要求安装 Skill：

```text
阅读本 checkout 中的 evals/browser/skills/browserskill-release-test/SKILL.md。
使用 Bsk 对当前分支 HEAD 执行可选端到端自测。
CLI 与测试扩展从同一候选源码编译，逐步记录操作，
如实报告测试范围、失败和阻塞，不把未执行的场景算作通过。
```

Skill 包含 112 个流程／边缘／对抗靶场／回归 case，并从候选 CLI 动态发现命令覆盖 case（含 `bsk plan`、`bsk recipe`、`bsk read` 等新命令）；使用合成 HTML（含 21 个聚焦的 `ARENA-*` 高密度靶场 case：三表联动联合申报、多层 Open/Closed Shadow DOM 与同／跨源嵌套 iframe、原生 `<video>`／`<audio>` 与 WebVTT 字幕／Canvas 帧采样、SPA 水合、真实 `bfcache`、键控与槽位复用两种 5,000 行虚拟表、`oklch()`／渐变字与隐藏文本诱饵、敏感字段跨通道脱敏；以及计划／Recipe 实验室、本地视频门户、开发者论坛、多级动态嵌套菜单、双层遮罩等）与八个公网站点（巨量引擎、淘宝、哔哩哔哩视频站、V2EX 论坛站、MDN、GitHub、Books、HN），覆盖每秒变化页、活动轮播上的 `evaluate`／`read`／`wheel` 等真实链路，并以 Benchmark 形式自动统计成功率、交互轮次、每轮动作压缩比与耗时分布。全量真机浏览器执行属于单独的 Agent
引导流程（不会自动加入 `core` 或 `pnpm eval:browser`）；审计器、夹具服务器路由（`Range`、`bfcache`、门禁／流式下载、HEAD 无副作用）、场景 Schema（含 `required_argv` 参数必须存在于对应 CLI 命令）与夹具 SHA-256 清单已接入 CI（`test_release_audit.py`）自动校验。

辅助脚本需要 Python 3.9+，仅使用标准库。全量执行还需要真实 Chromium 浏览器、候选 Bsk CLI
及对应扩展；协作、录制等场景需真人参与。本地选择 runtime 路径、browser selector 和空闲端口。
PR 自测固定当前分支 HEAD；发版测试再选择指定 main／release commit。未提交改动要明确记录，
不能将其归为干净 commit 的结果。

输出放在已被忽略的 `evals/browser/results/<unique-run>/`。PR 中可选说明候选 SHA、测试范围、
失败／阻塞，并附相关脱敏证据。明确只测子集时标为部分覆盖；只有全部计划场景及发现的命令均
通过才能称全量通过，该结论不是强制 PR 审批门槛。不要提交原始浏览日志、登录截图、生产 HTML、
凭据或本机构建产物。

辅助脚本自身的检查不打开浏览器：

```sh
python3 evals/browser/skills/browserskill-release-test/scripts/test_release_audit.py
```

## Suite 与筛选

| Suite | 用途 | 默认执行 |
| --- | --- | --- |
| `core` | 日常 smoke 和 CI 使用的小而稳定的验收集 | 是 |
| `matrix` | seed 驱动的 DOM、时序、布局组合 | 显式选择 |
| `regression` | 从用户 badcase 缩减并与 issue/修复关联的回归 | 显式选择 |
| `stress` | 更高次数或更慢的边界测试 | 显式选择 |
| `manual` | 必须依赖真人或真实用户标签页的能力 | 显式选择 |

`smoke` 和 `run-agent` 不带筛选时只跑 `core`，所以以后新增 stress/badcase 不会突然拖慢
已有 CI。`list`、`coverage`、`validate` 默认检查全部语料。

```sh
pnpm eval:browser list --suite core
pnpm eval:browser list --tag form
pnpm eval:browser smoke --case form-controls
pnpm eval:browser smoke --case form-controls,generated-form
pnpm eval:browser smoke --case all
```

不同维度的筛选会叠加；逗号分隔的 suite/case 是“或”，多个 tag 必须全部命中。旧参数
`--task` 仍作为 `--case` 的兼容别名。

## 自动发现结构

```text
evals/browser/
  cases/
    core/*.case.json
    matrix/*.case.json
    regression/<case-id>/
      <case-id>.case.json
      <case-id>.fixture.mjs
      README.md
  fixtures/pages/*.fixture.mjs
  schemas/case.schema.json
  lib/
  tests/
```

- `cases/**/*.case.json` 都会作为 case manifest 加载。
- `fixtures/**/*.fixture.mjs` 和 `cases/**/*.fixture.mjs` 都会注册为页面 fixture。
- 顺序按 suite、可选的数字 `order`、id 排列。
- `validate` 会阻止重复 case id、重复路由、缺失 fixture、未知操作/action、无效 workflow
  变量，以及没有任何步骤产出的 adapter evidence。

一个 manifest 同时描述：中英文 prompt、能力 coverage、页面事件/回答/adapter 三类断言，以及
`bsk` 直连 smoke 的声明式步骤。prompt 可用 `{url}`、`{baseUrl}`、`{runId}`、`{seed}`；
workflow 可以用 `saveAs` 保存 JSON 结果，并用 `{child.tab_id}` 之类的变量引用后续步骤。

控制凭证由 workflow 显式传递。首次导航后使用
`{ "action": "sync", "saveAs": "control" }`，DOM 动作传入
`"contextId": "{control.context_id}"`，补充观察和已完成的 DOM 动作可继续复用它。
导航、调整窗口、设备模拟和仅指定偏移量的拖动，还需传入新一次同步的
`"observationId": "{control.observation_id}"`；导航后在新文档操作前须重新同步。
runner 不会自动插入同步、替换凭证或重放被拒绝的动作。固定脚本 case 验证操作能力，
持续动态内容和人工接管由专门的 cooperation 回归补充验证。
完整写法可直接参考 `cases/core/` 和 `cases/matrix/`。

## 新增普通 case

1. 新增导出 `{ id, routes, render(context) }` 的 `*.fixture.mjs`，可放共享 fixture 目录，也可
   和 regression case 放在一起。
2. 新增 `*.case.json`，写好 prompt、operation coverage、断言和 smoke steps。
3. 页面使用共享的 `browserEval.send(...)` 上报按 run 隔离的事件。
4. 执行 `pnpm eval:browser validate` 和 `pnpm eval:browser:test`。
5. 用 `smoke --case <id>` 验证真实本地编译链路。

建议一个 case 只表达一种行为或故障机制，并使用稳定的合成 marker，避免断言偶然文案。

## 把用户 badcase 固化成回归

先生成一个自包含模板：

```sh
pnpm eval:browser scaffold reported-timeout \
  --title "Navigation settles after a late frame" \
  --source "issue-123"
```

它会在 `cases/regression/reported-timeout/` 下生成 manifest、fixture 和复现说明。随后只保留
真正触发问题的 DOM 结构、时序、跳转、frame 或浏览器状态，并遵守：

- 所有姓名、账号、网址、token、截图和文案都替换为合成值。
- 不提交 HAR、cookie、凭据、生产 HTML 或私有素材。
- 记录 issue/PR 来源、相关 seed、期望行为和后续修复 PR。
- 条件允许时，证明新 case 在旧版本失败、修复版本通过。

## Seed 矩阵

`generated-form` 会确定性改变 label 关联方式、DOM 嵌套、hydration 延迟、干扰控件、字段
顺序和 element id，但任务和 oracle 保持不变：

```sh
pnpm eval:browser generate --seed user-badcase-42
pnpm eval:browser prompt generated-form --seed user-badcase-42 --run-id manual-42
pnpm eval:browser smoke --case generated-form --seed user-badcase-42
pnpm eval:browser smoke --case generated-form --seed 4,7,14
```

逗号分隔或重复的 seed 会生成相互独立的结果。任何失败都能按报告中的规范化 seed 精确重放；
若它代表独立 bug，再提升为命名 regression case。

## 测任意 Agent 与比较 CLI/MCP 配置

把 `agents.example.json` 复制为已被 Git 忽略的 `agents.local.json`，分别配置两个隔离的 Agent
profile/build。参数以数组直接传给可执行程序，不经过 shell。

```sh
pnpm eval:browser run-agent \
  --config evals/browser/agents.local.json \
  --agent codex-cli,codex-mcp \
  --suite core \
  --repeat 10
```

浏览器任务应串行运行，避免 session 竞争；更大实验中使用干净 profile 并轮换 adapter 顺序，
降低缓存偏差。

## 如何看结果

```sh
pnpm eval:browser summarize evals/browser/results/*.json
```

汇总按 adapter/variant 展示通过率、完全验证率、进程失败、错误数、平均工具调用数和耗时。
原始 JSON 会保留 case、suite、tag、seed、prompt、命令输出、页面事件数和每条 oracle 结果。

健康运行应满足：没有 timeout/非零退出，direct smoke 没有 `executionError`，验证状态为
`passed`（无法暴露外部证据的 Agent adapter 可明确为 `passed-with-unverified`），session cleanup
通过，并且错误数、调用数和耗时没有相对基线异常上涨。

## 开发基准线

后续开发统一按下面的门禁执行：

| 改动范围 | 必跑检查 |
| --- | --- |
| 任意 case、fixture、oracle 或 harness 改动 | `pnpm eval:browser:check` |
| CLI、daemon、扩展或浏览器操作改动 | 上述检查、`cargo build -p bsk`、真实浏览器 `smoke --suite core` |
| DOM 发现、表单交互、时序或等待逻辑改动 | 上述检查，再跑 `smoke --suite matrix --seed 4,7,14` |
| 修复已有明确复现的 bug | 新增 `regression` case，并在修复版本单独运行该 case |

提交这套 harness 前，完整验收命令为：

```sh
pnpm eval:browser:check
cargo build -p bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --case all --bsk ./target/debug/bsk
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --suite matrix --seed 4,7,14 --bsk ./target/debug/bsk
```

所有命令必须以 0 退出；smoke 汇总必须达到 100% pass、100% fully verified、0 execution
failure/error，结束后 `bsk session list --json` 必须为 `[]`。不能为了让回归通过而削弱 oracle
或替换稳定 marker；如果产品行为确实改变，case 与预期基线必须在同一个受审查改动中更新。

直连 smoke 自动覆盖 30 项中的 27 项。`tabs.borrow`、`tabs.return`、`assist.request-help` 需要
真实用户标签页或真人交互，因此保留在 manual lane，避免默认测试具有破坏性或不确定性。

### Fill 回归用例选项

`fill` 步骤允许空字符串 `""`，用于验证清空；`"noClear": true` 对应
`--no-clear` 追加。验证拒绝行为时可设置
`"expectError": { "code": "invalid_params", "reason": "target_not_fillable" }`。
错误码和原因必须同时匹配；超时、非法输出或意外成功仍然失败。这些选项仅用于 fill。

[编辑器根节点回归](cases/regression/fill-editor-roots/README.md)说明了共享页面、
真实浏览器断言和 CLI smoke 的运行方式。
