# 命令覆盖与场景执行配方

先执行候选版本帮助发现（含隐藏的实验命令树 `bsk recipe`），读当前 `browser-skill` 对应 reference 及 `docs/recipes.md`。以下是操作/验收配方，不是可脱离当前帮助直接复制的参数表。每个叶命令/枚举 action 都生成独立 `CMD-*`；版本新增命令同样必测。

## 覆盖定义与 Benchmark 口径

四个维度分别报告：**动态命令清单、固定场景清单（113 项，含 21 项对抗靶场场景 `ARENA-*`）、网页类型清单、Benchmark 效率与耗时指标**。命令至少有一次适用环境的实际成功调用且业务验收通过；场景需完成其全部动作与变体。CLI 退出 0、HTTP 200、截图文件存在、帮助能显示，均不等于业务通过。

网页类型×命令表记录实际用到的命令及证据。无语义组合（如 Canvas 内无 select）写清原因；不能用 N/A 删除必测行。`lifecycle` / `admin` / `mcp` / `batch-plan` / `recipe` 单独列能力域，表中的每一类网页都要有实测场景。

Benchmark 自动采集每次命令的**交互轮次（`interaction_turns`）、实际执行动作数（`actions_executed`）、轮次压缩比（`actions/turn`）、RPC/浏览器调用数、墙钟耗时（`elapsed_ms`）与观察复用情况**。

## 所有命令族

