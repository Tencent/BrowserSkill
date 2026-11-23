# 八个公网站点：真实任务、边缘情况与 Benchmark 验收

每站独立 session、显式 browser、capture 在导航前启动，保存最终 URL/标题/截图/原始观察及 Benchmark 指标（交互轮次、动作数、单步与总耗时）。读取网站当次真实结构，refs、选择器和推荐卡片可能变化，不能复用旧日志。全部动作使用候选 Bsk。

巨量引擎、淘宝除下面的 `evaluate` 场景，还必须执行 [dynamic-pages.md](dynamic-pages.md) 中各自独立的 `wheel` 场景：运行中轮播下至少四次滚轮、八次前后求值，包含规划延迟变体，并验证实际滚动和轮播持续变化。

## 1. 巨量引擎 https://www.oceanengine.com/

1. 打开首页，检查实际内容已加载；观察导航、主视觉、轮播指示器/前后按钮。记录是否登录/地区/同意弹层影响。只做授权范围内的公开浏览。
2. 在鼠标不悬停轮播、不聚焦暂停热点的情况下，隔一个真实轮播周期采集至少两组视觉与 DOM 证据，证明幻灯片/图片 src、active indicator 或视频状态发生变化。仅有 setInterval 不证明轮播在工作。
3. **主回归：连续三次 fresh sync → evaluate**，每次 evaluate 都携带此次 sync 原始顶层 context/observation。同步完成就立即只读求值，不人为等待使 receipt 过期；调用之间让轮播真实前进。保留时间差、原始 receipt、argv、stdout/stderr，以及成功/拒绝结果。不得在同一次决策中偷换新 observation。
4. **自然规划延迟对照**：三次即时调用之外，再单独 sync → Bsk wait-ms 跨过一次实测轮播周期 → 使用该次原 receipt 只读 evaluate。记录 sync 到执行间隔及真实 slide 变化，模拟 Agent 思考期间背景变化；不得用第二次 sync 偷换 receipt。若拒绝，正向场景标失败，报告区分合同内保守限制与实现偏差。
5. 脚本返回 URL、title、h1、轮播可见图片/active slide 标识等读数据。检查 evaluate 的内部 ok/result，不只看进程退出码。至少一组求值横跨真实 slide 更新。
6. 测试实际轮播控件、hover 导航/下拉、滚动、进入公开产品介绍页→返回。逐步核对目标页面，而非仅输入已派发。

## 2. 淘宝 https://www.taobao.com/

首页出现可关闭的登录弹层时，**先 observe/sync 定位关闭 icon，使用 Bsk click 关闭，再 fresh sync 确认 modal 消失、主页内容恢复可操作**。先用截图核对真正的 × 关闭图标；二维码/密码切换 icon 不是关闭。VOM 没有关闭 ref 时，用 Bsk screenshot + get-html 或只读 evaluate 确认真实 DOM，再用 Bsk click 操作唯一的已观察 CSS 目标。关闭图标可能在 iframe 外的父页面。不能猜 CSS、按隐藏 DOM 提取或直接删除弹层节点。关闭成功后继续所有测试，不能因为曾出现登录层就将整站记 blocked。

可能叠加多个登录弹层：每关闭一层都 fresh sync 检查，辨认当前最上层再关闭，直到主页恢复单层可操作，不盲目重复旧 ref。

执行同样的 active 轮播证据与三次 fresh sync → evaluate；另做两个业务场景：

- 至少提取 **10 个真实加载的商品卡片**，每项保留标题、当前页面展示价、图片、商品链接与源卡片证据。图片 alt 不等于标题，划线原价不等于当前展示价。字段关系以同一 card 容器为边界；缺失不能从相邻卡片拼出。
- 滚动至少 **两批**，记录滚动前后商品去重、图片 src/srcset/currentSrc/naturalWidth 与可见性，验证 lazy loading。打开一个可公开访问的详情页再返回，核对商品对应。禁止加购/下单/收藏/发消息。

## 3. 哔哩哔哩（真实视频网站） https://www.bilibili.com/

覆盖 `PUBLIC-BILIBILI-FEED` 与 `PUBLIC-BILIBILI-PLAYER` 两个必测场景：

1. **首页推荐流与分区加载（`PUBLIC-BILIBILI-FEED`）**：
   - 打开首页，若顶部或居中弹出登录引导浮层/桌面客户端下载提示，先用 Bsk 定位关闭按钮（或验证不遮挡主视图）并 fresh sync 确认主内容可交互。
   - 执行至少两次 `wheel` 向下滚动或点击“换一换”刷新推荐流，等待懒加载封面图完成加载。
   - 结合 `extract list` 与 `read`（`--fields-json`）提取至少 **10 条当前可见视频卡片**（视频标题、UP 主名称、播放量/弹幕数或时长、视频链接、封面图 `src`），核对同一卡片字段严格对应、无跨卡片错位串行，并截图留证。
