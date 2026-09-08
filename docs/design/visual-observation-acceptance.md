# Visual observation：验收清单

新 agent 先读 [架构与 PR 划分](visual-observation.md)，再按本清单验收当前 PR；无需聊天记录，也无需另写报告、逐项编号或填写模板。历史结果见 [PR 0 证据](visual-observation-evidence.md)，不能代替本次执行。

## 怎么开始

- 查看分支、HEAD 和工作区改动，确认当前做哪个 PR。PR 0 基于 main `3c5f838`；后续模块对照其前置基线，最终回归对照 main。注意未跟踪文件也属于改动。
- 当前仅有设计、合成 fixture 和诊断脚本；未来模块尚未实现。只验收当前阶段及受影响的已有功能，不要求提前完成后续 PR。
- 测试放在模块附近，调用实际生产代码。未接线模块可用人工输入和 CDP stub；实现 PR 写明运行命令即可，不强制新建指定目录、命名或诊断 API。
- 浏览器验收前核实 CLI 版本，并重新 build、确认扩展 reload。PATH 中的 bsk 曾经比仓库版本旧，不能只凭版本号认定运行了目标代码。
- 不 commit/push。截图、原始页面内容和一次性实验放临时目录；只把长期需要的设计、fixture 和测试留在仓库。

## 现有验证入口

从仓库根目录运行，命令成功退出且相关断言通过才算成功：

```sh
pnpm vom:test
pnpm --filter @browser-skill/extension test src/tools/__tests__/frame-geometry.test.ts src/tools/__tests__/element-geometry.test.ts src/tools/__tests__/observation.test.ts src/tools/__tests__/snapshot-ref.test.ts src/tools/__tests__/interaction.test.ts src/tools/vom src/session-manager/__tests__/ref-store.test.ts
pnpm exec biome check apps/extension/test-fixtures/visual-observation
VISUAL_EVIDENCE="$(mktemp -d /tmp/bsk-visual-acceptance.XXXXXX)"
node apps/extension/test-fixtures/visual-observation/probe.mjs "$VISUAL_EVIDENCE/browser-contract"
node apps/extension/test-fixtures/visual-observation/measure-render.mjs "$VISUAL_EVIDENCE/performance"
```

probe 需要 Node 22+ 和 Chrome，配置见 [fixture 说明](../../apps/extension/test-fixtures/visual-observation/README.md)。它验证浏览器事实，不代表后续生产模块已经通过。measure-render 用于旧 renderer 对照，不要求修复历史复杂度。

实现 PR 还需运行所属模块的新测试、`pnpm --filter @browser-skill/extension compile`、`pnpm ext:test` 和 `pnpm ext:build`。仅修改文档时检查链接和内容即可，不必重跑浏览器。已有失败应说明，不在范围外顺手修复。

## 每个 PR 怎么算完成

### PR 0：设计与复现

只有文档、合成 fixture 和诊断变动；架构、边界及后续 PR 的完成条件明确。现有测试通过；probe 的 checks 非空且全部通过（本版 39 项）；measure-render 产生五组 wide/deep 结果。

按下方浏览器步骤，在 main 重现“表格已绘制，但 observe 没有视觉入口”。合成页面和原始 iWiki 分别确认。原始页面未加载、无权限或缺入口时说明阻塞，不能算已复现。入库内容不含内部页面地址、标识或截图。

### PR 1：几何与身份

数值误差：纯函数输入允许 1e-6 CSS px；真实浏览器每条边允许 0.25 CSS px。坐标类型不能混传；动态 frame 归属需运行时检查。

