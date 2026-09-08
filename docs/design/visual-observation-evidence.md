# Visual observation：PR 0 验证结果与架构决策

日期：2026-09-08。生产基线：main `3c5f838`。分支：`codex/visual-observation-design`。

本次只新增设计、合成 fixture 和诊断工具。没有生产算法变更，没有 commit/push。
总体设计及后续 PR 依赖见 [架构与实施计划](visual-observation.md)。
本文是历史证据；新会话请按 [验收清单](visual-observation-acceptance.md) 执行相关检查并说明结果，不继承本文的通过结论。

## 1. 环境与证据等级

| 环境 | 实际版本/说明 |
|---|---|
| PATH 中的 bsk | 0.1.7，未用于有效页面基线 |
| 仓库已有 target/debug/bsk | 0.2.0；`update --check` 报告发布最新版也是 0.2.0，没有安装更新 |
| daemon / connected extension | 0.2.0，protocol 1.1 |
| 页面基线 Chrome | 151.0.0.0，由 bsk browsers 报告 |
| 生产扩展构建 | `pnpm ext:build`，用户 reload 当前 main 基线构建后采集 |
| 独立协议实验 Chrome | 152.0.7977.76，临时无登录 profile；与用户浏览器不是同一个运行实例 |
| 基线测试 | VOM 47 tests / 2 files；相关扩展 217 tests / 14 files；全部通过 |

页面结果是实际 bsk + reload 扩展的结果。协议实验是独立 Chrome 的真实 CDP 响应。
临时 replay 是将合成响应送入 main adapter 的诊断，不代表另一条真实浏览器完整运行。
不同证据不混用，版本号本身不证明构建 commit。

所有内部页面原文、地址、iframe 标识、截图和用户信息仅保存在本机临时目录，不进入仓库。
本文仅保存匿名化事实，仓库 fixture 完全独立构造。

## 2. 原始问题已确认：表格加载完成后仍有观察缺口

有效就绪条件：前台可见页面已经绘制出网格、列标题和六行表格。不能使用以下替代条件：

- `document.readyState === complete`。
- AX 已有嵌入应用的工具栏。
- 页面出现 iframe。
- 背景截图仍为站点加载 logo。

本次初始后台窗口恰好出现“AX 已有工具栏，图像仍为加载占位”的情况。这些样本已排除。
在前台绘制完成后重新取得匹配的截图和 observe，结果为：

| 事实 | 结果 |
|---|---|
| 实际截图 | 可见列标题、网格与六行表格 |
| main observe | 63 个 ref，含外围和嵌入应用工具栏 |
| truncated | false |
| 表格列内容 | 没有相应文本表示 |
| visual ref | 没有 |
| 直接打开已观察到的嵌入应用 | 发现一个无 aria-label 的 Canvas，CSS 尺寸 1450×835、backing store 2900×1670，DPR 2 |

直接打开嵌入应用用于验证其渲染介质；其宽度变化是独立 tab 布局，不能拿这组坐标当父页面中的 crop。
父页面的截图/VOM 对照与直接嵌入页的 DOM 证据分别记录。

结论：主要能力缺口是视觉内容没有观察入口；不属于这次有效样本的文本预算耗尽。
新架构不能承诺从 Canvas 自动恢复单元格语义；正确结果是保留工具栏，并提供可截图的区域入口。

## 3. 合成最小复现

`table.html` → 跨站点 `grid.html`：一个 iframe、DOM 工具栏、一个无名 Canvas。
Canvas 绘制三列、六行，所有文字与原页面无关。

main 实际输出的关键部分：

```text
@view 1440x923
@e1 button "Page action"
Iframe "Table application"
  navigation
    @e2 button "Insert record"
    @e3 button "Filter"
```

`ref_count=3`，`truncated=false`。截图已人工确认包含 `Canvas column A/B/C` 和六行。
这些像素文字既没有文本表示，也没有 visual ref。该最小复现已覆盖原场景的关键结构，
无需站点权限或生产选择器。

## 4. CSS 与语义/交互分离

真实浏览器实验确认：

- aria-hidden 祖先、inert 祖先、pointer-events:none 不会使 Canvas 自动视觉消失。
- `visibility:hidden` 祖先下的 `visibility:visible` 子 Canvas 可以恢复可见。
- `hidden` 元素被 `display:block` 覆盖时仍可绘制。
- opacity:0 祖先会使子树透明；不能仅检查 Canvas 自己的 opacity。
- display:none 无 layout bounds；visibility:hidden 可以仍有 bounds。
- AX fallback 文本不包含绘制的 `PIXEL TABLE 42`，不能用 fallback 存在作为发现去重条件。

决定：事实层分别保存 computed visibility、透明继承、语义暴露和交互属性。
视觉发现不读取 semantic keep/drop 结果；祖先索引只能传播符合属性语义的状态。

`checkVisibility()` 的实验作用仅限 CSS suppression，不用它证明 overflow、viewport 或遮挡结果。
常规 overflow 由独立几何规则负责；任意遮挡不进入首版精确能力范围。

## 5. 单位、frame 投影与截图

