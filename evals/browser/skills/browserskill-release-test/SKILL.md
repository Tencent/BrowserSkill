---
name: browserskill-release-test
description: 使用 Bsk 执行 BrowserSkill 的 PR 前可选端到端自测与发版全量测评：验证当前分支或指定候选构建，覆盖复杂 HTML、公网网站及全部动态发现的 CLI 命令，保存逐步证据并如实报告覆盖与失败。不用于普通网页浏览。
---

# BrowserSkill发版前测试

用真实浏览器行为评估候选版本。交付可复查的完整证据、覆盖矩阵、缺陷清单及测试结论。**100% 是全量通过的判定标准，不是预先保证的测试结果，也不是强制 PR 门槛。**

较大改动提交 PR 前推荐运行；不是提交或合并 PR 的强制要求，不替代现有单测和检查。未运行或存在环境阻塞时如实说明，不据此要求阻止 PR。全量通过的判定仍要求所有必测项通过；明确请求局部自测时可只执行相关项，但报告必须标为部分覆盖，不能缩小全量分母。

可直接让 Agent 阅读本仓库中的本文件；也可将整个 `browserskill-release-test` 目录复制到宿主支持的技能目录后按名称调用。脚本和资源相对本 Skill 定位，无需修改用户的内置 `browser-skill`。

## 不可省略的约束

- 所有浏览器读取、输入、脚本、截图、调试、录制、标签操作都经过本轮固定构建的 **Bsk**。不能用 Playwright、CDP、CUA、其他浏览器 MCP 或直接 HTTP 抓取页面代做。shell 可编译、启动本地合成服务器、调用 Bsk、解析产物；图片/视频工具可检查 Bsk 产物。
- 阅读候选仓库的 `crates/bsk-cli/skill/SKILL.md` 及对应 references，确保操作规范与候选匹配；不得凭本技能编造命令参数。
- 按 [candidate-setup.md](references/candidate-setup.md) 选择候选：PR 自测默认当前分支 HEAD；发版测指定 release commit 或固定的 main SHA。CLI 与独立命名扩展来自同一源码，固定 browser 并核对 build/文件哈希。本轮中途换版本必须新开完整一轮。测试安装按用户要求保留供复查。
- 业务操作前读取页面。target 政策 DOM 动作使用返回的 context；evaluate、已有页面的 navigate/back/forward/reload、视觉或其他无目标动作还使用 fresh sync 的**顶层 observation_id**。strict 独立会话每次重新 sync。不能猜 refs、补造 receipt 或用关闭 guard 消除失败。
- 轮播保持运行。不得暂停、冻结 DOM、隐藏动画、注入 CSS 或换后端使巨量引擎/淘宝的 active 测试通过。`observation_changed` 等错误原样留证；判断实际原因，不把用户猜测直接写成已证实缺陷。
- 每秒变化页和轮播页都必须独立测 evaluate 与 wheel，包含即时及跨更新周期的规划延迟、实际滚动和持续更新核验，按 [dynamic-pages.md](references/dynamic-pages.md) 执行。不能只在静态页测过命令就给动态页打勾。
- 人机接管、借用、录制遵守实际 Automation 设置；不改设置绕过确认，不伪造真人输入。缺人工协作、登录、验证码、网络限制或能力不可用均记 blocked/unverified，不能跳过后声称 100%。继续能独立完成的其他项目。
- 只操作本轮自建/明确借用的标签和 session。daemon 生命周期/配对只在独立 admin runtime 和端口测试；不得重启共享 daemon。公网仅公开浏览，不购买、发消息、发布内容、提交销售线索。
- 意外失败后先查实际副作用，禁止盲重放。修复/重试成功保留首次失败，该轮仍不能放行。文档明确的 `dialog_pending` 是可恢复的中间状态，必须结束原 operation，不能重复触发动作。

## 执行

1. **建立候选与清单。** 读 [candidate-setup.md](references/candidate-setup.md)；以当前 CLI 的递归帮助发现命令及枚举动作，不能沿用旧版本固定数量。读 [evidence-contract.md](references/evidence-contract.md)，运行 `scripts/release_audit.py init` 生成全命令用例及 [scenarios.json](references/scenarios.json) 的全部必测场景。帮助只算发现，不算操作覆盖。
2. **搭建本轮合成页面。** init 会复制 assets 到全新 RUN；用 `scripts/serve.py --root RUN/fixtures --port PORT` 启动 loopback 服务器。每轮重新建立事件、上传和输出文件，不能复制旧通过记录。本地用例覆盖表单、控件、iframe/Shadow、动态 DOM、导航、表格/卡片、文件、Canvas、长页、媒体、原生对话框、调试和轮播。
3. **逐步操作并检查实际结果。** 读 [command-recipes.md](references/command-recipes.md)。每秒变化页及轮播页另按 [dynamic-pages.md](references/dynamic-pages.md) 测试 evaluate/wheel。每次 Bsk 调用通过 recorder，读取原始输出后再构造下一条命令；session start 和依赖它的命令分开。每项检查 DOM/业务事件/目标记录/文件内容等 oracle，不能仅看 exit 0。MCP 通道同样使用候选 `bsk mcp`，保留协议输入输出和逐工具检查。
4. **完成六个公网站点。** 读 [public-sites.md](references/public-sites.md)。巨量引擎与淘宝均需运行中轮播的三次 fresh sync → evaluate、真实视觉/图片切换证据及各自业务任务。其余 MDN、GitHub、Books、HN 不能省略或用本地页替代。
5. **逐项登记及审查。** 依据 plan.json 填写每一个结果；CMD-* 需实际执行该命令并检查结果。场景与命令行可引用同一真实记录，但不能凭一次打开页面给整类能力打勾。对每类页面输出实际适用的命令矩阵；不强行对 Canvas 执行 select 等无语义动作，但任何必测命令/场景/网站都不能用 N/A 消去。
6. **清理、计算门槛、交付。** 结束本轮 capture/录制/session/临时配对并归还标签，按约定保留测试安装。运行 gate；只有所有必测项 passed、动态命令覆盖率 100%、场景通过率 100%、无意外失败/超时/未核验才称全量通过。否则明确“未达到全量通过条件”，列出实际覆盖、阻塞、缺陷和最小复现；这不是强制 PR 合并检查。禁止修改分母、吞错或选择最佳重试。gate 仅校验证据合同，Agent 仍须核对业务及视觉正确性。

## 最终报告

给出目的（PR 自测/发版）、候选分支/SHA/dirty 状态、build/浏览器/安装路径、场景与命令分母及通过率、按网页类型的覆盖、每个公网任务结果、缺陷严重度/复现命令/期望与实际/副作用/证据路径、未测或人工阻塞项、全量或部分覆盖结论及人工测试入口。附本地 RUN 证据路径；分享前脱敏。旧报告只能作回归线索，不能计入本轮通过数。