2. **公开视频详情页与 HTML5 播放器交互（`PUBLIC-BILIBILI-PLAYER`）**：
   - 从首页进入一条公开视频播放页（`/video/BV...`），等待播放器容器与 `<video>` 节点挂载。
   - **边缘情况（自动弹出登录遮罩）**：B 站未登录播放一段时间或点击控件时常会弹出居中登录框并自动暂停视频。一旦出现，必须先通过 `cooperate sync` / `observe` 识别弹窗图层（`@layers`），使用 Bsk 点击关闭按钮，再 `cooperate sync` 确认遮罩消失，不能在遮罩阻挡下盲点底层播放器或直接删除 DOM。
   - 使用 `bsk read` 读取视频标题、UP 主、播放/弹幕统计及简介区域；使用 `bsk evaluate` 只读读取 `<video>` 真实状态（`readyState`、`duration`、`currentTime`、`paused`、`muted`、`videoWidth`）。
   - 使用 `bsk plan` 或 `bsk click` 执行安全只读交互（如展开视频简介、切换静音/播放状态或查看右侧相关视频列表），前后各截图一次核对视觉与 DOM 状态变化。
   - **安全红线**：严禁发送弹幕、点赞、投币、收藏、关注或发表评论。

## 4. V2EX（真实论坛社区网站） https://www.v2ex.com/

覆盖 `PUBLIC-FORUM-TOPICS` 与 `PUBLIC-FORUM-THREAD` 两个必测场景：

1. **节点切换、主题列表抽取与 Recipe 重放（`PUBLIC-FORUM-TOPICS`）**：
   - 打开首页，使用 `bsk plan` 或 `bsk step` 切换公开技术节点 Tab（如 `技术` `?tab=tech`、`创意` `?tab=creative` 或进入 `/go/programmer`），确认 URL 与列表同步更新。
   - 使用 `extract list` 与 `bsk read` 抽取至少 **20 条主题帖**（主题标题、所属节点名、发帖作者、最后回复时间/回复人、回复数气泡、帖子链接）。
   - **边缘情况（零回复帖字段缺失）**：刚发布的 0 回复帖子没有“最后回复人”或右侧回复数气泡；必须验证抽取结果中各列未发生错位串行，缺失字段保持为空或缺省。
   - 使用 `bsk recipe`（`save` + `run`）将“打开论坛首页 → 切换指定 Tab → 校验节点标题 → 提取首个热帖信息”固化为只读 Recipe 并重放验证 `status: "completed"`，对比手工单步交互与 Recipe 回放的交互轮次及耗时。
2. **帖子详情、楼层回复与代码块读取（`PUBLIC-FORUM-THREAD`）**：
   - 从主题列表中点击进入一条含多条回复的公开主题帖（`/t/...`），等待主帖正文与回复列表渲染。
   - 使用 `bsk read` 与 `get-html` 读取主帖标题、作者、正文（若含 `<pre>/<code>` 代码块则核对代码文本完整性）以及前 N 条楼层回复（楼层号 `#1..#N`、回复者、回复时间、回复正文）。
   - 使用 `wheel` 滚动浏览长楼层，随后执行 `navigate back` 返回主题列表页，核对最终 URL 与列表状态恢复。
   - **安全红线**：严禁注册/登录操作、发帖、回帖、感谢或屏蔽。

## 5. 其余四个公网站点

| 网站 | 场景 ID | 必做真实任务 | 验收 |
| --- | --- | --- | --- |
| https://developer.mozilla.org/zh-CN/ | `PUBLIC-MDN` | 搜索→结果→文档→返回，长文滚动 | 搜索词、最终 URL、h1、正文/代码块一致；无骨架/空白误判 |
| https://github.com/Tencent/BrowserSkill | `PUBLIC-GITHUB` | 仓库 SPA 导航、README、一个公开文件、返回 | 最终路径及文件内容匹配；等待 hydration 后真实内容 |
| https://books.toscrape.com/ | `PUBLIC-BOOKS` | 两页 40 条书籍、分页、图片 | 40 个去重 URL；书名/价格/链接同卡片；图片完成加载 |
| https://news.ycombinator.com/ | `PUBLIC-HN` | 首页 30 条与一条讨论、返回 | rank/title/url 关系正确；score 缺失不串行，不杜撰 |

## 只读 evaluate 探针示例

通过 **Bsk evaluate** 执行，实际表达式参数形式以当前 `evaluate --help` 为准：

```javascript
JSON.stringify({
  url: location.href,
  title: document.title,
  h1: [...document.querySelectorAll('h1')].map(n => n.innerText),
  videos: [...document.querySelectorAll('video')].map(v => ({
    readyState: v.readyState, paused: v.paused, muted: v.muted,
    currentTime: Number(v.currentTime.toFixed(2)), duration: Number((v.duration || 0).toFixed(2)),
    width: v.videoWidth, height: v.videoHeight
  })),
  images: [...document.images].filter(n => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
  }).slice(0, 40).map(n => ({
    alt: n.alt, src: n.getAttribute('src'), srcset: n.getAttribute('srcset'),
    currentSrc: n.currentSrc, naturalWidth: n.naturalWidth,
    x: n.getBoundingClientRect().x, y: n.getBoundingClientRect().y
  }))
})
```

矩形落在 viewport 内不证明元素未被 modal 遮挡；必须结合 observation 的 layer/occlusion 与截图核验，不能将登录弹层背后的商品或视频卡片算作可见场景通过。

## 失败归因

当 `evaluate`、`plan` 或 `recipe run` 因 `observation_changed`、`target_covered`、`handoff` 或其他 guard 失败：

- 保存 error code/reason/effect_state、phase、elapsed、同步到执行的时间、完整 observation；先检查是否已产生实际副作用，绝不盲重试。
- 对照本地合成页（`/carousel`、`/plan-recipe-lab`、`/video-portal`、`/forum-hub`）与公网实测结果。
- 区分背景动画/弹层引起的保护性拒止、实际人类介入、导航或错误 receipt。只把证据能支持的结论写成缺陷；输出最小复现序列、交互轮次、耗时及失败次数/总次数。