| 怎么测 | 什么算成功 |
|---|---|
| top document bounds=(30,50,120,40)，document scroll=(10,20)，viewport=800×600 | top border region=(20,30,120,40)；不受 backing store 尺寸影响 |
| 使用 frame.html：local Canvas=(17,23,120,40)，same owner content origin=(50,610)；nested origin=(87,707)；OOPIF origin=(410,610) | top origins 分别=(67,633)、(104,730)、(427,633)；不能重复给 nested 加父偏移；owner border 不能代替 content |
| child scrollY=10；same frame owner origin 不变 | Canvas top y=623，local y=13；snapshot document y=23；scroll 只扣一次 |
| same iframe 以自身左上角为原点 scale(1.25)，原 border origin=(40,600)，border=10 | owner content origin=(52.5,612.5)，Canvas top=(73.75,641.25)，尺寸150×50 |
| Canvas content 120×40，border 每边5；overflow owner CSS width60/height30/border5/padding4 | Canvas region 宽130高50，live 验证同 box；owner clientRect=(5,5,68,38)，不能使用78×48 border范围作为clip |
| DPR=1/1.5/2，CSS Canvas120×40；UI zoom与CSS zoom分别处理 | DPR不直接除掉 CSS rect；raster 预测与实际图片分别记录；不以layout/css宽度比作为万能DPR |
| 分别构造缺失 owner、失效 frame、旋转、透视、mask、clip-path、活动pinch、变换的overflow祖先 | 前两项 geometry-unavailable，后六类 geometry-unsupported；无伪造精确 region ref、无按border猜偏移 |
| 同一操作并发请求同一frame 20次，再开启第二次操作 | 第一次每个metrics来源、owner quad、frame投影最多构建/请求一次；第二次重新获取；异常promise不泄漏到其他操作 |

### PR 2：采集与共享事实

| 怎么测 | 什么算成功 |
|---|---|
| target A/B 各含 backendNodeId=7，frame/document不同 | 两个lookup结果独立；AX join、overlay排除和父子查找不串target |
| 4个frame分属2个target，其中一个target有3份document；均成功采集 | 每target恰好一次DOMSnapshot；每frame恰好一次AX批次；失败重试不混入成功请求数；无按frame重复snapshot |
| 采集中模拟frame detach或loader/documentElement更换 | 丢弃受影响document的混合事实并标记原因；其他完整document可保留；不得把新AX接到旧DOM |
| 输入10,000深链、10,000兄弟、孤儿及A→B→A环 | 无栈溢出/无限循环；孤儿/环有明确不完整状态；不生成完整祖先证据；context推导每有效节点至多一次 |
| opacity0祖先；visibility:hidden祖先+visible子；aria-hidden/inert祖先 | 分别得到视觉透明、子可见、语义/交互状态独立；不折叠为同一个excluded |
| 一个frame采集失败，其他frame有语义节点；全部成功但无Canvas | 前者partial且保留其他语义；后者empty而非unavailable；错误原因可追踪到frame及阶段 |
| 注入CDP调用记录和hover探针；纯计算中途取消 | 所有静态DOM/AX捕获先于hover输入；取消后下一工作块不继续处理，未执行的输入/截图为0；取消不变成普通空结果 |

### PR 3：视觉发现

| 怎么测 | 什么算成功 |
|---|---|
| index.html?noFrames=1 的plain、named、aria-hidden、inert、pointer-none、visibility-override、hidden-overridden、fallback | 八个均为候选；无label不影响发现，有AX/fallback不抑制候选 |
| opacity-parent、display-none、visibility-hidden、zero、full-clip | 五个均无候选，原因分别能追踪到视觉/几何规则；不能把aria-hidden列为原因 |
| partial-clip、axis-clip、border-clip、border-canvas | crop尺寸分别60×30、60×40、64×34、130×50；边界来自client box/同种Canvas box |
| 同frame中删除语义parent，再保持DOM/几何不变 | 候选仍存在、地址不变；语义context可变为null；frame owner本身无法解析时不是该用例 |
| 连续两次输入同一只读Facts；对Facts启用深冻结 | 候选内容一致，无输入mutation，无CDP调用；去重前stack-a/b仍是两个候选 |
| 普通候选部分越出viewport；完全越界；overlay-owned Canvas；unsupported clip | 分别交集区域、无候选、排除、明确unsupported状态；不把未知状态伪装成empty |

### PR 4：选择与预算

预算按每个输出行的 `ceil(line.length/4)` 求和（UTF-16 length），包括头部和截断提示。H 为完整协议头成本，V 为固定行 `[visual] Canvas regions present; use screenshot` 的成本。