### 5.1 DPR 与截图像素是不同契约

独立 Chrome 上对相同 120×40 CSS clip 的结果：

| Emulated DPR | DOMSnapshot Canvas w×h | Screenshot w×h | layoutViewport/cssLayoutViewport 宽度比 |
|---|---|---|---|
| 1 | 120×40 | 120×40 | 1 |
| 1.5 | 120×40 | 180×60 | 1 |
| 2 | 120×40 | 240×80 | 1 |

因此该比值不能用作通用截图 DPR。原始 DOMSnapshot 单位与截图 raster scale 必须分别适配，
输出 PNG 尺寸是最终预算事实。不能把本组 DPR emulation 结果泛化为所有浏览器缩放组合。

### 5.2 三种缩放分别记账

- CSS `zoom:1.25`：120px 宽 Canvas 的布局 bounds 为 150px，运行时几何同步变化。
- Emulation.setPageScaleFactor(1.5)：记录为 page-scale/pinch 类证据，不充当 UI zoom。
- 用户 Chrome 原生 UI 缩放到 90%：界面明确显示 90%，DPR 从 2 变为约 1.8，innerWidth 从 1440 变为 1600，visualViewport.scale 仍为 1；Canvas CSS 宽约 120.0000076，截图仍是 2880px 宽。main VOM 视口为 1600×1025。已恢复 100%。

现有 bsk 的 Meta+- CDP 输入未改变浏览器缩放，所以该无效果尝试不算缩放验证；
有效样本来自原生浏览器 UI 操作。真实 UI zoom 仅验证了上述点，不能宣称完整 zoom 矩阵已通过。

决定：使用 CSS 视口空间作为发现/截图区域公共契约；精确单位 adapter 的实现还必须在 PR 1
跑计划内组合回归，不用一个比例同时解决所有协议字段。

### 5.3 Frame 空间与 main 已知偏移

fixture local Canvas 原点为 (17,23)。

| 场景 | 实测 owner content 原点（target root） | 正确 top Canvas 原点 | main parser replay |
|---|---|---|---|
| 同 target frame，10px border | (50,610) | (67,633) | (57,623) |
| 上述 frame 内 nested，另有 7px border | (87,707) | (104,730) | (87,713) |
| OOPIF，10px border | (410,610) | (427,633) | 本表不混入非完整 replay 的 OOPIF 结果 |

根 target 的 DOMSnapshot 含三份 document（top/same/nested）；OOPIF 在单独 target 中只返回自己的 document。
probe 通过实际 `TargetInfo.type=iframe` 验证 OOPIF，而非仅根据 origin 推断进程隔离。

子 frame scrollY=10 后，runtime local y 从 23 变为 13，snapshot document y 仍为 23。
owner scale(1.25) 后 content quad 宽度变为 375，child innerWidth 仍为 300。

决定：frame-local 原始矩形必须先减该 document 的滚动，再经过一次权威投影；同 target 的
owner quad 已是 target-root 坐标，不能重复逐层加偏移。禁止 border-box 替代 content origin。

Box 种类也必须进入契约：带 5px border 的 120px Canvas，其 snapshot/border quad 宽 130，
content quad 宽 120。视觉入口采用 border-box，实时验证同种 box；iframe 投影则采用 content quad。
带 border/padding 的 overflow owner，snapshot.clientRects 对应 `[clientLeft,clientTop,clientWidth,clientHeight]`，
本 fixture 为 `[5,5,68,38]`。裁剪边界应从 client box 派生，不能直接拿 ancestor border bounds。
单轴 `overflow-x:clip;overflow-y:visible` 的 computed style 保持分轴，必须分轴传播。

CSS zoom 1.25 后，上述 owner 的 bounds 变为 `[745,455.625,97,59.5]`，clientRects 仍为
`[5,5,68,38]`，offsetRects 为 `[596,365,78,48]`。直接按 border-width 比例推导 client box
会混入不同空间与整数取整。首版将有 CSS zoom/DOM transform 的 overflow 祖先组合明确降级，
不承诺精确 crop；普通未变换 overflow 及 iframe content-quad 投影保留支持。

## 6. Document 与 ref 时效

真实 CDP 实验：

| 操作 | frameId | loaderId | document backend | anchor |
|---|---|---|---|---|
| history.replaceState | 不变 | 不变 | 不变 | 仍属于当前树 |
| 跨 document 导航 | 不变 | 变化 | 变化 | 旧目标不可继续视为当前内容 |
| document.open/write/close | 不变 | 不变 | 本次实验不变 | 旧 Canvas 失去连接，documentElement 被替换 |

决定：身份取 target attachment epoch + frameId + loaderId + documentElement backend identity；
工具执行时仍检查 anchor.isConnected 及其所属 documentElement。不能仅凭 loaderId 判断有效。
DOMSnapshot 可提供根元素 backend identity，frame graph 需要保留 loaderId；当前 main graph
没有该字段，这是后续数据契约的明确修改点。

