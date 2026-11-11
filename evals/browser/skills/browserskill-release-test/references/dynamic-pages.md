# 持续变化页面上的 evaluate 与 wheel

这是一组必测正向场景。每秒变化页面与轮播页面分别覆盖两条命令；不能用其中一类的成功结果代替另一类，也不能用静态或暂停后的控制组代替动态组。所有浏览器操作均走本轮固定候选 Bsk。

## 场景矩阵

| 页面 | evaluate | wheel |
| --- | --- | --- |
| 本地 `/live-update`，文字/时间/价格每1000ms变化 | DYNAMIC-SECOND-EVALUATE | DYNAMIC-SECOND-WHEEL |
| 本地 `/carousel`，图片/slide每400ms变化 | CAROUSEL-EVALUATE-DRIFT | CAROUSEL-WHEEL |
| 巨量引擎真实运行中的轮播 | PUBLIC-OCEAN-CAROUSEL | PUBLIC-OCEAN-WHEEL |
| 淘宝关闭登录层后真实运行中的轮播 | PUBLIC-TAOBAO-CAROUSEL | PUBLIC-TAOBAO-WHEEL |

公网前置任务和登录层关闭步骤见 [public-sites.md](public-sites.md)。本地两页均有足够长的正文与可双向滚动的 nested 容器，避免在根本没有滚动空间的短页上误判 wheel。

## 共同前提与取证

- 先证明页面实际在变化：至少两次不同的tick/时间/价格，或slide/图片/active indicator，配合Bsk截图及本轮时间戳。定时器设置为1000ms不证明后台节流时仍每秒更新；没有实测变化就不能算动态组已覆盖。
- 保持更新运行。禁止暂停轮播、清除timer、冻结DOM、关guard、隐藏动画、直接设置滚动位置。普通页面业务内容不因探针而修改。
- 每次脚本/滚轮动作按当前Bsk合同携带独立sync的context和顶层observation。求值前使用的receipt不能顺手复用于后续wheel；wheel后也需重新sync才能求值验收。
- 留存全部sync/receipt、命令argv、原始结果、时间、截图和前后业务值。`observation_changed`、`target_covered`或其他拒绝也要保存code/reason/phase/effect_state；效果unknown先观察，不能盲重发。

## evaluate

每页至少三次即时调用和一次规划延迟调用：

1. fresh sync → 立即只读evaluate，核对内部 `ok:true` 及结果；调用之间用Bsk等待，让内容确实发生变化，再开始下一次独立取样。
2. 三次即时取样至少跨越一次真实内容更新；同一帧连续跑三次不够。
3. 单独的规划延迟组：fresh sync → Bsk wait-ms → 使用这次**原receipt**求值。`/live-update`至少等待2200ms并证明跨过两次更新；轮播等待实测的至少一个切换周期，本地400ms轮播可等待1000ms。不能在等待后再sync替换这组receipt。
4. 对照返回值与真实页面：`/live-update` 的 `#tick` 与 `#live-panel[data-tick]` 相同，`#price` 等于 `(100 + tick % 20).toFixed(2)`，更新时间可解析且前后递增。轮播的slide编号、图片alt/src或实际active indicator对应，样本之间确实变化。

脚本只读，不用evaluate模拟wheel、点击或填表。延迟组拒绝时，此正向场景失败；区分合同内保守限制和实现偏差，不把拒绝直接定性为已证实bug，也不事后改成预期负例洗成100%。

## wheel

每页至少四次独立wheel，每次均验证实际效果；次数不包含重试。参数形式以当次 `wheel --help` 为准。

本地两页覆盖：

1. 页面向下：在非底部位置使用正delta-y，确认scrollY增加。
2. 页面向上：已有向下空间时使用负delta-y，确认scrollY减少。
3. nested容器纵向：通过当次观察定位 `#nested-scroll` 或 `#carousel-scroll-box`，确认容器scrollTop增加；不要把target自动滚入视口造成的页面滚动误算为容器滚动。
4. nested容器横向：在非横向边界使用非零delta-x，确认scrollLeft沿预期方向变化。将这一项作为规划延迟变体：sync后等待上述真实更新周期，再用原receipt发送wheel。

公网两页覆盖小幅向下、向上、再向下，以及一次跨轮播周期的规划延迟wheel，至少四次。保持轮播至少部分可见，不将鼠标放到会暂停轮播的热点。选择有滚动空间的起点，避免顶/底边界造成合理的零滚动；按实测页面选择幅度，不要求网页严格滚动delta指定的像素数。公网没有nested/横向容器时，相关变体由本地页覆盖，不能跳过公网纵向wheel。

每次wheel都采用以下取证顺序：

- fresh sync → Bsk只读evaluate记录scrollY/容器scrollTop和scrollLeft，以及tick或slide状态。
- **另一次fresh sync** → Bsk wheel；规划延迟变体在这次sync之后等待，再使用其原receipt。
- 根据页面实际惯性/渲染作有界Bsk等待，fresh sync → Bsk只读evaluate记录滚动与动态值，并截图核对位置。四次wheel至少对应八次前后求值；若其中求值失败，不能跳过验收给wheel场景判通过。

确认滚动方向/容器正确、内容确实移动、背景更新仍继续。页面本轮合成事件 `dynamicWheelEvents` / `carouselWheelEvents` 提供delta、scope、tick/slide、时间佐证；nested事件会冒泡到window，不把两条scope日志当成重复发送了两次命令。必须检查实际scroll变化，派发成功、事件日志存在或exit0均不足以通过。

## 放行检查

新增六个独立场景进入固定plan，既有两个公网evaluate场景继续必测。`required_command_counts`要求至少四次evaluate，或四次wheel加八次前后evaluate；gate按**不同的真实record**计数，重复填写同一个UUID不能凑次数。gate只能核验命令次数及断言合同，Agent仍须逐项检查上述方向、目标、更新和延迟变体。

所有这些正向场景均需passed，才能满足100%门槛。静态组成功、换成scroll-to、JS滚动、隐藏错误或挑选重试结果都不能替代。