| 怎么测 | 什么算成功 |
|---|---|
| 同context：无名1000×800候选A，有名10×10候选B，K=1 | 选A；名称不能压倒区域面积 |
| 同document/parent且crop完全相同的A/B；另一个parent的C；crop右边相差0.01的D；相邻tile E | A/B仅输出一个代表；C/D/E独立保留；不输出layers=N作为业务解释 |
| 面积相同的候选随机打乱20次，地址/位置保持不变 | 排序相同；tie-break顺序固定为frameId、top y、left x、backendNodeId（同一观察内）；去重代表取该顺序最小者；字符串按代码单元字典序、数值按数值升序 |
| 50,001个不同key，最后一个为最大Canvas，K=1 | 最后最大者仍被选中；dedup key峰值≤50,000；标记dedup-degraded；未因容量耗尽停扫描 |
| 100,000候选、K=1/32/512；另测K=0 | 选中数量≤K、heap峰值≤K、exact-key之外的模糊pair比较为0；K=0不产生ref候选；结果与独立全排序小规模oracle一致 |
| 带blocking layer的纯输入，候选context在L1、背景、未知各一个 | L1优先，背景不标为物理不可见，未知不伪装L1；同层再按面积及固定 tie-break 排序；不修改Facts |
| 预算H-1 | 新observe规划返回insufficient-budget，工具映射invalid_params并给minimum=H；无新文本/ref提交；snapshot旧路径不改变 |
| 有候选，预算H、H+V-1、H+V | 前两个输出合法协议头、无悬空ref、truncated=true；H+V能保留固定视觉提示；全部账本≤预算 |
| 没有显式maxTokens，候选足够多 | 视觉附加部分cost≤2048；最终视觉条目≤512；不是对整个旧语义输出强加2048 |
| 标签含200个Unicode code point、引号、换行、代理对emoji | 标签先截至160 code point再JSON escape，按最终行核算；无断开的代理对，无换行注入额外条目；写不下的行不产生ref |
| finite预算取H+V、64、128、256、2048（小于H时拒绝），混合长短条目 | 每次总账本≤budget；输出决定可重复；已知omitted才给精确数，候选/去重组/上游未知数量不混加 |

### PR 5：类型化 ref

| 怎么测 | 什么算成功 |
|---|---|
| 注册DOM和visual-region两个判别目标 | kind决定操作资格；类型测试不能构造visual+interact矛盾状态；不额外接受调用者capability数组 |
| 同名ref置于两个session/tab；输入@e1与e1 | canonical形式可解析；不同session/tab不串目标；未知目标为既有not_found类错误 |
| 对visual ref调用click/fill/hover/select/get_html/人工帮助DOM定位入口 | 全部按主设计拒绝；CDP输入、DOM HTML读取、DOM高亮等该工具副作用次数为0；不能偷偷降为anchor操作 |
| loader变化、target重attach、documentElement替换；另测history.replaceState不改身份 | 前三者拒绝旧目标；最后不单凭URL变化拒绝；实际anchor仍需连接 |
| document.open保留loader/document backend但替换html和Canvas | 旧ref失效；只比较loader的实现必须被此测试击败 |
| 第二次observe重新绑定e1；第一次ref字符串再次输入 | 明确验证“最新观察映射”而非声称能识别旧字符串；新映射仅来自成功提交；旧DOM工具回归通过 |

### PR 6：截图执行

首次 clipScale 为 `min(1, 2048/(max(w,h)*r), sqrt(4000000/(w*h*r*r)))`；r 来自实际 metrics 适配，最终仍检查真实 PNG 尺寸。