12 次静态几何采样完全相同；0.5px 移动可被检测；真实 90% 缩放引入约 1e-5 CSS px 的
数值误差。首版采用最大边误差 0.25 CSS px 作为保守工程阈值，超出要求重新 observe。
这不是大规模统计得到的通用稳定性保证；改变阈值需更新其测试及行为文档。

既有 eN 被下一次观察重用后，单靠旧字符串不能检测它来自上一代。内部 generation 不消除
该协议限制。本次不改变协议，只验证当前存储目标的身份/几何。Canvas 可以在身份与几何
不变时重绘；截图始终表达执行时图像，不承诺观察时像素快照。

## 7. 既有路径回归基线：用于防止负优化

诊断复制当前 renderer 到临时目录，在三个明确循环点加计数；生产文件未改变。
复现命令见 [fixture README](../../apps/extension/test-fixtures/visual-observation/README.md)。

| 输入 | Render stack visits | DOM context candidates | Same-container sibling visits |
|---|---:|---:|---:|
| 100 headings + 100 View buttons | 201 | 10,000 | 15,050 |
| 200 headings + 200 View buttons | 401 | 40,000 | 60,100 |
| 400 headings + 400 View buttons | 801 | 160,000 | 240,200 |
| 2,000 transparent wrappers + control | 2,001 | 0 | 0 |
| 4,000 transparent wrappers + control | 4,001 | 0 | 0 |

显式栈访问线性并通过深树输入；本组宽树上下文计数呈二次增长。这里记录的是现有路径的
特征，供后续同输入比较是否发生回退，不是本次要求修复的问题，也不是 Canvas 新算法的模板。
计数不是完整 CPU profile，更不能替代 Canvas 发现、裁剪、选择和截图各自的性能测试。

处理边界：

1. 既有语义、DOM 操作和截图路径对照 main 不发生性能回退；不把历史算法优化列为本次前置依赖。
2. Canvas 新路径按自己的规模和访问模式论证算法；发现、裁剪、去重、选择和截图分别验收。
3. 精确 crop key 去重的选择来自首版的覆盖等价契约和新增成本分析，与 #165 采用什么算法无关。
4. PR 7/8 分别报告既有路径回归、无 Canvas 页面的额外成本、有 Canvas 页面的新增成本。
   新功能有合理的额外成本不等于旧算法负优化；重复执行旧工作则属于需要消除的回退。

## 8. 锁定首版策略与退化

| 决策 | 首版契约 | 理由/验收 |
|---|---|---|
| 去重 | 同 document + 同直接 parent + 四条 crop 边完全相等 | 无模糊聚类；误差导致重复比误合并更可控 |
| 索引容量 | 50,000 keys；耗尽后其余候选继续未去重选择 | 内存有界，不因早期小图耗尽而停止后续发现 |
| K | min(预算推导容量, 512) | 所有行仍逐条核算可变成本 |
| 默认视觉预算 | 未给总 maxTokens 时 2048 estimated tokens | 有显式 maxTokens 时全部纳入同一预算 |
| 摘要预留 | 固定提示行按实际估算器成本预留 | 不用不可验证的固定 token 常量表示某段文本 |
| 几何时效 | 最大边差 > 0.25 CSS px 即重新观察 | 身份和裁剪策略变化独立拒绝 |
| 图像 | max edge 2048、max pixels 4,000,000、最多两次 capture | 成功必须以实际尺寸满足后置条件 |
| 外部几何并发 | 4 | 单操作缓存；操作结束释放 |
| 新增纯计算取消 | 每 256 项形成工作块并让出事件循环 | 不仅是轮询无法及时更新的 signal |

这些数值是可审查的首版资源政策，不是声称已证明用户体验最优的测量结果。
参数可以在对应模块 PR 中经新的证据调整，但必须一并更新契约及测试。

进一步收敛：首版精确区域支持轴向矩形、普通 overflow 链、正向轴对齐平移/缩放与 frame。
旋转、透视、clip-path、mask、活动 pinch-zoom 进入明确的 geometry-unsupported 降级，
不给看似精确的 region ref，提示现有视口截图途径。不会把包围矩形偷换成精确区域。

## 9. 已执行的检查与下一阶段门槛

已执行：

- main VOM tests：47 passed。
- main 相关 extension tests：217 passed，含 frame/element geometry、observation、interaction、ref-store、VOM。
- `pnpm ext:build` 成功，用户 reload 后采集有效页面基线。
- 独立 Chrome browser contract probe：39 个断言通过；可复现命令见 fixture README。
- main 合成 capture replay、显式栈/上下文操作计数。
- 实际 Chrome UI 90% zoom 样本，恢复 100%。
- 原始表格与合成嵌入式表格均人工查看截图，并与未截断 observe 对照。

PR 0 交付的是已明确边界的设计和基线，不是未来功能已经通过：新的 discovery、typed ref、
freshness resolver、pixel planner 和 renderer 接线尚未实现。后续每个 PR 必须验证自己的
生产实现，不能把本次浏览器事实验证替代实现验收。

人工证据不设置默认 CI 对内网站点的访问依赖。合成 probe 可按需执行；页面原文不进仓库。
后续 PR 的职责和验收保持在主设计中，本文负责记录证据、决策及没有作出的保证。
