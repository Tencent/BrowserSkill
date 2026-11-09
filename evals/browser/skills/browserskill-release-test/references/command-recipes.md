# 命令覆盖与场景执行配方

先执行候选版本帮助发现，读当前 browser-skill 对应 reference。以下是操作/验收配方，不是可脱离当前帮助直接复制的参数表。每个叶命令/枚举 action 都生成独立 CMD-*；版本新增命令同样必测。

## 覆盖定义

三个分母分别报告：**动态命令清单、固定场景清单、网页类型清单**。命令至少有一次适用环境的实际成功调用且业务验收通过；场景需完成其全部动作与变体。CLI 退出0、HTTP200、截图文件存在、帮助能显示，均不等于业务通过。

网页类型×命令表记录实际用到的命令及证据。无语义组合（如 Canvas 内无 select）写清原因；不能用 N/A 删除必测行。life/admin/MCP 单独列能力域，不把它们虚报为 HTML 页面种类。表中的每一类网页都要有实测场景。

## 所有命令族

| 命令 | 适用页/执行与验收 |
| --- | --- |
| status / doctor / browsers / logs / help | 环境和隔离 admin：核对连接/版本/协议、doctor 问题提示、可读日志；`help` 本身实际执行算此命令，其他命令的 --help 不算覆盖 |
| session start/list/request/stop | 明确 browser，两个独立 session 隔离；权限 request 按当前帮助真正请求；stop 后不存在本轮活 session，不停止别人 |
| tab list/create/select/close/borrow/return | 两个任务页互切、关闭自建页；借用专用普通页→操作→归还，核对窗口/URL/状态，实际用户确认不可跳过 |
| window resize / emulate | 两个尺寸与一个移动设备/自定义模式，Bsk evaluate 只读核对 UA/viewport/DPR/touch，恢复本轮页 |
| cooperate enable/status/sync/wait | target 与 strict 独立会话，状态/receipt/等待不锁输入队列；sync --save-full/view/filter/baseline 路径需实测并核对未丢业务语义 |
| step / view | 一次动作+真实 readiness 条件，确认 action 只发生一次；view 读取保存的 sync，不刷新浏览器或 ref；超时检查 satisfied |
| navigate / navigate back/forward / navigate-back / navigate-forward / reload | 本地原生链接和 SPA；已有页面导航/历史/reload 按当前合同携带 context 与顶层 observation，不能把首次空白页导航当通用例外；历史两步均校验最终 URL/正文；原生 Enter 导航不能已成功却报告未输入 |
| snapshot / observe / get-html | 表单、长列表、iframe、Shadow、Canvas/closed-root边界，检查语义和 source；全页及元素 HTML 各验一次 |
| extract discover/table/list | 表格/卡片/分页/跨源 frame，核对列、行、关联和 provenance；JSON/CSV 输出若帮助支持均检查格式及 UTF-8 |
| click / hover / focus / blur / press | ref+CSS、中文快捷键、菜单、焦点事件、原生导航、右下角 CTA；click 成功要业务 handler/URL 正确 |
| fill / select | input/textarea/contenteditable、清空/追加、日期5型、单/多选；禁用/只读/maxlength 语义单列；不能用 evaluate 代填 |
| drag | workbench 拖动控件：to 目标、dx/dy 位移、支持的 click-move-click 分别用匹配控件；看真实位置/值/范围，不把 input delivered 当 drop accepted |
| wheel / scroll-to | 正反/横向/nested/长页/iframe，scrollTop/Left 和 viewport 坐标实测；不能仅看“事件发送成功” |
| screenshot | viewport/full-page/element/canvas；看图核对内容、尺寸、裁剪。长页、滚动后、resize 后均含样本 |
| evaluate | 静态页、SPA、iframe可达范围与 local/Ocean/Taobao active carousel；核对内部 ok 与真实值，fresh context/observation 必须匹配 |
| wait-for-navigation / wait-for-element / wait-ms | 已知加载信号、节点替换 visible/hidden/attached/detached；missing selector 为预期负例，satisfied:false 不得算正例 |
| upload / download | file input、hidden trigger、drop、多文件/中文/空文件；下载新文件 sha256/名称/事件；输出已存在、无效路径做负例 |
| console / network | fixture console对象、500消费/未消费、成功和失败请求；核对内容/分页/来源，不修改公网网络 |
| debug start/status/stop/capabilities | 导航前开启，验证生命周期、build、stop/export 总量；非空列表不等于全部捕获 |
| debug requests/request/pages/console | metadata/request/response/headers/timing、body pointer、字符分页、redaction、URL/状态筛选；与受控 fixture 对照 |
| debug performance/aggregate/duplicates | slow threshold 与重复窗口边界，controlled 默认排除/包含；核对数值和 identity |
| debug operations/operation/activity/wait/pin/unpin | 真正 command/request ID，等待原命令不重发，pin/unpin 状态正确；上传下载来源不能误标 human |
| debug rules/rule_add/rule_enable/rule_disable/rule_remove/replay | 仅本地 synthetic 请求，one-match 生效/禁用/启用/移除；同 replay key 不重复发送；不重放公网写操作 |
| debug export | 新路径输出，分页收齐后与导出及 stop 的总量对照；260 burst 不能截成200；复查完整 JSON |
| dialog status/accept/dismiss / operation await/cancel | `/dialogs` alert/confirm/prompt/beforeunload、延迟弹窗；处理原 operation，不重复 click；两支返回/取消语义和 once 计数 |
| record start/stop / request-help | 真正人类协作，trace 的目标/顺序/文本正确；Agent 自身点击不能用来证明用户录制功能正常 |
| video start/status/stop/list/save/discard | 新录制→MP4结构/解码→Bsk真实播放新文件；独立discard；baseline可播放不代替新录制可播放 |
| daemon start/restart/stop/pair/devices/revoke | 同候选 raw binary、独立 admin-runtime/端口，临时 server/配对/撤销，核对撤销后拒绝；不重启用户共享 runtime |
| update / install-skill | 默认实测 --check / --list；检查输出正确且不动候选。仅覆盖这两个安全模式，报告精确说明边界 |
| mcp | 同候选 bsk mcp stdio，initialize/tools/list，**每个 advertised tool 及其 action/mode 枚举分支** 按 schema 实测适用的成功调用，所有 JSON-RPC ID/取消/长任务留证；非其他浏览器后端 |

