# 浏览器能力测试语料库

这里是一套供 BrowserSkill、DSH 以及其他命令行 Agent 共用的本地确定性浏览器测试环境。
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

当前有 6 个稳定的 `core` case 和 1 个 seed 驱动的 `matrix` case。28 表示浏览器操作能力
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

## 测任意 Agent 与比较 28/6 工具

把 `agents.example.json` 复制为已被 Git 忽略的 `agents.local.json`，分别配置两个隔离的 Agent
profile/build。参数以数组直接传给可执行程序，不经过 shell。

```sh
pnpm eval:browser run-agent \
  --config evals/browser/agents.local.json \
  --agent dsh-granular,dsh-domain \
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
| CLI、daemon、扩展、DSH 插件或浏览器操作改动 | 上述检查、`cargo build -p bsk`、真实浏览器 `smoke --suite core` |
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

直连 smoke 自动覆盖 28 项中的 25 项。`tabs.borrow`、`tabs.return`、`assist.request-help` 需要
真实用户标签页或真人交互，因此保留在 manual lane，避免默认测试具有破坏性或不确定性。