| 命令 | 适用页/执行与验收 |
| --- | --- |
| status / doctor / browsers / logs / help | 环境和隔离 admin：核对连接/版本/协议、doctor 问题提示、可读日志；`help` 本身实际执行算此命令，其他命令的 `--help` 不算覆盖 |
| session start/list/request/stop | 明确 browser，两个独立 session 隔离；权限 request 按当前帮助真正请求；stop 后不存在本轮活 session，不停止别人 |
| tab list/create/select/close/borrow/return | 两个任务页互切、关闭自建页；借用专用普通页→操作→归还，核对窗口/URL/状态，实际用户确认不可跳过 |
| window resize / emulate | 两个尺寸与一个移动设备/自定义模式，Bsk evaluate/read 只读核对 UA/viewport/DPR/touch，恢复本轮页 |
| cooperate enable/status/sync/wait | target 与 strict 独立会话，状态/receipt/等待不锁输入队列；`sync --save-full` / `--baseline` / `--match-text` 路径实测并核对未丢业务语义 |
| step / view | 一次动作+真实 readiness 条件（`--until-visible`），确认 action 只发生一次；`view` 读取保存的 sync/step/plan 文件，零浏览器调用（`browser_calls:0`）且不刷新 ref |
| **plan** | target 策略下一次 sync 后批量执行 1–20 个已决定步骤（`click`、`fill`、`select`、`press`、`hover`、`scroll-to`、`wheel`、`drag`、`wait-for-element`），支持步骤级 `expect`、首步无目标动作（需 `--observation`）、`--until-visible`、`--save-full`、`--baseline`。验证正例 `ok:true` 与 `completed==total`；验证负例首错即停（`stopped.index`、`stopped.effect_state`、`not_run`）且绝不自动重试 |
| **recipe list/show/rm/save/approve/draft/run** | 默认开启 `BSK_RECIPES=1`。在真实会话操作 `/recipe/form?source=first` 后用 `recipe draft` 导出脱敏草稿（验证 `site.start` 为 `/recipe/form`、不含输入明文与 query secret），审查补齐 `until`/`outputs` 后 `recipe save`、`recipe approve`（无降级步骤返回 `approval_required:false`）、`recipe list`、`recipe show`；用 `recipe run` 验证良性漂移（`ids/order/late/popup/rerender`）下的零模型轮次回放与多 `segments` 跨页执行；验证语义漂移下安全 `handoff`（连续 3 次同位偏离标为 `stale`）及不可逆 `commit` 步骤、未人工审批降级步骤（`approval_required` / `approval_needs_person`）、非法参数、`borrowed_tab` 的 `refused` 拒止 |
| **read** | 零 JS 注入的有界 DOM 读取：在静态页、高频更新页（`/live-update`）、视频站（`/video-portal`、Bilibili）、论坛站（`/forum-hub`、V2EX）及 iframe/shadow 节点上，分别用 `--selector` 与 `--ref`、`--fields-json`（`text`、`attribute`、`value`、`checked`、`exists`）及 `--max-nodes` / `--max-bytes` 实测 |
| navigate / navigate back/forward / navigate-back / navigate-forward / reload | 本地原生链接、pushState SPA 和公网站点；已有页面导航/历史/reload 按当前合同携带 context 与顶层 observation；历史两步均校验最终 URL/正文 |
| snapshot / observe / get-html | 表单、长列表、iframe、Shadow、Canvas/closed-root 边界，检查语义、图层 `@layers` 和 source；全页及元素 HTML 各验一次 |
| extract discover/table/list | 表格/卡片/分页/跨源 frame/视频推荐卡片/论坛主题列表，核对列、行、关联、缺省字段不串列和 provenance |
| click / hover / focus / blur / press | ref+CSS、中文快捷键、菜单、焦点事件、原生导航、右下角 CTA；click 成功要业务 handler/URL 正确 |
| fill / select | input/textarea/contenteditable 根节点、清空 `""`、追加 `--no-clear`、日期5型、单/多选；禁用/只读/maxlength 与编辑器子节点拒绝（`target_not_fillable`）语义单列；不能用 evaluate 代填 |
| drag | workbench 拖动控件：to 目标、dx/dy 位移、支持的 click-move-click 分别用匹配控件；看真实位置/值/范围 |
| wheel / scroll-to | 正反/横向/nested/长页/iframe/动态页，scrollTop/Left 和 viewport 坐标实测 |
| screenshot | viewport/full-page/element/canvas；看图核对内容、尺寸、裁剪。长页、滚动后、resize 后、视频播放页均含样本 |
| evaluate | 静态页、SPA、iframe 可达范围与 local/Ocean/Taobao active carousel、Bilibili `<video>` 状态；核对内部 `ok:true` 与真实值，fresh context/observation 必须匹配 |
| wait-for-navigation / wait-for-element / wait-ms | 已知加载信号、节点替换 visible/hidden/attached/detached；missing selector 为预期负例，`satisfied:false` 不得算正例 |
| upload / download | file input、hidden trigger、drop、多文件/中文/空文件；下载新文件 sha256/名称/事件；输出已存在、无效路径做负例 |
| console / network | fixture console 对象、500 消费/未消费、成功和失败请求；核对内容/分页/来源，不修改公网网络 |
| debug start/status/stop/capabilities | 导航前开启，验证生命周期、build、stop/export 总量；非空列表不等于全部捕获 |
| debug requests/request/pages/console | metadata/request/response/headers/timing、body pointer、字符分页、redaction、URL/状态筛选；与受控 fixture 对照 |
| debug performance/aggregate/duplicates | slow threshold 与重复窗口边界，controlled 默认排除/包含；核对数值和 identity |
| debug operations/operation/activity/wait/pin/unpin | 真正 command/request ID，等待原命令不重发，pin/unpin 状态正确；上传下载来源不能误标 human |
| debug rules/rule_add/rule_enable/rule_disable/rule_remove/replay | 仅本地 synthetic 请求，one-match 生效/禁用/启用/移除；同 replay key 不重复发送；不重放公网写操作 |
| debug export | 新路径输出，分页收齐后与导出及 stop 的总量对照；260 burst 不能截成 200；复查完整 JSON |
| dialog status/accept/dismiss / operation await/cancel | `/dialogs` alert/confirm/prompt/delayed alert/beforeunload；处理原 operation，不重复 click；两支返回/取消语义和 once 计数 |
| record start/stop / request-help | 真正人类协作，trace 的目标/顺序/文本正确；Agent 自身点击不能用来证明用户录制功能正常 |
| video start/status/stop/list/save/discard | 新录制→MP4 结构/解码→Bsk 真实播放新文件；独立 discard；baseline 可播放不代替新录制可播放 |
| daemon start/restart/stop/pair/devices/revoke | 同候选 raw binary、独立 admin-runtime/端口，临时 server/配对/撤销，核对撤销后拒绝；不重启用户共享 runtime |
| update / install-skill | 默认实测 `--check` / `--list`；检查输出正确且不动候选。仅覆盖这两个安全模式，报告精确说明边界 |
| mcp | 同候选 `bsk mcp` stdio，`initialize` / `tools/list`，**每个 advertised tool（含开启 `BSK_RECIPES=1` 时的 `bsk_recipe`）及其 action/mode 枚举分支**按 schema 实测成功调用与错误/取消对等性 |

## 合成页面与业务 oracle

每秒变化页和活动轮播页的 `evaluate` / `read` / `wheel` 配对测试见 [dynamic-pages.md](dynamic-pages.md)。

