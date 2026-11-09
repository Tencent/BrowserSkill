# 六个公网站点：真实任务与验收

每站独立 session、显式 browser、capture 在导航前启动，保存最终 URL/标题/截图/原始观察。读取网站当次真实结构，refs、选择器和推荐卡片可能变化，不能复用旧日志。全部动作使用候选 Bsk。

巨量引擎、淘宝除下面的evaluate场景，还必须执行 [dynamic-pages.md](dynamic-pages.md) 中各自独立的wheel场景：运行中轮播下至少四次滚轮、八次前后求值，包含规划延迟变体，并验证实际滚动和轮播持续变化。

## 巨量引擎 https://www.oceanengine.com/

1. 打开首页，检查实际内容已加载；观察导航、主视觉、轮播指示器/前后按钮。记录是否登录/地区/同意弹层影响。只做授权范围内的公开浏览。
2. 在鼠标不悬停轮播、不聚焦暂停热点的情况下，隔一个真实轮播周期采集至少两组视觉与 DOM 证据，证明幻灯片/图片 src、active indicator 或视频状态发生变化。仅有 setInterval 不证明轮播在工作。
3. **主回归：连续三次 fresh sync → evaluate**，每次 evaluate 都携带此次 sync 原始顶层 context/observation。同步完成就立即只读求值，不人为等待使 receipt 过期；调用之间让轮播真实前进。保留时间差、原始 receipt、argv、stdout/stderr，以及成功/拒绝结果。不得在同一次决策中偷换新 observation。
4. **自然规划延迟对照**：三次即时调用之外，再单独 sync → Bsk wait-ms 跨过一次实测轮播周期 → 使用该次原 receipt 只读 evaluate。记录 sync 到执行间隔及真实 slide 变化，模拟 Agent 思考期间背景变化；不得用第二次 sync 偷换 receipt。若拒绝，正向场景标失败，报告区分合同内保守限制与实现偏差，不把限制直接当未证实的实现 bug，也不能改成预期负例后声称100%。
5. 脚本返回 URL、title、h1、轮播可见图片/active slide 标识等读数据。检查 evaluate 的内部 ok/result，不只看进程退出码。至少一组求值横跨真实 slide 更新。可先用下面的通用只读探针，再依据页面真实结构限定 carousel 区域。
6. 测试实际轮播控件、hover 导航/下拉、滚动、进入公开产品介绍页→返回。逐步核对目标页面，而非仅输入已派发。

## 淘宝 https://www.taobao.com/

首页出现可关闭的登录弹层时，**先 observe/sync 定位关闭 icon，使用 Bsk click 关闭，再 fresh sync 确认 modal 消失、主页内容恢复可操作**。先用截图核对真正的 × 关闭图标；二维码/密码切换 icon 不是关闭。VOM 没有关闭 ref 时，用 Bsk screenshot + get-html 或只读 evaluate 确认真实 DOM，再用 Bsk click 操作唯一的已观察 CSS 目标。关闭图标可能在 iframe 外的父页面。不能猜 CSS、按隐藏 DOM 提取或直接删除弹层节点。关闭成功后继续所有测试，不能因为曾出现登录层就将整站记 blocked。

可能叠加多个登录弹层：每关闭一层都 fresh sync 检查，辨认当前最上层再关闭，直到主页恢复单层可操作，不盲目重复旧 ref。关闭图标可能是父文档中没有语义标签的 img，不能将 iframe 内的登录方式切换当成关闭；定位时重新核对结构、唯一匹配和可见性，不固化网站生成的 class 名称。

执行同样的 active 轮播证据与三次 fresh sync → evaluate；商品流不断刷新不能通过关闭脚本/等待整页永远静止规避。

另做两个业务场景：

- 至少提取 **10 个真实加载的商品卡片**，每项保留标题、当前页面展示价、图片、商品链接与源卡片证据。图片 alt 不等于标题，划线原价不等于当前展示价。字段关系以同一 card 容器为边界；缺失不能从相邻卡片拼出。
- 滚动至少 **两批**，记录滚动前后商品去重、图片 src/srcset/currentSrc/naturalWidth 与可见性，验证 lazy loading。打开一个可公开访问的详情页再返回，核对商品对应。禁止加购/下单/收藏/发消息。

仅在按实际关闭控件关闭后仍是登录墙，或关闭控件确实不可用、出现验证码/网络错误，没有可验证的商品或轮播，将相关场景记 blocked；不能用搜索引擎缓存、站外商品或 Books 结果替代。需要用户完成的步骤使用 Bsk request-help；不登录完成时仍不满足 100%。

## 只读 evaluate 示例

通过 **Bsk evaluate** 执行，实际表达式参数形式以当前 `evaluate --help` 为准：

```javascript
JSON.stringify({
  url: location.href,
  title: document.title,
  h1: [...document.querySelectorAll('h1')].map(n => n.innerText),
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

这只是探针，不是固定商品解析器。矩形落在 viewport 内不证明元素未被 modal 遮挡；必须结合 observation 的 layer/occlusion 与截图核验，不能将登录弹层背后的商品提取算作可见商品场景通过。若多层 JSON 字符串需按实际返回 schema 解码并保存，不把未解码字符串当正确业务结果。

## 其余四站

| 网站 | 必做真实任务 | 验收 |
| --- | --- | --- |
| https://developer.mozilla.org/zh-CN/ | 搜索→结果→文档→返回，长文滚动 | 词、最终 URL、h1、正文/代码一致；无骨架/空白误判 |
| https://github.com/Tencent/BrowserSkill | 仓库 SPA 导航、README、一个公开文件、返回 | 最终路径及文件内容匹配；等待 hydration 后真实内容 |
| https://books.toscrape.com/ | 两页40条书籍、分页、图片 | 40个去重 URL；书名/价格/链接同卡片；图片完成加载 |
| https://news.ycombinator.com/ | 首页30条与一条讨论、返回 | rank/title/url 关系正确；score 缺失不串行，不杜撰 |

## 失败归因

当 `evaluate` 因 `observation_changed` 或其他 guard 失败：

- 保存 error code/reason/effect_state、phase、elapsed、同步到执行的时间、完整 observation；先检查脚本是否实际执行，不盲重试。
- 对照本地 `/carousel` active 与单独 paused 控制组。控制组成功不能覆盖 active 失败。
- 区分背景轮播导致的过宽 freshness、实际人类介入、导航或错误 receipt。只把证据能支持的结论写成缺陷；不确定原因要标待定位。
- 输出最小复现序列及错误传播、可恢复性、失败次数/总次数。不要只留最终一次成功。