| 怎么测 | 什么算成功 |
|---|---|
| visual ref解析成功并截图；DOM ref另测 | visual路径scrollIntoView次数0；DOM路径保持BASE策略；visual实时box种类与观察一致 |
| 同anchor四边分别移动0.249、0.25、0.251 CSS px；分别改尺寸/裁剪策略 | 前两种仅数值误差可接受，0.251拒绝；document/裁剪策略变化不受容差豁免；不靠old∩live返回小片段 |
| 保持身份/几何，重绘Canvas颜色；另移除Canvas | 重绘允许取得当前图像；移除拒绝；不承诺像素快照或把颜色改变误报为stale |
| css4096×2048,rasterEstimate2；css4000×4000,rasterEstimate1 | 首次clipScale分别0.25、0.5（不放大，取edge/area/1最小值）；实际成功尺寸每边≤2048、面积≤4,000,000 |
| mock第一次图片3000×3000，第二次2000×2000；再测两次均3000×3000 | 第一组重试一次并成功，第二组恰好两次后pixel-budget-exceeded；不能无限重试或返回超限图 |
| 空data、非法PNG头、0尺寸、负/非有限几何 | 明确失败，不能猜测width/height；此项不要求将PNG头检查宣称为完整解码校验 |
| capture前取消；overlay抑制后CDP失败；采集时出现dialog | 取消前不再capture；成功/失败/取消均恢复overlay；dialog机制保持既有契约；无额外输入 |

### PR 7：observe 接线

| 怎么测 | 什么算成功 |
|---|---|
| 固定SemanticScene，无视觉候选；普通预算，与BASE replay同一输入 | 语义文本、ref相对顺序、role/name一致；不因为新通道重跑semantic pipeline |
| 同SemanticScene加两个视觉候选，大预算 | 原DOM ref顺序不变，视觉ref在其后；每个输出ref均可在registry找到同目标，registry无未输出新ref |
| DOM文本多到耗尽除预留外的预算 | 固定视觉提示可见（预算允许时）；truncated=true；不是DOM stopped后无条件跳过视觉提示 |
| 视觉capture unavailable但语义成功 | 语义结果保留，观察状态能区分empty/unavailable/truncated；debug reason准确且无原始DOM泄漏 |
| snapshot、recording调用、hover probe on/off与BASE对比 | snapshot不新增visual；recording不隐式启用发现；probe默认off，on时仍在静态采集后；相应既有测试通过 |
| blocking layer混合DOM/visual、重复候选、不同预算 | 输出层策略与选择模块的活跃层策略一致；头、摘要、条目、occlusion/omitted行均纳入账本；无悬空ref |

### PR 8：整体验收

复跑上述模块测试、下方性能对照和浏览器场景，确认原始 iWiki 的缺口已解决。检查没有站点特判、重复的几何/预算权威实现或遗留的替代路径；没有顺带扩展到 OCR、逻辑画布聚合或旧算法重写。不能只凭合成页面通过宣布原始问题解决。

## 性能怎么验

在相关模块实现时检查，不拖到最后统一补。旧路径和新增 Canvas 成本分开看：

- **旧路径**：同输入对照 main/前置基线，已有 render/context/sibling 工作量、语义构建次数和 DOM 操作请求不增加；保留 #165 的回归。不要求消除旧算法的历史二次项。
- **无 Canvas**：允许必要检测与共享几何成本，但不构建视觉专用索引、不发视觉专用 CDP 请求、不重复跑语义链路。
- **新增树处理**：deep/wide 节点数取 1k、10k、100k；每节点 context 至多推导一次，每条边每个索引 pass 至多访问一次，pass 数不随规模增加。无递归溢出、每候选完整祖先遍历或全祖先数组复制。
- **选择**：候选数取 1k、10k、100k，K 取 1、32、512；堆峰值不超过 K，去重 key 不超过 50,000，无模糊两两比较。比较计数符合具体算法推导的上界；小规模结果与独立全排序对照一致，容量耗尽后仍能选中最后的大图。
- **请求与取消**：每 target 一次 snapshot、每 frame 一次 AX 批次；单次操作内几何请求共享，不跨操作复用 live cache。几何最大并发 4，新增计算每块最多 256 项并实际让出事件循环，取消后不再启动下一块。
- **接线后耗时**：同机器、浏览器和固定内容，分别测无 Canvas 页与合成表格页。各预热 3 次，再基线/新版本交替各 20 次，比较中位数和 p95；旧阶段与新增成本分开。旧阶段中位数增加超过 max(基线 10%, 2ms) 时复测，两轮均超过且可归因于改动则未通过；噪声无法排除则说明尚未确认。操作数仍须满足前述条件，不能用耗时阈值代替它们。