## 合成页面与业务 oracle

每秒变化页和活动轮播页的evaluate/wheel配对测试见 [dynamic-pages.md](dynamic-pages.md)。这组测试覆盖即时、规划延迟、页面上下滚动、nested纵横滚动与持续更新，不由普通长页测试替代。

assets/fixtures 随每轮复制。端口替换由 init 负责。服务器事件通过 **Bsk** 打开 `/events` 或只读 evaluate fetch 获取，不能直接 HTTP 请求网页替代能力测评。也可在结果核验时解析服务器写出的本地事件文件作独立 oracle。

| 页面 | 重点 |
| --- | --- |
| `/workbench.html` | SPA、多步表单/富文本、控件、iframe/open shadow、表格列表、文件、调试、长页 |
| `/minimal` | 简单静态页面/表单/SPA/表格，用作不受复杂布局干扰的对照 |
| `/edgecases` | maxlength/readonly/disabled、目标替换、row42→99复用、重复CTA、遮挡、closed shadow、500body |
| `/extra` | 五种时间、focus/blur、等待节点替换、二维滚动、子frame刷新、hidden文件、260请求、once计数 |
| `/pointer-semantic` | Lit comments/style 污染、固定左右下角CTA、原生导航 |
| `/canvas-test` | 双Canvas绿色目标视觉定位/坐标动作及录制源 |
| `/media` / `/new-media` | baseline视频与本轮新录制播放、原生controls、媒体状态 |
| `/carousel` | 400ms真实DOM/图片轮播与稳定表单，active 与 paused控制组分开 |
| `/live-update` | 每1000ms更新tick/时间/价格，长页与nested双向滚动，evaluate/wheel独立必测 |
| `/dialogs` | alert/confirm/prompt/delayed alert/beforeunload；arm须由真实Bsk点击激活 |
| `/frame` | 同/跨源frame输入保存、frame表格，host/value事件 |

缺某种控件时先读 fixture；允许补建合成页并记录文件哈希，然后由 Bsk 导航测试。不得改产品源代码或改公网页面制造成功。对于候选版本新增能力，补测试页/断言而不是把新能力排除。

## 历史问题回归（是线索，不是本轮已证实）

- 右下 overlay 遮挡、媒体原生 controls、原生 Enter 导航成功却报失败。
- Shadow/Lit 语义污染；相同 CTA 指向错误业务 record；readonly 语义缺失。
- output_exists 错误 code:null/错误 daemon 提示；超时缺 action phase/effect 与危险自动重试。
- 隐身权限错误误归 protocol；debug stop/export 总量不一致；本地参数错误错误标 unknown 并失效 context；Agent 上传/下载误标 human。
- 上传能力与五种日期曾修复，仍需每轮重测。轮播 observation_changed 是用户报告，必须本轮实际复现再定性。