| 页面 | 重点 |
| --- | --- |
| `/workbench.html` | SPA、多步表单/富文本编辑器、控件、iframe/open shadow、表格列表、文件、调试、长页 |
| `/plan-recipe-lab` (`/recipe/report`, `/recipe/form`, `/recipe/login`) | `bsk plan` 级联异步表单、单价涨价 `expect` 中止、人工干预，以及 `bsk recipe` 全生命周期与 13 种漂移/拒止矩阵 |
| `/video-portal` | 本地确定性视频门户：HTML5 `<video>` 控制栏（倍速/弹幕/章节/简介）、双层叠加弹窗（`modal=1` / `modal=2`）、推荐流与异步评论加载 |
| `/forum-hub` | 本地确定性开发者论坛：节点 Tab `pushState` 切换、热度/关键词筛选、置顶帖与零回复帖对齐、帖子详情楼层与代码块读取、虚拟列表视口行回收（Rows 20-25） |
| `/minimal` | 简单静态页面/表单/SPA/表格，用作不受复杂布局干扰的对照 |
| `/nested-menu` | Element Plus 风格两级动态悬停菜单（`Workspace -> Advanced`）：一级浮层 teleport 到 `body`，二级浮层嵌在父 `menuitem` 内，验证展开前后子项 `@eN` 独立引用与点击回执 `Selected audit` |
| `/edgecases` | maxlength/readonly/disabled、目标替换、row42→99 复用、重复 CTA、遮挡、closed shadow、500 body |
| `/extra` | 五种时间、focus/blur、等待节点替换、二维滚动、子 frame 刷新、hidden 文件、260 请求、once 计数 |
| `/pointer-semantic` | Lit comments/style 污染、固定左右下角 CTA、原生导航 |
| `/canvas-test` | 双 Canvas 绿色目标视觉定位/坐标动作及录制源 |
| `/media` / `/new-media` | baseline 视频与本轮新录制播放、原生 controls、媒体状态 |
| `/carousel` | 400ms 真实 DOM/图片轮播与稳定表单，active 与 paused 控制组分开 |
| `/live-update` | 每 1000ms 更新 tick/时间/价格，长页与 nested 双向滚动，`evaluate` / `read` / `wheel` 独立必测 |
| `/dialogs` | alert/confirm/prompt/delayed alert/beforeunload；arm 须由真实 Bsk 点击激活 |
| `/frame` | 同/跨源 frame 输入保存、frame 表格，host/value 事件 |
| **`/arena-joint-forms`** | 三表联动联合申报（~1,650 DOM 节点 + 600ms 汇率牌价）：Form A 三级异步级联（含 95 字符长选项与 `:disabled` 选项）、信用代码规范化、8 位敏感授权码、`readonly`/`disabled`/`maxlength`、70ms 延迟焦点代理、5 类时间控件、多选与两种 label；Form B 动态成员与 `sum==100%`；Form C 跨表精算、富文本根与 `contenteditable=false` 子节点、HTML5 拖拽会签、隐藏 chooser/拖放上传、45 行台账；全部校验通过并提交后核定单链接才获得 href，服务器对无回执下载返回 403，CSV 按 RFC 4180 转义并中和公式前缀 |
| **`/arena-shadow-iframe`** (`+ /arena-frame-outer`, `/arena-frame-inner`) | 三层嵌套 Open Shadow（命名 `<slot>`、内联 `<style>`/Lit 注释防污染、`composed:true` 事件、Shadow 内悬浮菜单与表格）、Open Shadow 插槽列表 `#shadow-slotted-runbook`（具名/默认/回退 `<slot>` 顺序、闭合 `<details>` 隐藏行位置保留、嵌套子列表 `#shadow-nested-sublist` 隔离）、Closed Shadow 视觉坐标兜底；同源 L1 帧 + 跨源 `localhost` L1 帧 + 回切 `127.0.0.1` 的 L2 帧（A->B->A），`postMessage` 中继与子帧局部重载 |
| **`/arena-media-studio`** (`+ /arena-audio.wav`, `/captions-zh.vtt`, `/captions-en.vtt`) | 原生 `<video controls>` 与 `<audio controls>`（服务器支持 HTTP `206 Range`）：章节寻址 `0.2s/1.8s/3.5s`、倍速、音量 `fill`/`drag`、静音/循环；中英 WebVTT 字幕 zh/en/off 切换与 `#active-caption-banner`；寻址后 `<canvas>` 帧像素采样；4 期节目单切歌与 48 行打点表 |
| **`/arena-modern-spa-grid`** (`+ /arena-bfcache-detail`, `/redirect-cross-origin`, `/slow-doc`, `/download-stream`) | `?hydrate_ms=180` 水合替换与 pushState 路由；`Cache-Control: no-cache`、零 `unload` 的真实 bfcache 往返；650ms 延迟导航、慢文档、`127.0.0.1 -> localhost` 跨源 302、默认无 `Content-Length` 的流式下载（`known_length=1` 可加回）；`oklch()` 白字/渐变字保留 vs 隐藏文本诱饵；密码与 `autocomplete=one-time-code` 跨通道脱敏；5,000 行虚拟表默认键控复用（仍可见行保留 DOM 节点），`?vgrid=pool` 为 ag-grid 式滚动槽位就地重绑；三层 `rowspan/colspan` 财务表；`?mega=1` 约 6,800 节点、可见文本 >200KB。所有动态路由的 HEAD 请求只返回头部，不写事件、不等待 |