计数可以由测试插桩取得，不必为验收增加生产接口。性能结果只需说明旧路径是否回退、新增路径的规模与成本，不需要另填表格。

## 浏览器怎么验

### 合成表格（PR 0 复现；PR 7/8 验证修复）

1. 核实 `bsk --version`、`bsk browsers`、`bsk status`；运行 `pnpm ext:build`，确认用户已 reload `apps/extension/dist/chrome-mv3`。
2. 单独启动服务器：`python3 -m http.server 4177 --bind 127.0.0.1 --directory apps/extension/test-fixtures/visual-observation`。
3. `bsk session start --width 1440 --height 1100`，使用返回的 session id 打开下列页面。尖括号替换为实际值，每条命令传同一 session。

```sh
bsk navigate http://127.0.0.1:4177/table.html --session <session> --json
bsk observe --session <session> --json
bsk screenshot --session <session> --out <临时目录>/table.png --json
```

4. 把窗口放前台，实际看到三列六行后再采集 observe。load 完成、AX 工具栏出现或背景占位截图都不能证明表格已经绘制。
5. main 应有 Page action、Insert record、Filter 三个 DOM 控件，truncated=false，但无表格视觉入口。这是 PR 0 的缺口复现。
6. 新实现应保留三个控件，并增加 visual ref。用本次返回的 ref 执行 `bsk screenshot --ref <ref> --session <session> --out <临时目录>/crop.png`，实际查看图片：包含 Canvas column A/B/C 和六行，裁剪对应 780×360 CSS px 的表格区域，不能错到工具栏或 iframe 边框。PNG 满足每边 2048、总像素 4,000,000 的上限。无需生成单元格语义。

### 几何与动态场景

PR 1 验证实际生产几何模块；PR 6 验证截图执行；PR 8 复验完整链路。未接 observe 时可注入人工 facts/ref，但必须调用实际模块，不能以独立 probe 代替实现测试。

- 必测缩放集合：DPR 1/1.5/2 × top/frame；真实 UI zoom 100%/90% × top/frame；CSS zoom 1.25 的 top Canvas；frame scale 1.25 的 same/nested/OOPIF。按 PR 1 的坐标预期核对。OOPIF 需确认实际 iframe target，跨 origin 本身不够。
- UI zoom 要通过浏览器菜单或原生快捷键确认，不能以 CSS zoom 或 pinch emulation 替代。旋转、mask、clip-path、活动 pinch、变换 overflow 按不支持策略降级，不输出猜测的精确 ref。
- 使用 `index.html?noFrames=1` 的 `#plain`，每个实验从 reload 后的新 ref 开始：平移 1px、宽度改为 121px → 旧 ref 截图要求重新观察；移除节点或 document.open → 旧目标失效；仅重绘颜色 → 截图成功且是新颜色。不要在重新 observe 后拿重用的 eN 字符串声称验证了旧 ref。
- visual ref 的 click/fill/hover/select/get_html/DOM 高亮拒绝测试只在合成页或自动测试运行，确认拒绝前没有派发输入、读 HTML 或高亮副作用。

### 原始 iWiki（PR 0 与 PR 8）

入口与就绪说明在本机临时文件 `/private/tmp/bsk-visual-design/private-reproduction.md`。文件丢失或登录失效时向用户取得入口/权限，说明这一项未完成；继续独立的合成验证。

保持只读。前台实际看到表格后采集 observe 和截图：PR 0 确认缺口；PR 8 确认外围 DOM 控件仍在、新 visual ref 能截到实际表格。不要编辑单元格，不要求原页面永久维持历史的 63 个 ref。私有内容不入库。

结束后停止自己的 session、服务器及临时 Chrome，恢复修改过的 zoom/emulation，不关闭其他任务资源。

## 做完怎么回复

直接告诉用户：验了哪个 PR、跑了什么、是否符合上述成功条件；若有失败或未做的检查，说明具体原因。必要时附关键测试输出或截图路径。无需单独报告文件、hash 清单、状态统计或全量日志归档；没运行、被跳过或受阻的项目不要写成通过。
