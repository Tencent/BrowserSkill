---
name: browserskill-release-test
description: 使用 Bsk 执行 BrowserSkill 的 PR 前可选端到端自测、发版全量测评与多轮 Benchmark：验证当前分支或指定候选构建，覆盖复杂 HTML、边缘场景、八大真实公网网站（含轮播、电商、视频网站、论坛社区、文档与 SPA）及全部动态发现的 CLI 命令（含 bsk plan、bsk recipe、bsk read 等），保存逐步证据并统计运行成功率、交互轮次、动作压缩比与耗时分布。不用于普通网页浏览。
---

# BrowserSkill 发版前测试与真实场景 Benchmark

用真实浏览器行为评估候选版本。交付可复查的完整证据、覆盖矩阵、Benchmark 统计（成功率、交互轮次、每轮动作压缩比、耗时分布）、缺陷清单及测试结论。**100% 是全量通过的判定标准，不是预先保证的测试结果，也不是强制 PR 门槛。**

较大改动提交 PR 前推荐运行；不是提交或合并 PR 的强制要求，不替代现有单测和检查。未运行或存在环境阻塞时如实说明，不据此要求阻止 PR。全量通过的判定仍要求所有必测项通过；明确请求局部自测时可只执行相关项，但报告必须标为部分覆盖，不能缩小全量分母。

可直接让 Agent 阅读本仓库中的本文件；也可将整个 `browserskill-release-test` 目录复制到宿主支持的技能目录后按名称调用。脚本和资源相对本 Skill 定位，无需修改用户的内置 `browser-skill`。

## 不可省略的约束

- 所有浏览器读取、输入、批量计划（`bsk plan`）、流程回放（`bsk recipe`）、有界 DOM 读取（`bsk read`）、脚本、截图、调试、录制、标签操作都经过本轮固定构建的 **Bsk**。不能用 Playwright、CDP、CUA、其他浏览器 MCP 或直接 HTTP 抓取页面代做。shell 可编译、启动本地合成服务器、调用 Bsk、解析产物；图片/视频工具可检查 Bsk 产物。
- 阅读候选仓库的 `crates/bsk-cli/skill/SKILL.md`、`docs/recipes.md` 及对应 references，确保操作规范与候选匹配；不得凭本技能编造命令参数。
- 按 [candidate-setup.md](references/candidate-setup.md) 选择候选：PR 自测默认当前分支 HEAD；发版测指定 release commit 或固定的 main SHA。CLI 与独立命名扩展来自同一源码，固定 browser 并核对 build/文件哈希。本轮中途换版本必须新开完整一轮。测试安装按用户要求保留供复查。
- 业务操作前读取页面。target 政策 DOM 动作及 `bsk plan` 使用返回的 context；evaluate、已有页面的 navigate/back/forward/reload、视觉或首步无目标动作还使用 fresh sync 的**顶层 observation_id**。strict 独立会话每次重新 sync。不能猜 refs、补造 receipt 或用关闭 guard 消除失败。
- 轮播保持运行。不得暂停、冻结 DOM、隐藏动画、注入 CSS 或换后端使巨量引擎/淘宝的 active 测试通过。`observation_changed` 等错误原样留证；判断实际原因，不把用户猜测直接写成已证实缺陷。
- 每秒变化页和轮播页都必须独立测 evaluate、`read` 与 wheel，包含即时及跨更新周期的规划延迟、实际滚动和持续更新核验，按 [dynamic-pages.md](references/dynamic-pages.md) 执行。不能只在静态页测过命令就给动态页打勾。
- **必测新引入命令与边缘场景**：
  - `bsk plan`：验证单次 sync 后多步表单/级联控件/步骤级 `expect`/内嵌 `wait-for-element`/`--until-visible` 的单轮次批量执行，以及中段 `expect` 失败、等待超时、无目标动作位置约束的精确停机（`stopped`、`not_run`、`effect_state`）。
  - `bsk recipe`（测试环境默认由 `release_audit.py` 开启 `BSK_RECIPES=1`）：验证 `draft -> save -> list -> show -> run -> rm` 全生命周期、良性页面漂移（`ids/order/late/popup/rerender`）下的零模型轮次回放、多 `segments` 跨页执行，以及语义漂移下的安全交接（`status: "handoff"`，连续 3 次同位偏离标为 `stale`）与高风险提交步骤拒止（`commit` step 拒绝保存）。
  - `bsk read`：验证零 JS 注入的有界 DOM 读取（`--selector`、`--ref`、`--fields-json`、`--max-nodes`、`--max-bytes`）。
  - 边缘场景：覆盖虚拟列表视口卸载与行回收、双层叠加弹窗遮罩（`@layers` 逐层关闭）、富文本编辑器根节点与内部子节点填充边界、同文档 `pushState` 路由切换竞态。
- 人机接管、借用、录制遵守实际 Automation 设置；不改设置绕过确认，不伪造真人输入。缺人工协作、登录、验证码、网络限制或能力不可用均记 blocked/unverified，不能跳过后声称 100%。继续能独立完成的其他项目。
- 只操作本轮自建/明确借用的标签和 session。daemon 生命周期/配对只在独立 admin runtime 和端口测试；不得重启共享 daemon。公网仅公开浏览，不购买、发消息、发弹幕、点赞投币、发帖回帖、发布内容或提交销售线索。
- 意外失败后先查实际副作用，禁止盲重放。修复/重试成功保留首次失败，该轮仍不能放行。文档明确的 `dialog_pending` 是可恢复的中间状态，必须结束原 operation，不能重复触发动作。

## 执行

1. **建立候选与清单。** 读 [candidate-setup.md](references/candidate-setup.md)；以当前 CLI 的递归帮助（含隐藏的实验子命令树 `bsk recipe`）发现命令及枚举动作，不能沿用旧版本固定数量。读 [evidence-contract.md](references/evidence-contract.md)，运行 `scripts/release_audit.py init` 生成全命令用例及 [scenarios.json](references/scenarios.json) 的全部 90 个必测场景。帮助只算发现，不算操作覆盖。
2. **搭建本轮合成页面。** init 会复制 assets（含 `workbench`、`plan-recipe-lab`、`video-portal`、`forum-hub`、`edgecases`、`extra`、`carousel`、`live-update` 等）到全新 RUN；用 `scripts/serve.py --root RUN/fixtures --port PORT` 启动 loopback 服务器。每轮重新建立事件、上传和输出文件，不能复制旧通过记录。
3. **逐步操作并检查实际结果。** 读 [command-recipes.md](references/command-recipes.md)。每秒变化页及轮播页另按 [dynamic-pages.md](references/dynamic-pages.md) 测试 evaluate/read/wheel。每次 Bsk 调用通过 recorder，读取原始输出后再构造下一条命令；session start 和依赖它的命令分开。每项检查 DOM/业务事件/目标记录/文件内容等 oracle，不能仅看 exit 0。MCP 通道同样使用候选 `bsk mcp`，保留协议输入输出和逐工具（含 `bsk_recipe`）检查。
4. **完成八个公网站点实战。** 读 [public-sites.md](references/public-sites.md)：
   - **轮播与电商**：巨量引擎（`oceanengine.com`）、淘宝（`taobao.com`）；
   - **真实视频网站**：哔哩哔哩（`bilibili.com`，首页推荐流抽取 + 公开视频播放页 `<video>` 状态读取与只读控件交互）；
   - **真实论坛网站**：V2EX（`v2ex.com`，技术节点切换、主题列表提取、零回复/多回复对齐、楼层详情与代码块读取、只读 Recipe 回放）；
   - **文档、SPA、分页与资讯列表**：MDN、GitHub、Books to Scrape、Hacker News。
5. **逐项登记及审查。** 依据 plan.json 填写每一个结果；CMD-* 需实际执行该命令并检查结果。场景与命令行可引用同一真实记录，但不能凭一次打开页面给整类能力打勾。对每类页面输出实际适用的命令矩阵；不强行对 Canvas 执行 select 等无语义动作，但任何必测命令/场景/网站都不能用 N/A 消去。
6. **清理、生成 Benchmark 与计算门槛、交付。** 结束本轮 capture/录制/session/临时配对并归还标签，按约定保留测试安装。运行 `gate`（自动生成 `gate.json`、`benchmark.json` 与 `benchmark.md`）；跨多轮对比时额外运行 `scripts/release_audit.py benchmark --run RUN1 RUN2 ... --out benchmark-multi.json --markdown benchmark-multi.md`。只有所有必测项 passed、动态命令覆盖率 100%、场景通过率 100%、无意外失败/超时/未核验才称全量通过。否则明确“未达到全量通过条件”，列出实际覆盖、阻塞、缺陷和最小复现。

## 最终报告与 Benchmark 输出

给出目的（PR 自测/发版/多轮 Benchmark）、候选分支/SHA/dirty 状态、build/浏览器/安装路径、场景与命令分母及通过率、**Benchmark 汇总指标（总成功率、总交互轮次、总动作数、轮次压缩比 `actions/turn`、`single_action` vs `step` vs `plan` vs `recipe` 效率与 P50/P95 耗时对比）**、按网页类型的覆盖与耗时、每个公网网站（含视频站与论坛站）任务结果、缺陷严重度/复现命令/期望与实际/副作用/证据路径、未测或人工阻塞项、全量或部分覆盖结论及人工测试入口。附本地 RUN 证据路径；分享前脱敏。
