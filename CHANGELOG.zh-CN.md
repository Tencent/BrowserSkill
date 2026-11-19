# 更新日志

BrowserSkill 的重要变更记录于此，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
CLI 和扩展可以分别发布，能否连接由协议兼容性决定。更新日志的中英文版本须在同一 PR 中同步更新。

## [Unreleased]

### 新增

- **MCP 100% 能力对齐**：新增 `bsk_ledger`、`bsk_debug`、`bsk_video` 与 `bsk_record` 一等工具，补齐现有工具全量 CLI 参数与动作（`session open/stop --all`、`sync` 等待/过滤、`wait_ms`、`view`、`screenshot`/`extract` 输出导出、`read` `context` 透传、`upload`/`download`、`tab_borrow`、完整 `emulate` 与 `operation_await` 文件保存），并通过请求级 `ClientContext` 统一 CLI 与 MCP 传输上下文。
- **编译期 `MethodSpec` 与 `RpcErrorReason` 全栈单一事实源**：为全部 77 个 RPC 方法建立无通配兜底的 `MethodSpec` 元数据并生成 TS 消费端，同时补齐并全栈枚举化 `RpcErrorReason` 及 CLI/MCP 双通道恢复提示（`cli_hint` / `mcp_hint`）。
- DeepSeek Harness（`dsh`）成为原生 skill 安装目标，支持通过 `bsk install-skill --harness dsh`
  安装（遵循 `$DSH_HOME`，默认为 `~/.dsh/skills`），`ImplicitScopeRegistry` 自动识别
  `DSH_SESSION_ID` 作为宿主子代理并发隔离作用域，且 MCP `bsk_session(action="start")`
  同步支持与 `bsk session start` 一致的 `agent_name`、`project` 与 `controller_color`
  控制方身份标识（#731）。

### 变更

- **`browser-driver/` 彻底封盒、必填 `CdpRunner` 与确定性 RAII V8 句柄释放、统一 `--selector` DOM 谓词及结构化 VOM 行元数据**：将 `CdpTarget`、`CdpFrame`、`CdpFrameGraph`、`sendToTarget`、`sendGuarded`、`sendAttached` 与 `getFrameGraph` 彻底封入 `apps/extension/src/browser-driver/` 内部，通过 `FrameDocumentHandle`、`FrameNodeHandle`、`FrameProcessBoundary` 与 `TabEventSource` 统一收口剩余全部上层模块（`read`、`extract`、`waits`、`wheel`、`drag`、`action-guard`、`vom/facts`、`AccessibilityLease`、`debug/`、`recording-runtime` 与 `geometry/frame-context`）；将 `CdpRunner` 接口方法全面提升为必填非可选契约，配套 `delegateCdpRunner`、`createStubCdpRunner` 以及确定性 RAII `withObjectGroup` / `withRemoteObject` V8 句柄释放（覆盖 `handleSelect`、`handleFill`、`handleFocus`/`handleBlur`、`action-checks`、`file-input-transaction`、`file-drop-transaction`、`waits`、`element-geometry`、`cdpRunnerForFrame` 与 `evaluate(return_by_value: false)`，不唤醒已断开标签页且不掩盖派发前错误）；在 `interaction`、`CooperationController`、`human-loop`、`read`、`extract` 与 `content/dom-primitives` 间统一跨帧、open Shadow DOM、`[data-bsk-overlay]` / `[data-bsk-overlay-host]` 排除、敏感 `autocomplete` 与交互式 ARIA 角色谓词；并将 `cooperate sync` 与 `observe` 统一收敛至 `@browser-skill/vom` 的结构化 `VomLineMetadata`（`inspectVomLine` 与 `VOM_DERIVED_NAME_CAP`）。
- **基于统一 `bsk` CLI 运行时的轻量 `@wxg-prc-cpg/browser-skill-dsh-plugin` 插件**：将 `packages/dsh-plugin-browserskill` 从原先约 2.2 万行的自定义 `bsk_*` 工具包装器与 Web UI 前端组件重构为极简 Cordis 插件（彻底移除 `@deepseek-ai/dsh-*` 宿主 `rc` 版本对等依赖锁），直接内嵌主仓唯一的 `crates/bsk-cli/skill` 资源包，自动为宿主补齐 `~/.local/bin`（`$BSK_INSTALL_DIR`）与自定义 `bskPath` 的 `PATH` 解析，并打包跨平台按需 `bsk` CLI 安装器与浏览器扩展连接引导流程（`bin/install-bsk.mjs` + `AGENT_INSTALL.md`），底层与其他所有 Agent 100% 共用标准 `bsk` CLI 与 `DSH_SESSION_ID` 自动作用域机制，同时恢复 `dsh-plugin-v*` 独立发版流水线。
- **Chrome MV3 `registration: "runtime"` 零税双层按需内容脚本注入、SW 启动期孤儿 Agent 窗口兜底回收与共享 `content/dom-primitives.ts`**：将全部 4 个 MV3 内容脚本入口（`content`、`cooperation.content`、`record-frame.content` 与 `long-screenshot-page.content`）以 `noScriptStartedPostMessage: true` 与 `claimIdempotentContentScript` 幂等守卫迁出静态 `manifest.json` `content_scripts`，彻底消除日常浏览普通网页时的全局 `<all_urls>` 内容脚本、`window.postMessage` 广播与 React 19 加载税；通过幂等 `ensureOverlayInjected` 对受控任务标签页、`webNavigation.onCommitted`（含 Speculation Rules 预渲染顶层帧，且严格排在 Tier B `cooperation.js` 激活/补注入之后）、确认前 `tab_borrow` 候选用户标签页、`request_help`、`record` 与活跃 `video` 浮层按 `tabId`/`documentId` 单点注入 Tier A（`content.js` 与 `long-screenshot-page.js`），并在 `hidden` / `CAPTURE_SUPPRESS` / `INPUT_PASSTHROUGH` 时跳过未注入标签页；在活跃会话或录制于 `0` 与 `>= 1` 间切换时以 `persistAcrossSessions: false` 动态启停纯 TS 轻量 Tier B（`cooperation.js` 与 `record-frame.js`），使其在 `document_start` 零 DOM 监听、零启动唤醒 IPC 静默加载并由后台按需点名激活（`COOPERATION_ARM_FRAME` / `RECORD_FRAME_START` 配合单标签页 50ms 子帧合并去抖、`injectRecordFrameAllFrames` 协同注入 `cooperation.js`，以及在 `tab_borrow`、`ack === undefined` 帧与动态插入的普通 DOM 或 open/closed `ShadowRoot` 内同源 `about:blank` / `srcdoc` 子帧上进行无损按帧探测补注入）；通过 `chrome.storage.session`（`bsk.orphan_agent_windows`）追踪独占 Agent 窗口创建的标签页集合，在 Service Worker 重启后精准回收无活跃会话的纯孤儿 Agent 窗口（严格保留含用户、借用或人工接管标签页的窗口）；并抽离共享 DOM 原语模块 `apps/extension/src/content/dom-primitives.ts`。
- **守护进程单一 `tool_pipeline` 工具管线、`daemon/ipc` 四模块拆解、无锁阻塞持久化与 `cli::orchestration` 客户端共享编排内核**：将 3,489 行的 `daemon/ipc.rs` 拆解为 `daemon/tool_pipeline.rs`（统一收口全部 `tool.*` 执行路径的 RAII `AuditTicketGuard`、`SessionActivityGuard`、`ToolInflightRegistry`、`IntentWal` 与作用域/运行日志结算）、`daemon/ipc_sessions.rs`、`daemon/ipc_transport.rs` 及精简路由层 `daemon/ipc.rs`；在 `bsk-protocol` 与 `daemon/tool_policy.rs` / `daemon/queue.rs` 中建立穷尽式 `OutcomeKind` / `Outcome` 结果与超时归因路由；通过局部状态分离与 `spawn_blocking` 将 `TransferRegistry` 大文件暂存/导入复制/会话销毁目录清理、`AuditStore` JSONL `sync_data()` 刷盘（含 `session.user_interrupt` 标记）与单调序号 `IntentWal` 刷盘及 `sync_data()` 原子压缩彻底移出全局状态 `Mutex` 与 Tokio 工作线程阻塞路径；并提取 `cli/orchestration.rs` 统一 `bsk` CLI 与 `bsk mcp` 的 Canvas 截图坐标点击校验、`open`/`sync`/动作/正数超时边界、显式 `--session` + `--browser` 冲突校验、缓存 VOM 回填以及 2 秒 `CANCEL_RESPONSE_GRACE` 优雅取消结算。
- **`bsk-protocol` 100% 强类型化、强类型 `EventFrame` 事件载荷、WS 信封相关性解耦与原生 `ActionMetadata` 单一事实源**：将 `Method::contract_meta` 中剩余全部 19 个 `serde_json::Value` RPC 契约（`ToolCooperate`、`LocalAuth*`、`AuditRequest`、`LedgerRequest`、`Session*`、`BrowserList`、`ToolOperationAwait` 与 `Transfer*`）收口为编译期强类型 Rust/JSON Schema 结构；将跨 Rust 与 TypeScript 的裸 `EventFrame.payload: Value` 升级为穷尽覆盖全部 10 类事件的强类型 `EventFrame` 判别联合；将扩展 WS 请求上的 `_audit_id` 与 `_operation_id` 迁出业务 `params` 并提升至 `RequestFrame` 顶层可选字段（彻底移除原地篡改 `params` 与扩展侧 `stripEnvelopeParams` 补偿剥离）；在全部 23 个 `Full` 与 9 个被动只读 `*Params` 结构中原生内嵌 `ActionMetadata` / `context_id` 并统一启用 `#[serde(deny_unknown_fields)]`（净删 `catalog.rs` 事后 JSON Schema 拼接补丁与 `daemon/ipc.rs` 手工拷出再塞回 4 个元字段的胶水代码）；并将 `MethodSpec.action_metadata`（`Full` / `ContextOnly` / `TabBindingContext` / `Dynamic` / `None`）打通为 `bsk-protocol` 与 `bsk-cli` 共享的唯一真源。
- **统一守护进程会话销毁入口、强类型 `IpcEnvelope` 与 MCP 宿主作用域生命周期**：将 `state.rs`、`ws.rs`、`ipc.rs`、`start.rs`、`session_requests.rs` 与 `sessions.rs` 中分散的 6 处会话清理路径统一收口至覆盖全部 12 张会话状态表的 `DaemonState::teardown_session(session_id, reason)`；在 `ImplicitScopeRegistry` 中将宿主子代理环境变量（`HOST_AGENT_ENV_KEYS`）优先级提升至瞬态 `mcp:<pid>:<nonce>` 之前，使同一宿主线程内的 `bsk mcp` 与 `bsk` CLI 自动共享隐式会话，同时仅对无宿主环境变量兜底的独占瞬态 `mcp:` 连接在 `stdio` EOF 或读取异常断开时立即停止并回收孤儿会话；为非活跃作用域墓碑与空闲 `start_locks` 增加 256 容量上限的 LRU 淘汰；并以通过 `StatusResult.ipc_envelope` 与 `DaemonInfo.ipc_envelope` 协商的强类型 `IpcEnvelope`（`IpcRequestMeta` / `IpcResponseMeta`，保留与升级期间未重启的 `"2.0"` 旧版 `bsk mcp`、CLI 及守护进程间的双向滚动升级兼容）及显式扩展 WS `WsCorrelation` 替代本地 IPC 载荷混装的私有 `_` 字段。
- **`ChromiumCdp` 单状态机与 `FrameNodeHandle` 寻址收口**：将 `ChromiumCdp` 原先散落的 33 张单标签页平行 `Map`/`Set` 收敛为唯一主表 `Map<TabId, TabAttachment>` 判别联合状态机（`detached | attaching | attached | soft_detached`），将 `onEvent(tabId, handler)` 改造为自动持有空闲租约的标签页级 `Disposable` 订阅，并通过 `FrameNodeHandle` 与 `FrameDocumentHandle` 将瞬态 `cdpSessionId` 彻底封入 `browser-driver/` 内部（全量覆盖 `RefStore`、VOM 视觉观测与截图坐标映射、`read`、`extract`、`observation`、`interaction`、`waits`、`human-loop`、`recording` 与 `CooperationController`）。
- **协议基线直升 `2.0`**：将 `PROTOCOL_VERSION` 与 `MIN_COMPATIBLE_PROTOCOL` 同步升至 `"2.0"`，清除扩展与守护进程间的握手版本漂移，并将 `apps/extension/src/transport/generated/validators.js` 体积削减 60% 以上（`~992 KB` -> `<= 390 KB`）。
- **收口守护进程/扩展分发与上下文全局状态**：以生成/穷尽的 `MethodSpec` 映射替代全栈 9 张手写方法表，并移除 `business_rpc.rs` 中的全局 `OnceLock` 上下文。
- 将所有真浏览器测试与回归套件的环境变量统一收敛至 `BSK_TEST_CHROME` 与 `BSK_TEST_CLI`（补齐 Windows `.exe` 后缀并在隔离 daemon 用例中清理宿主子代理作用域环境变量），将 `.browser.test.ts` 与 `.bench.ts` 从单元测试配置剥离至 `apps/extension/vitest.browser.config.ts` 与零跳过运行器 `scripts/run-browser-tests.mjs`（将 `pnpm --filter @browser-skill/extension test:browser` 统一路由至该运行器，强制校验 `skipped === 0`、每个套件存在有效断言以及多目标参数逐项命中），并在 CI 中接入全部扩展真浏览器测试套件、`eval:browser:check` 与 `eval:browser:dynamic-read`（#731、#732）。
- 将分散手写的默认守护进程端口、WebSocket URL、本地配对与远程鉴权协议常量、实例 ID 长度、JSON-RPC 标准错误码以及 `BASE_TOOL_NAMES` 统一收敛至 `bsk-protocol` / `bsk` 单一事实源（消除跨语言重复定义与脆弱的集合长度魔法断言），将 Rust 集成测试二进制从 51 个合并为 6 个并为 `dev`/`test` Profile 启用 `debug = "line-tables-only"`，将扩展 Vitest 单元测试拆分为 `threads` 并发池下的 `unit-node` 与 `unit-dom` 项目并清理冗余/恒真测试及合并单函数碎片用例，将多处固定墙钟睡眠替换为确定性虚拟时钟/时间戳/就绪态检查，新增 `copyIsolatedExtension` 以消除 CI 中重复的按端口全量构建扩展步骤，并在 `.github/workflows/ci.yml` 中增加 Cargo 缓存及合并测试步骤以缩短 CI 耗时。

### 修复

- 修复在未发生真人操作的情况下，`bsk evaluate` 或页面脚本调用 `document.execCommand('insertHTML' | 'delete' | 'insertText', ...)` 编辑富文本 `contenteditable`/表单，或调用 `<input type="checkbox">` / `<input type="radio">` / `<label>` 的 `.click()` 触发 Chromium 内置默认激活可信 `input`/`change` 事件时，被误判为人工接管并反复报错 `"the user has control of this tab"`（`human_intervention` / `"User activity revoked this action"`）的问题：`cooperation-capture.ts` 现追踪同任务内非可信程序化点击触发的 checkbox/radio 同步默认激活事件，并忽略无前置 `beforeinput`/键盘/指针/滚轮/拖放/IME 合成事件的可编辑区裸 `InputEvent("input")`（及其同任务失焦 `change`），同时正常推进 `fields`/`revision` 并完整保留全部真实人工交互检测；将 `CooperationController` 执行前瞬态就绪轮询（`target_hidden` / `target_disabled` / `target_readonly`）上限收敛至 `5s`（并在显式短 `timeout_ms` 下预留回复余量），使点击 WeUI 隐藏复选框等永久不可见控件时快速返回结构化 `target_hidden`（`effect_state: "none"`），不再挂满 30 秒/2 分钟被守护进程通用 RPC 超时吞掉真因；同时在 `manageTabs` 与 `tool.tab_close` 中对非借用的自有 Agent 标签页（含曾人工保留转入 `observedTabs` 的标签页）放行已结算 `page_load_failed` 错误页，避免单个加载失败标签页把整个会话的 `tab_create`、`tab_select` 与 `tab_close` 锁死在 `"shared page control or observation changed"`。
- 修复在飞书多维表格（Lark Base / Feishu Bitable）等重型 Canvas / CSS-in-JS Web 应用上高频报错 `"A page frame is not responding"`（`cooperation_sync_required`）并锁死会话的问题：在 `cooperation-capture.ts` 的 `styleFacts()` 中遇到任意跨源不可读样式表时立即短路退出，不再徒劳遍历并拼接全部内联 CSSOM `rule.cssText` 字符串，跳过 `@font-face` / `@keyframes` 规则、将 `invisibleAttribute` 样式核查推迟至结构化 `childList` 过滤之后并直接提取 `data-*` 属性名（`/^data-[-\w]+$/`），同时将 `dom-primitives.ts` 与 `cooperation-capture.ts` 中的二次方复杂度 `querySelectorAll("*")` / `closest()` / 无差别 `chrome.dom.openOrClosedShadowRoot` 调用替换为带子树剪枝的 `TreeWalker` 与合法 ShadowHost 标签过滤；打通 `bsk open`、`bsk sync`、`bsk cooperate sync|enable|wait` 及 MCP `bsk_session(open|sync)` 的 `timeout_ms`（最高 `25000ms`，含默认 `15000ms` 的 `cooperate wait` 及 `evaluate`/`upload` 动作后帧状态刷新，并同步放宽守护进程传输超时与 CLI/MCP IPC 快照余量）与 `AbortSignal` 至 `collectCooperationFrames`，对单帧保持唯一在途 `COOPERATION_READ` 请求避免重复探测风暴，同时在满 `3000ms` 后提前判定并剔除静默隐藏子帧、在 `--settle` 中支持文档观测中途切换的自动重试并将多轮重试严格约束在调用方剩余墙钟 `timeout_ms` 预算内；扩展 `hidden-frames.ts` 的 `ownedByHiddenElement` 以识别未聚焦的 `pointer-events: none` 与屏外 `position: fixed` 子帧、兼容含非文档 `<object>`/`<embed>` 或未导航 `<iframe>` 占位符的父页面（`owners.length >= siblings.length`），并通过精确 URL 优先于同源回退的宿主 `declaredSrc` 配对机制在同页存在可见跨源小组件时安全区分静默隐藏的跨源会话刷新帧或第三方扩展子帧；允许 `navigate`、`reload`、`navigate_back` 与 `navigate_forward` 直接逃离卡在 `FrameUnresponsiveError`（含残留未提交 `pendingUrl` 或已触发 `CdpReadGate` 熔断的标签页）或 `frame_unobservable` 的受控标签页（含跨文档动作后 `ImplicitScopeRegistry` 自动注入旧 `target` `context_id` 的恢复场景，按比例收敛短 `timeout_ms` 入口刷新耗时，并在 `navigation.ts` 中将前置 CDP 探测及 `Page.getFrameTree` / `networkidle` 提交后恢复握手统一约束在剩余 `timeout_ms` 内且保留原始超时诊断数值）；同时为 `executeScript`（`ensureOverlayInjected`、`injectCooperationAllFrames`、`injectRecordFrameAllFrames` 与 `armCommittedFrame`）、`pushOverlayStateForTab`、悬停/录制 `bypassOverlay`、`RECORD_FRAME_START` / 录制 `sendToTab` / `waitForDocumentSettled`（以及 `RecordFrameCoordinator.stop` 对已证隐藏子帧的容忍）、`CAPTURE_SUPPRESS` / `VIDEO_OVERLAY` 浮层收尾与截图回退、`resetAgentOverlays` 与 `COOPERATION_ARM_FRAME` 统一增加有界超时上限，配合 `chrome.alarms` 唤醒补发应用层心跳，防止卡死标签页拖死 `session stop`、`navigate`、`screenshot`、`record` 或 `video` 及触发 MV3 Service Worker 5 分钟 `kRequestTimeout` 强杀（#766）。
- 修复 `bsk window resize` 在分数倍显示缩放（如 Windows 10 125%）下必然失败的问题：外框尺寸在各轴 2 px DIP 取整容差内（如请求 `1100x700` 实测 `1101x701`）时，现按请求尺寸判为成功并返回实测边界，不再空转一轮沉降重试后报 `protocol_error` / `window_resize_constrained` / 退出码 `2`；真正被窗口管理器约束的尺寸仍报同一原因，`window_resize_viewport_unchanged` 校验保持不变（#771）。
- 修复 `iframe` 内隐藏 `<input type="file">` 上传组件（如 Layui 的 `display: none` 文件上传）及
  `--selector` 跨框架匹配问题（#725）：交互动作与 `wait-for-element` 的 CSS `--selector` 在主文档未命中或需严格唯一性校验时，基于 `FrameDocumentHandle` 跳过无关 `DOM.getFrameOwner`（不污染几何缓存）并将子框架探针改为有界超时并发扫描与无响应 OOPIF `processKey` 隔离（命中歧义立即短路、保持框架图顺序，并在 `wait-for-element` 轮询期间容忍子框架导航过渡，在 `target` 共驾策略下执行跨框架歧义拦截并接入子框架 `frameEpoch` 变更失效守卫，同时保持 `expect` 前置条件的主文档作用域语义不变）；当 `upload`（默认 `input` 模式）直接解析到 `<input type="file">` 节点时，校验连接态、可用态与 `multiple` 约束后跳过视觉坐标点击与渲染帧等待，直接执行 `DOM.setFileInputFiles`；跨源 OOPIF 与同源跨框按钮触发上传确保子目标启用 `Page.enable` 并承接拦截选择器事件（含未挂载 DOM 的动态临时 `input[type=file]`）；并同步澄清 CLI、MCP 与内置 skill 的 `upload` 目标参数说明。
- 修复在 Chrome 157+ 应用商店与企业策略安装版本（限制对扩展自身 `video-offscreen.html` 离屏辅助文档的创建、枚举或 `chrome.debugger.attach` 附加）上，所有原生输入命令（`click`、`fill`、`press`、`wheel`、`drag`、`step`、`plan`）均报错 `"Native input clock calibration failed: Cannot attach to this target."`（`cdp_failed` / `input_clock_unavailable`）的问题：`sampleNativeInputClock` 与 `NativeInputClock` 在离屏探测目标无法创建、发现或附加时自动回退至零偏移墙钟时间戳派发（跨 `NativeInputClock.invalidate()` 缓存非瞬态探测限制以避免后续会话重复拉起离屏文档，同时完整保留原生派发前的 `sameClock` 单调时钟一致性门禁），并同步对齐 Chromium 158+ 在浏览器页面缩放下保留 `Input.dispatchMouseEvent` CSS 像素滚轮增量的真浏览器回归断言与说明文档（#742）。
- 修复现代 SPA 页面与含动态子 `<iframe>` 站点上高频误报 `"Page interaction coverage changed; wait and synchronize"`（`control_context_invalid` + `effect_state: "unknown"` 并触发守护进程 `IntentWal` 锁表）的系统性问题：通过 `ChromiumCdp.onRouteChanged`、`CooperationController.invalidateRoute` 与顶层帧 `FrameState.url` 将同文档 URL 更新（`pushState`、`replaceState` 与 `#hash`）同跨文档销毁解耦（同时在 `soft_detached` 重连与对话框关闭复核时恢复 `rootFrameId`、补齐同文档路由更新下的子帧对账，并移除同进程子 `<iframe>` 挂载/导航派发无参 `DOM.documentUpdated` 对顶层 `onDocumentChanged` 的误触发），不再将存活采集器误标为 `unavailable`，使多步动作（`fill`、`scroll-to`、`wheel`、`press`、`select`、`click`、`drag`）及 `bsk plan` 批处理在同路径查询参数或锚点更新下完整执行并保持 `target` 上下文可用（同时消费无锚点动作所需的严格基线），而在跨路径/Hash 路由跳转时待当前动作正常结算后再以 `effect_state: "none"` 失效旧上下文与引用；支持自动提交表单的 `fill` 在 `onBeforeNavigate` 及瞬时提交销毁旧执行上下文（`finalValueAlreadyNotified`）两种时序下正常完成 Step 3 回执，并放行已启动原生输入动作在 `onBeforeNavigate` 后的主帧/子帧收尾测量（`Runtime.callFunctionOn` 与 `DOM.getBoxModel`）；将后台 `observeTab` 排在 `armCommittedFrame` 之后、支持 `COOPERATION_ARM` 与 `COOPERATION_RESUME` 为新挂载子帧初始化采集租约、允许 `collectCooperationFrames` 在已证隐藏的受限子帧旁完成兄弟子帧替换重采，并隔离非持有方并发 `refresh` 失败（`observeTab`、`status`、`wait` 及带参被动 `read`）对在途 `state.working` 操作与 `target` 上下文的污染；同时保留导航失败及携带结构化 `result.data.reason`（如 `download_capture_failed`、`fill_target_changed`）的真实错误回执，在守护进程 `ImplicitScopeRegistry` 中精准吊销已失效的隐式 `target` 自动注入上下文（完整保留 `last_vom` 与短别名以支持后续 `unchanged`/`delta` 同步回填），并支持在 `page_load_failed` 错误页上通过 `navigate`/`reload`/`navigate_back`/`navigate_forward` 直接恢复标签页（#762）。
- 修复 `ToolDispatcher` 持久后台执行租约下失焦或最小化窗口上的 `tool.wheel` 因耦合临时 `restoreFocus` 而跳过合成器渲染就绪检查（`waitForInputPaint`）的问题（将 `ReadyInput.hidden` 拆耦为 `lacksForegroundPresentation` 并在 `ToolDispatcher` 注入 `windowsApi`）；修复 `CooperationController` 在 `target` 策略下执行 `--selector` 动作时污染 `session.refStore`、误输出 `used_ref`（同时保留 `--selector` 动作回执的 `used_selector` 且不污染 `tool.drag` 的 `DragResult` 与 `tool.press` 的 `PressResult`）或在 `handleSelect` 自定义下拉报错引导中泄漏伪造 `@eN` 引用的问题（改用请求级 `withPinnedSelectorTargets`）；在 `target` 策略脚本写 DOM 前于 `CooperationController.beginDomMutation()` 内主动刷新实时帧活动，并在写入前校验以 `effect_state: "none"` 失败时保留 `state.baseline`（`observation_id`）；修复 `clearRecordingForSession` 未使用调用方/派发器注入 `deps`（`RECORD_CANCEL` + `bypassOverlay(tabId, false)`）的问题，将 `returnBorrowedTab` 的 `isAgentWindowId` 设为必填契约以防归还借用标签页误落入其他会话的 Agent 窗口，以实例级 `DownloadConcurrencyGate`（`session_busy`、`effect_state: "none"`、`dispatched: false`）替换模块级全局下载锁，并在会话销毁及 `tabs.onRemoved` 时完整清理 `observeIdentityStreaks`、`hoverLatches` 与 `hoverBypassTabs`；补齐 `cooperate sync` 对 Canvas `[visual:screenshot]` `@eN` 引用的对齐，将 `renderDoubleLayer` 底部 `L2 page … occluded by L1` 遮挡汇总行纳入 `maxTokens` 预算核算，并将弹出状态标签 `[expanded]` / `[has-submenu]` 从 `vom.name` 迁至引号后 VOM 标签以消除自定义下拉重复输出 `[expanded]`。
- 消除 `guardedRunner.runBrowserMutation`（`action-guard.ts`）中重复的连续整标签页帧状态采集、跳过 `handleFullPageScreenshot` 中只读 `inspect` 探测步骤的变更门禁，并将协作帧 IPC 响应超时阈值（`FRAME_REPLY_TIMEOUT_MS` / `OWNER_REPLY_MS`）从 `1200ms` 放宽至 `3000ms`，防止高分屏（2x DPR）/ 软光栅冷启动与按需浮层挂载期间误报 `FrameUnresponsiveError`（#761）。
- 为 `bsk step`、`bsk plan`、MCP `bsk_interact`（搭配 `sync_after` 或 `until_visible`）及 `bsk_plan` 补齐 `--max-tokens`（MCP 为 `max_tokens`）参数并透传至后置 `tool.cooperate` 同步请求，解决此前硬编码 `None` 导致带预算会话在后续动作触发 `token_budget_changed` 并回退为整页无上限重采的问题（#755）。
- 在 `cooperation-capture.ts` 中忽略扩展内部私有 `data-bsk-*` 属性与 `<browser-skill-overlay>`（`[data-bsk-overlay]`）ShadowHost 变更以消除录制/敏感字段标记对 `FrameState.structure` 的自污染，在 `record-capture.ts`、`record-hover-surface.ts` 与 `cooperation-capture.ts` 中统一过滤扩展自身 ShadowRoot 浮层控件（`HelpRequestOverlay`、`RecordOverlay`、`BorrowConfirmationOverlay`）防止浮层内点击/输入或悬停面被误录为网页操作，并在 `ensureOverlayInjected` 异步注入完成后二次校验标签页受控归属以杜绝注入途中断开控制导致的陈旧浮层闪现。
- VOM Token 估算现在能处理未配对的 UTF-16 代理字符，不会再误合并后续符号或抛出 `RangeError`；有效 emoji 代理对的估算保持不变。

- 修复非 `start` 的 `tool.video`（`status`/`stop`/`list`/`get`/`delete`）、`tool.operation_await` 与作用域绑定的 `tool.wait_ms` 未接入 `ToolInflightRegistry` 而在 `session.user_interrupt` 及 `DaemonState::teardown_session`（`session.window_closed` / 空闲超时回收 / 断连）时无法立即唤醒取消与转发 WS `cancel` 的问题（同时补齐作用域绑定 `tool.wait_ms` 的 `SessionActivityGuard` 空闲租约，并修复 `ToolDialogAccept`/`ToolDialogDismiss` 等待 `decision_lock` 被中断或销毁时丢失 `UserAborted`/`SessionEnded` 错误原因的问题），修复 `IntentWal` `flush_pending_async` 在并发已被取出的 `DISPATCHED` 批次落盘前提前返回以及 `on_session_ended` 未将会话结束对账持久化导致 daemon 重启后误冻已关闭会话的竞态，修复 `queue.rs` 在非文件传输工具（`navigate`、`screenshot_full_page`、`window_resize` 等）发生超时取消清理挂起时被兜底分支误报为 `"file transfer timed out"`（`transfer_outcome_unknown`）以及在文件传输取消清理完成（含携带会话终止 `reason` 时）丢弃扩展侧 `effect_state` / `cancelled_before_dispatch` 元数据的缺陷，修复 `bsk` CLI 与 MCP（`bsk_interact`、`bsk_page`、`bsk_inspect`、`bsk_tabs`、`bsk_assist`）间的 Canvas 截图坐标点击与零值超时校验漂移（同时对齐 `bsk sync --wait-for/--wait-not --timeout-ms` `120000`ms 上限与 MCP `bsk_session(open)` 的结构化 `scope_browser_conflict` 错误），并修复 MCP `notifications/cancelled` 在 `0`ms 直接丢弃在途 IPC 请求而丢失真实 `effect_state` 及在 `cancelled_before_dispatch` 时泄漏已暂存上传文件的缺陷。
- 修复 `dump-schema --method <name> --output` 误导出输入 Schema 而非 `output_schema` 的缺陷，修复 `scripts/protocol.mjs` 未沿 `$ref` 传递闭包将纯输入嵌套类型（如 `ActionExpectation`、`CookieFilter`、`UserAgentBrandVersion`）重导出至 `transport/generated/input.ts` 的问题，修复 MCP `strip_schema` 无差别清空 `tools/list` `inputSchema` 中参数及嵌套属性 `description` 文档注释的问题（仅在 `depth == 0` 剥离根结构体注释，并在折叠 `Option<T>` 时保留内层 `oneOf` 合法 `null` 分支），将 `LoggedStep::Action.modifiers` 收口为强类型 `Option<Vec<KeyModifier>>` 并堵住 `RunLogs` 在 `modifiers: []` / `null` / `["shift"]` 下绕过 `character_key` 单字符输入隐私过滤的漏洞，为扩展 `CooperationController.command` 补齐 `CooperateResult` 强类型返回约束并修复 `cooperate wait` 期间标签页关闭/释放导致空转超时及返回 `state: undefined` 的竞态，为空载荷 `EventFrame` 变体兼容显式 `"payload": null`，并将 `bsk sync` 活动映射测试对齐真实 `CooperateActivity` 线契约。
- 通过 RAII `SessionActivityGuard` 活跃租约修复 `Unlocked` 工具调用、`operation await`、`debug(activity|wait)`、`video`、`ledger` 及 `session.run_log` 执行期间被空闲超时误回收会话的问题；将 `ToolDialogAccept` 升级为 `cancel_at_deadline: true` + `EffectAwareAction` 并通过会话级 `dialog_operations` 决策互斥锁与 `IntentWal` 串行化对账；仅在显式声明 `bind_scope || reuse_or_start_scope` 时写入 `ImplicitScopeRegistry` 以防止 `record` 与 `recipe` 临时会话覆盖或墓碑化调用方当前绑定的隐式会话；移除 `IntentWal` 对错误自然语言子串的脆弱匹配，统一在扩展 `CooperationController`（含 `bootstrap` / `strict` / `target`）、`Dispatcher`、`dialog-control` 与守护进程 `queue` 上输出结构化 `dispatched: false` / `effect_state` 元数据；将 `ErrorCode::UserAborted` 纳入 `IntentWal` `Unknown` 冻结态并按真实目标 `tab_id` 精确归属多标签页账本；同时在超过 32 条环形缓冲上限时钉住已打开标签页的当前活跃 `cN`/`oN` 短别名。
- 补齐 #737 之后 CLI、MCP 与守护进程侧 VOM 缓存复用的最后一公里闭环：在 `bsk sync --json` 中补齐 `observation` 与 `observation_origin`（并在 `bsk view` 中兼容解析 `{ "vom": ... }` 回执）以直接无缝衔接 `bsk view` 与 `--baseline`；在 `authoritative_full_vom`（使 `--wait-for`/`--wait-not` 无需冗余回退 `tool.snapshot`）及 MCP `bsk_session(open|sync)` 中复用 `unchanged` 与纯文本行补丁 `delta` 的 `scope_meta.cached_vom`；在守护进程侧将精简 `delta` 补齐后的 VOM 注入 `RunLogs` 并按 `tab_id` 隔离多标签页 `known`/`masked` 敏感引用表；在 `bsk plan` 与 `bsk_plan` 批处理首步自动解析后向后续步骤 `1..N` 固定透传同一 `session_id`/`tab_id`/`context_id`；打通 Windows 命名管道服务端与客户端的 `endpoint_pipe_name` 映射，并扩展跨平台 Windows 守护进程 CI 单元与集成测试门禁及同步更新 `2.0` 协议与 Skill 参考文档。
- 修复会话空闲超时回收遗漏 `dialog_operations.remove_session` 且在后续浏览器断连时被覆盖丢失 `session_idle_timeout` 结束原因的缺陷，修复未认领 `session_requests` 清理遗漏 `dialog_operations`、`scopes` 与 `intent_wal` 的问题，并打通 `DialogOperation` 异步结算后的统一对账闭环（`scopes`、`intent_wal` 与 `run_logs`），使因 `DialogPending` 挂起并通过 `dialog accept/dismiss` + `operation await` 完成的操作在 `run_logs` 中原位更新为真实完成态而非滞留 `Uncertain`。
- 修复 `--max-tokens` 截断基线误短路后续无预算或不同预算 `bsk sync` 的问题（在 `strict` 与 `target` 策略下同步记录 `maxTokens`/`truncated` 并在预算变化时发出 `baseline_reason: "token_budget_changed"`，同时在守护进程侧校验前置观测与预算兼容性）；支持在 `target` 策略纯文本 `delta`（含相同 `--max-tokens` 预算下的截断观测与空白折叠空补丁）携带行补丁时原位更新缓存 `last_vom`，并在遇到不含行补丁的表单 `field` 变更时主动清空 `last_vom` 以防 `bsk sync --match-text` 误匹配旧输入值；在 `bsk sync` 缓存补齐与回执渲染中完整保留 `truncated`、`capture_truncated`、`next_cursor` 与 `presentation` 元数据；并为 `--wait-for` 补齐与 `--wait-not` 对称的 `--max-tokens` 截断全页 `tool.snapshot` 回退检查与引用重同步。
- 修复跨源 OOPIF 内 `visual-region` `@eN` 视觉引用与 `--capture-id` 坐标点击在 75 秒空闲 Soft-Detach 重连分配新内部子会话 `sessionId`（`frameId + loaderId` 未变）后误报 `visual_target_changed` 断裂的缺陷，在子帧导航切换 `loaderId` 或同一 `loaderId` 下调用 `document.open()` 替换文档时确定性拒绝过期 `FrameNodeHandle` / `FrameDocumentHandle` 目标，并修复单次 `console` / `network` 读取及 `debug start -> stop` 释放租约后永久阻塞 75 秒空闲 Soft-Detach 的粘滞问题。
- 修复 `tool.debug`（`replay`）绕过原生弹窗挂起门禁、`intent_wal` 漏掉 `download`/`dialog_accept`/`debug(replay)`/`navigate`/`reload` 以及 `window_resize`/`emulate`/`tab_close` 丢失 `EffectAwareAction` 超时策略的缺陷。
- 修复 MCP 错误恢复提示直接回显 CLI 专属命令（如 `bsk ledger resolve`）、`tool.video` 漏掉 `discard`/`exported` 协作动作、调试证据分类遗漏 `navigate_back`/`forward`/`dialog_*`、审计 UI 标签缺失以及 `recipe` `session_gone` 漏判 `session_stopped`/`no_active_session` 的问题。
- 修复 macOS 与 Linux/X11 Chromium 下后台创建或初始化 Agent 窗口及标签页抢占用户前台窗口焦点的问题（Linux 下 `chromeAgentWindowApi.create` 先创建非激活标签页再通过 `tabId` 建窗以规避 Chromium `Navigate()` `kShowWindow` 抢焦，且排除其他活跃或创建中的 Agent 窗口防跨会话串窗；macOS 下 `tool.tab_create` 与 `ensureActiveTab` 先创建非激活标签页再通过 `chrome.tabs.update` 在目标窗口内选中，建窗或激活失败时自动关闭新建标签页并在清理亦失败时认领至 `agentCreatedTabs` 防孤儿泄漏），在有头 Linux 与 Windows 平台（排除 `HeadlessChrome/`）为非当前标签页及后台遮挡或最小化 Agent 窗口上的 `screenshot` 与 `screenshot --full-page` 启用 Aura 合成器唤醒租约（及全页截图陈旧帧检测），并消除 `parsePngDimensions` 打包产物对脚本字符集的依赖（#731、#732）。
- 修复 Linux 后台 Agent 窗口中原生指针交互（`click`、`drag`、`download`、`upload`）抢占前台焦点的问题，理顺 CDP 焦点模拟、临时 `about:blank` 取消选中与后台租约可见性采样的时序以避免共享标签页误派发 `blur` 或漏检失焦租约，收敛临时标签页创建门控与归属以防清理失败时污染默认标签页路由，并在恢复任务弹窗焦点或路由外部链接时于 X11 短暂无焦点事件后重新确认实际焦点（#731、#732）。
- 修复 `bsk daemon revoke`、`bsk daemon rotate` 与 `bsk daemon pair --replace` 在遇到以连字符 `-` 开头的 base64url 本机 `device_id`（`Bytes<16>`）时被当作未知参数拒绝的问题，同时保留对非法连字符选项的解析期失败关闭校验（#732）。
- 对不支持协作动作条件（`context_id`、`depends_on`、`observation_id`、`expect`）的 CLI 与 MCP 顶层命令恢复 `invalid_params` 失败关闭拒绝，同时保留 `open`、`step`、`upload`、`download` 与 `screenshot --full-page` 等多阶段命令内部辅助 RPC 的元数据剥离；并在 `target` 策略下于 `CooperationController` 的 `prepare`（含 `primaryEffect` 悬停/聚焦步骤）与 `beginDomMutation`（标记 `nativeInputStarted` 之前）二次核验 `--expect` 业务条件，确保末刻 DOM 变更在提交按压或脚本变异前失败关闭（#731、#732）。
- VOM 树折叠规则（`shouldSkipRedundantRefChildren` 与 `renderTreeRows`）识别具名交互父节点下独立可交互的后代（如 Vue 3 + Element Plus 将二级浮层嵌在父 `menuitem` 内的多级 `<el-sub-menu>` 或自定义 ARIA `combobox` 弹出项），使每个已展开、可操作的子项在 `bsk sync`、`observe` 和 `snapshot` 中均输出独立行与专属 `@eN` 引用，同时保持被动内部包装节点、继承 `cursor: pointer` / 标题皮肤点击节点及原生 `<input>` / `<textarea>` / `<select>` 的折叠行为不变而不产生重复伪引用，并新增发版前必测用例 `EDGE-NESTED-MENU-REFS`。
- 结构化列表提取（`extract list`）支持通过 open Shadow DOM `<slot>` 投影分配的列表项及默认链接（`url`），保留插槽渲染顺序、闭合 `<details>` 隐藏行位置、嵌套子列表项与链接归属、可见性判断及采集限制（[#588](https://github.com/Tencent/BrowserSkill/issues/588)、[#612](https://github.com/Tencent/BrowserSkill/pull/612)），并新增发版前必测用例 `EDGE-SLOTTED-LIST-EXTRACT`。
- 修复结构化提取（`extract table`、`extract list` 与 `extract discover`）未对可见非敏感 `<input>` 和 `<textarea>` 值应用计算后的 CSS `text-transform`（`uppercase` 与 `lowercase`）及渲染语言环境大小写规则的问题，同时保留浏览器默认样式表的 `text-transform: none` 行为与字节预算统计（[#613](https://github.com/Tencent/BrowserSkill/pull/613) 后续完善）。

### 移除

- 移除上层模块对 `browser-driver/frame-graph`（`CdpTarget`、`CdpFrame`、`CdpFrameGraph`、`sendToTarget`、`sendGuarded`、`sendAttached` 与 `getFrameGraph`）的全部直接导入、为迁就手写 Mock 而在 `CdpRunner` 上保留的可选 `?` 方法、模块级全局 `downloadActive` 状态、`returnBorrowedTab` 中的 `isAgentWindowId: () => false` 隐式默认兜底、`@browser-skill/vom` 中硬编码的中文基准测试标题黑名单，以及 `cooperation/text-delta.ts` 中的正则二次解析与重复 `DERIVED_NAME_CAP` 常量。
- 移除已沦为只写不读死代码的 `apps/extension/src/lib/sessions-live-flag.ts`（`bh.sessions_live` / `SESSIONS_LIVE_FLAG_KEY`）以及 `apps/extension/src/content/record-capture.ts` 中在隔离世界无效的 `history.pushState` / `history.replaceState` 重写死代码。
- 从 `CdpRunner` 及上层调用栈净删 `reattachIfSoftDetached`、`reconcileSoftDetachedFrames` 与 `resolveTarget` 三大外泄补偿钩子，移除 `RefStore.remapChildFrameSessions`、手写残缺局部 `CdpRunner` 对象字面量（统一收口为 `delegateCdpRunner` 全量委托代理）以及 `background.ts` 以外所有孤立默认的 `new ChromiumCdp()` 野实例。
- 移除已废弃的 `TraceV2` 录制协议类型与转换器（仅保留 `TraceV3`）、全部 9 套 `1.x` `Feature::*` 历史版本协商门禁、扩展/守护进程 `"1.6"`/`LEGACY_MIN_COMPATIBLE_PEER` 兼容兜底、重复字段 `DragParams.observation_id` / 旧拖拽模式以及生成 TS 产物中重复导出的 `wire_*` 运行时校验器。
- 移除 `packages/dsh-plugin-browserskill` 中旧版自定义 `bsk_*` 工具包装器、重复会话启动日志、独立分叉的 DSH 专属 skill 文档以及 Web UI 缩略图轮询 React 浮层（连同 `@deepseek-ai/dsh-*` 宿主 `rc` 对等依赖锁与专属测试桩一并清理）；DeepSeek Harness 与其他 Agent 统一通过标准 `bsk` CLI 与 `bsk mcp` 调用，在途请求取消、协作结算、CLI 录屏导出与动态读取等真浏览器回归用例已完整迁移至 `bsk` CLI 与 `bsk mcp`（#731、#732）。

## [0.5.0] - 2026-11-12

### 新增

- 新增 daemon 本地 `<3ms` 预写意图账本（`$BSK_HOME/intent_ledger.jsonl`，`0600` 权限）与
  `bsk ledger status | resolve` 子命令：在派发层统一覆盖所有变异操作（`click`、`fill`、`press`、
  `select`、`upload`、`drag`、`evaluate`），无论使用 `--ref`、原始 CSS `--selector` 还是视觉坐标
  `(image_x, image_y)` 均提取脱敏目标摘要保护（绝不落盘 `fill` 明文输入或 `evaluate` 脚本内容）。
  当调用因超时、取消、断连或 `effect_state: "unknown"` 结束（含 daemon 重启恢复残留 `DISPATCHED`
  记录）时进入 `UNKNOWN` 冻结态，在 `<1ms` 内以 `uncertain_prior_effect` 拦截同标签页盲目变异重放，
  100% 放行只读与诊断命令，并在执行 `bsk sync` 时零摩擦自动对账解锁。
- 新增零仪式生命周期命令（`bsk open`、`bsk sync`、`bsk close`）与 daemon 内存级
  `ImplicitScopeRegistry`：提供确定性 `caller_scope` 并发隔离（`--session` >
  `--scope` / `BSK_SESSION` / `BSK_SCOPE` > `bsk mcp` 进程级连接作用域 > 宿主子代理环境变量 >
  防静默抢占 `"default"` 槽位）、单调短证据别名（`c1..cN`、`o1..oN`）、可选 `--session` /
  `target` 策略省略 `--context` 自动还原以及 `unchanged` 缓存 VOM 补齐，且保持扩展侧共驾安全校验不变。
- 动作可供性增强的 VOM 渲染与 `<select>` 标签选择：无名输入控件绑定紧邻前置静态文本为 `[field: "..."]` 并消除消费标签重复输出；中文父子文本回声去重收紧为精确全等匹配；非敏感原生 `<select>` 内联展示前 10 个选项（`[options: val="Label"* | ...]`），`select` 支持按唯一无歧义可见标签选择、以 `option_ambiguous` 拒绝同名歧义标签、在 `option_not_found` 中附带前 12 个合法候选，并对自定义 ARIA 下拉（`[custom-dropdown: ...]`）给出先点击展开的恢复引导；同一表内连续 3 行及以上的纯只读数据行无损折叠为单行管道格式。
- 基于计算样式的隐形提示注入剥离与零额外 RPC 虚拟滚动行主键守卫：静态采集与悬停探测自动剥离通过 `opacity < 0.05`、`font-size <= 1.5px`、前景背景零对比度、远屏外偏移或 `< 2px` 裁剪隐藏的非交互注入子树（完整保留交互元素、按钮内部 `.sr-only` 无障碍名称、`<label for>` 及 `aria-labelledby`/`aria-describedby` 引用目标）；位于表格行、列表项或虚拟行池内的 `@eN` 引用在发布时记录归一化业务行锚点 `rowAnchor`，并在 `checkActionTarget` 单次 `SAMPLE_TARGET` 采样中原子核验，在动作派发前阻断原地复用的虚拟列表 DOM 节点（`virtual_row_recycled`，`effect_state: none`）。
- 新增 Qoder 和 Qoder CN 的 skill 安装目标，可使用 `bsk install-skill --harness qoder` 和
  `--harness qoder-cn`。
- 本机配对支持双向身份验证、持久化密钥轮换和中断恢复。已配对连接在发送业务请求前验证 daemon，激活后原链接失效。撤销与浏览器注册串行执行，撤销成功后对应连接已清理。
- `bsk daemon pair --replace`、本机设备列表和撤销、`daemon rotate` 及 `daemon trust-local on|off`。状态和诊断命令提供配对指引。
- 扩展增加配对设置、分阶段验证、十种语言的指引和跳过验证确认。切换到本机模式时保留远程授权。新安装和升级均可使用未配对连接，扩展显示身份提示和官方安全说明。已配对连接和待恢复凭据都需要继续验证。
- `bsk daemon pair` 会复用或启动 daemon，再返回可用链接。用户可以显式开启 Required 模式。默认策略保护已配对的浏览器身份。

- 页面内控制面板可收起为右边缘的展开箭头；同一任务内的状态刷新和页面导航会保留收起状态。
- `bsk plan` 和 MCP 工具 `bsk_plan` 在一次调用中依次执行多个已决定的动作，并返回同步后的状态。
  填写表单或设置筛选条件只需一个模型回合，不必每个动作一回合。每一步都保留对应命令的全部检查，
  第一个未完成的步骤会终止计划，且不做任何重试。
- DSH 插件通过 `bsk_interact(action=plan)` 一次执行多个已决定的动作，检查、终止规则和回执与 `bsk plan` 相同。
- 设置 `recipes` 选项或 `BSK_RECIPES=1` 后，DSH 插件提供 `bsk_recipe`。运行使用插件自己的会话，
  未完成的运行会保留回执，且不提供批准动作。
- `bsk recipe` 把验证过的流程保存为本地文件并回放，直接返回输出，不必每步花一个模型回合；
  设置 `BSK_RECIPES=1` 后 MCP 会列出 `bsk_recipe`。按角色、名称和上下文精确定位，遇到第一个偏离就停下并把页面交回。
  此版本只回放只读和可逆步骤：降低风险的步骤要由人用 `bsk recipe approve` 批准后才会运行，
  结果不确定的运行会锁住该配方，直到调用方确认已核实。详见 `docs/recipes.md`。
- `bsk read`、MCP 和 DSH 的 `bsk_inspect(action=read)` 通过隔离世界中的固定同步查询读取有界 DOM 字段。Agent 可跨无关动画读取当前标题、URL、文本、属性和表单状态，再通过明确的业务条件执行操作。不接受调用方 JavaScript、回调或延迟副作用，并对敏感字段脱敏。
- DOM 读取使用协议 1.9 能力协商，旧组件明确报不支持，不回退到脚本执行。视觉和无目标输入仍保留严格观察保护。
- 新增 `bsk evaluate --unverified`（MCP 为 `params.unverified`，DSH 为 `unverified`）：执行脚本前不比对页面与任何观察，
  用于持续变化的页面上依赖无法声明的脚本。控制权、主文档身份和标签页归属仍然检查；不能与 `--expect`、`--observation`、
  `--depends-on` 同用，回执带 `verified: false`。daemon 和扩展都需要协议 1.9，低于 1.9 的组件在派发前明确报不支持。
  更早的 1.9 开发版无法通过协议号区分，需要同时更新 CLI、重启 daemon 并重新加载匹配的扩展。

### 变更

- 单步交互热路径提速并削减约 85% 冗余串行 IPC/CDP 往返：`target` 共驾策略下在动作入口完成单次
  `verifyDecision()` 预检后，对不会产生原生 `isTrusted` 输入的内部准备/脚本类 CDP 步骤采用同步零 RPC
  内存级栅栏（完整保留推送式真实人类介入毫秒级中断与 `strict` 策略兼容），消除 `beforeinput`
  双重跨帧广播轮询并优化未介入 Agent 窗口标签页的 `finishInput` 收尾开销；将 `handleFill`
  压缩为 3–4 步乐观极速通道，废除页面自动格式化导致的 `fill_value_mismatch` 硬报错并为非敏感控件回传
  `actual_value` 与 `formatted`；业务 CLI 命令升级为基于 `daemon.json` 的乐观单次 UDS 直连，仅在首次
  `connect()` 未连接阶段按需回退自动拉起 daemon，确保零重复派发风险。
- 将 CLI 内置 `SKILL.md` 重写为零预读闭环（`<= 2,000` UTF-8 字节）并完整保留四大安全红线，
  移除 `cooperate sync` 回执中每回合重复的静态 `guidance` 文本，同时为 `ChromiumCdp` 增加
  75 秒四重硬守卫空闲软卸载（保留会话归属、控制台/网络 `since` 游标、未变化页面的 `@vN` 与跨源
  OOPIF `@eN` 引用、待处理原生弹窗，以及下载/上传/导航等待/录屏流的连接租约，支持下一命令无感重连）及
  `bsk close` / `bsk tab return` 时的 0 秒立即卸载。
- 协作同步与严格动作前置校验按标签页复用 10 秒滑动 TTL 的 `Accessibility` 域租约，在仅比对场景的证据校验和增量刷新中跳过无用的 VOM 文本渲染，采用流式逐节点比对替代全页证据序列化，并降低大页面语义图与 VOM 渲染的内存分配开销。
- 扩展弹窗的连接设置不再折叠，始终展开。未配对的建议收起为标题旁的三角警示图标，点击后展开；
  已跳过验证和阻断连接的状态仍直接显示。当前地址显示在所选模式下方，配对步骤改为点击信息图标查看，
  “使用新的配对链接”改为按钮，保存后果的说明只在有可保存的有效修改时显示。
- `bsk plan` 和 `bsk recipe` 作为标准 CLI 工作流提供文档与内置 skill 指引；MCP 和 DSH 中的 recipe 工具仍按需启用。
- Recipe 的运行和修改共用互斥锁；安全状态不可读或运行标记不可写时拒绝回放，宿主进程仍存活时也保留中断运行的核实要求。DSH 完整收集取消后的 plan 和 recipe 回执。

- 扩展移除过时的迁移标志和版本限制，继续采用可选配对。
- `bsk-protocol` 统一承载方法元数据、JSON Schema、TypeScript 请求与回执编解码、daemon 与扩展的穷尽执行策略表，以及协议 1.2–1.9 对端能力兼容检查（`pnpm protocol:check`）。

### 修复

- 停止录制时协调录制会话清理。清理需要重试时，保留已捕获的步骤（[#720](https://github.com/Tencent/BrowserSkill/pull/720)）。
- DSH 的 skill 和插件文档说明如何在 PTC 模式下通过 `run_code` 调用 BrowserSkill 工具（[#721](https://github.com/Tencent/BrowserSkill/pull/721)）。
- 空闲时卸载调试器会等待对话框关闭和活跃下载结束，重新连接后仍保留元素引用（[#711](https://github.com/Tencent/BrowserSkill/pull/711)）。
- `target` 策略下的 `cooperate sync` 在上次观察之后页面只发生可见文本原位替换时，不再重传整页 VOM。内容脚本把纯文本的 mutation 批次与结构性批次分开计数并记录；扩展返回 `kind: "delta"`，附带 `observation_patch.lines`、`changes` 中的 `kind: "text"` 条目（旧值、新值、涉及的 VOM 行号）以及 `previous_observation_id`。`--baseline` 指向精确前驱时，CLI 应用该补丁，通过 `--save-full` 保存合并后的观察，并且不在 stdout 输出整页文本；`view` 以零浏览器调用读取合并后的版本。在 6,857 个节点的 `ARENA-MEGA-VOM-DELTA` 夹具上，第三次同步由约 2.2 秒、574 KB 降到约 0.2 秒、2 KB，合并文本与新鲜抓取完全一致。结构变化、文档或 ref 被替换、人工操作、字段变化、存在焦点相关样式时的焦点移动、记录缺口、文本不在已持有观察内或有歧义、子帧以及 token 预算偏移仍返回新鲜的 `baseline`，并新增 `baseline_reason` 说明原因。`strict` 策略的行为以及目标和观察守卫保持不变（[#722](https://github.com/Tencent/BrowserSkill/pull/722)）。
- 加固 VOM 隐形提示注入剥离器对 CSS Color 4/5、渐变裁切文字、HiDPI 微盒、内部滚动容器及混合文本容器的判定精度：将 `oklch`/`oklab`/`lab`/`lch`/`hsl`/`hwb`/`color()`/`color-mix()` 统一解析为 sRGB 以覆盖跨色域零对比度与零透明度检测（含 Tailwind v4 `oklch()` 背景栅栏及 `currentColor 0%` 混合色）；在保留真实 `background-clip: text` / `-webkit-background-clip: text` 渐变标题的同时剥离全透明、零跨度色标及与背景同色的伪渐变注入；按 HiDPI/Retina 缩放比例归一化 `1px` 微盒与屏外偏移阈值；结合 `DOMSnapshot` 内部滚动偏移（`scrollRects`）与 `#text` 字形边界保留真实已滚动行列并拦截未滚动容器内的 `left: -99999px` / `-2000px` / `text-indent: -9999px` 离屏注入；同时清理保留容器上的直属隐形文本与受污染的无障碍 `name`（[#709](https://github.com/Tencent/BrowserSkill/pull/709)）。
- `wait-for-navigation` 不再在待等待的导航尚未开始或仍在进行时直接按旧页面返回。已加载完成的页面需在短暂宽限期内没有主框架导航开始才视为已到达；一旦导航开始或 Chrome 报告有待提交的导航，只有新文档能满足等待。同文档导航和往返缓存恢复仍会立即完成（[#700](https://github.com/Tencent/BrowserSkill/issues/700)）。
- VOM 快照解码与语义图 DOM 文本回退解析排除 `<style>`、`<script>`、`<noscript>` 与 `<template>`
  子树（以及 HTML 注释节点），避免缺少无障碍名称的控件将 CSS、脚本或模板内容泄漏为标签文本
  （[#694](https://github.com/Tencent/BrowserSkill/issues/694)）。
- 原生点击、按键和滚轮输入会校准 Chromium 的输入时钟，避免长时间运行的浏览器在休眠或校时后
  将自身输入误判成人工介入。校准在扩展的隐藏文档中进行，保留现有输入检查，并在派发前报告时钟故障
  （[#665](https://github.com/Tencent/BrowserSkill/issues/665)）。
- `tool.record_start` 执行共享标签页归属、任务终止与人工持有检查，并在启动录制时使旧控制凭证失效；`tool.tab_return` 对本地会话和远程会话同样清理进行中的录制。
- `navigate back` 和 `navigate forward` 在 Chrome 从往返缓存恢复历史记录时不再等待超时。恢复的文档已经加载完成，不会再发出新的加载生命周期事件，因此恢复提交即视为达到 `domcontentloaded` 和 `load`，并在恢复的文档上重新启用生命周期事件重放，使此前已空闲页面的 `networkidle` 等待也能正常完成（[#701](https://github.com/Tencent/BrowserSkill/issues/701)）。
- daemon 关闭时保留 WebSocket 停止通知，避免接收循环尚未等待时丢失通知，导致 `daemon stop` 等待不结束。
- 网站调试将 Agent 发起的上传和下载归入对应传输操作，不再把产生的文件变更和点击误记为人工输入。
- 预写意图账本不再在动作确定未生效时冻结标签页。仅滚动后即被拒绝的点击（`effect_state: "unknown"` 且 `press_sent: false`）以及报告 `dispatched: false` 的失败现在都判为已结算。`select` 在滚动或聚焦元素之前校验所选选项，`fill` 在清空之前校验输入值；在这些位置发现的拒绝（`option_not_found`、`option_ambiguous`、`<select>` 被禁用、`fill_value_invalid`、`target_not_fillable`）报告 `effect_state: "none"` 与 `phase: "precondition"`，修正参数后重试既不需要 `bsk ledger resolve`，也不会丢失共享控制凭证。若同类原因在 `select` 移动焦点之后或 `fill` 清空字段之后才报告，仍保持效果未知。本已禁用的 `<select>` 现在报告 `invalid_params`，而不是聚焦失败的 `cdp_failed`（[#702](https://github.com/Tencent/BrowserSkill/issues/702)）。
- upload、download、plan 和 step 的本地校验失败返回稳定的参数或文件错误码，并提供对应修复提示。上传源文件在连接 daemon 或暂存任何文件前完成检查。
- `bsk get-html --json --out <file>` 不再把 HTML 输出到标准输出。指定 `--out` 时，JSON 结果只报告 `tab_id`、`path`、`written_bytes`、`byte_size`、`truncated` 以及可能出现的对话框，避免大页面进入调用方上下文；未指定 `--out` 时 JSON 结果仍包含 `html`（[#715](https://github.com/Tencent/BrowserSkill/issues/715)）。
- 在没有焦点的页面（后台标签页，或其他窗口获得焦点时的 Agent 窗口）中，`fill` 会在校验和清空字段之前先送达焦点，设置默认值的焦点监听器不再把默认值留在输入内容前面，也不会在标签页激活时恢复默认值。可见页面通过移到视口之外、不会落到任何元素上的指针移动获得焦点；隐藏页面或指针悬停中的页面仍使用原来的空按键，页面可以观察到一次空键。密码、银行卡和一次性验证码字段被截断或改写时报告 `formatted: true`（人类可读的 CLI 输出同样显示），但不返回 `actual_value`；名称类似密码的文本输入框（例如“显示密码”切换后的字段）也按敏感字段处理（[#713](https://github.com/Tencent/BrowserSkill/issues/713)）。
- `fill` 对每个最终值只通知一次。原生插入或清空步骤已经派发 `input`，完成阶段不再重复派发
  （[#624](https://github.com/Tencent/BrowserSkill/issues/624)）。
- 借用仍显示 `about:blank` 或浏览器空白新标签页（`chrome://newtab/`、`edge://newtab/`、`about:newtab`，含带查询串或 `#hash` 的变体）的用户标签页后，不再导致会话内标签页管理与初始导航死锁。没有采集脚本的初始空白或新标签页根文档在标签页管理准备阶段会被跳过并允许执行首次引导导航；若借用的标签页停留在浏览器受限页面或根文档加载失败页，`tab return` 也可在不销毁会话的情况下将其归还。已注入采集器的 `about:blank` 弹窗、其他无法观察的普通网页及子框架仍须先同步或按原规则拒绝（[#703](https://github.com/Tencent/BrowserSkill/issues/703)）。
- 窗口失焦时释放已完成的文本编辑保持；任务静置间隙后的新同步在无进行中手势或近期输入时自动恢复暂停或编辑状态，避免跨任务指令时重复提示手动交回控制权。
- `bsk sync` 与 `bsk open` 按完整页面判断 `--wait-for` 和 `--wait-not`。strict 策略下的 `delta` 帧，以及没有缓存页面的 `unchanged` 帧，会通过 `tool.snapshot` 读取一次完整页面，不再只匹配 `[change ...]` 行或空文本；被 `--max-tokens` 截断的页面会先完整读取，`--wait-not` 才认定文本已消失。经过多轮轮询才返回的等待，也会报告未返回的帧中的字段改动、活动记录和 `history_complete=false`。读取页面失败时继续轮询，不再直接结束等待（[#714](https://github.com/Tencent/BrowserSkill/issues/714)）。
- 录制保留名称超过 48 个字符的按钮和链接的点击，例如 GOV.UK 分步指南的展开按钮和较长的新闻标题。
- 录制保留与搜索框同在一个表单中的链接、筛选折叠项、复选框等控件的点击，例如 GOV.UK 的搜索结果和筛选条件。
- 页面滚动或目标尺寸变化后，录制的步骤仍能关联到元素 ref：位置对不上时，使用唯一一个同标签、同角色、同名的 ref。点击 `<summary>`、标签页或选项内部的文字时，按该控件本身取位置。
- Recipe 保存时检查输入及格式化后的文件大小，避免生成自身无法读取的修订版本。
- `press` 为美式键盘标点补上物理 `code` 与虚拟键码，`Ctrl+/` 这类快捷键能够触发依据 `event.code` 判断的处理器。
- 主文档 SPA 路由变化（包括切走后恢复原 URL 和 hash 路由）撤销旧控制上下文和 ref；补充读取不会更新这些凭证。
  已加载标签页的被动读取和新建 debugger 连接同样受到保护。
- 携带控制上下文的读取保留框架收集失败的具体原因，并以 `effect_state: none` 报告派发前错误；主文档或子框架暂时缺少根元素时返回 `read_target_stale`，不再归为通用 CDP 故障。
- CLI、MCP、DSH 及内置 skill 引导动态页面的数据读取使用 read/extract，避免反复 sync/evaluate 拒绝。
- 脚本声明了自己的依赖时，只校验这些依赖，不再比对整页，无关的时钟、信息流和媒体变化不会再让脚本陷入反复拒绝。
  目标策略下，带 `--expect` 且不带 `--observation` 的 `evaluate` 可复用控制凭证，子 frame 导航也不再拦截它；
  同时传入 `--observation` 时仍比对整页。
  严格策略下，带 `--depends-on` 的 `evaluate` 只校验这些区域、表单值和模态层；此前还会额外要求整页一致。
  未声明依赖的脚本校验方式不变。
- 因观察内容变化而拒绝时，回执增加 `observed_changes`：变化、新增、移除的节点数和最多五个示例。
  针对脚本，恢复提示和内置 skill 给出了尝试顺序：先声明依赖，无法声明时才使用 `--unverified`。
- 控制状态采样在浏览器证实失败的子文档已退出后有界重新收集一次；仍存在但不可观测的框架继续阻止输入。
- 框架未在时限内响应收集时，错误消息和 `data.frames` 会标明该框架（frame ID 及去除敏感部分的 origin 与路径；标签页操作另附所在标签页）。拒绝原因仍为 `cooperation_sync_required`，`--settle`、recipe 和 DSH 照常重试；恢复建议说明框架持续无响应时如何退出（[#614](https://github.com/Tencent/BrowserSkill/issues/614)）。
- 无法收集的子框架若其元素未显示、没有面积或不可见，且未持有焦点，会以 `hidden_frame` 列入 `frame_gaps`，不再阻塞整个标签页，例如微前端的沙箱 iframe。之后的收集重新检查该元素，不再重复等待该框架；仍显示的框架继续阻止输入（[#614](https://github.com/Tencent/BrowserSkill/issues/614)）。
- 已被 CDP 回收的移除节点与仍可检查的脱离节点统一返回 target_detached，并保留节点身份；其他 CDP 故障仍返回 target_unavailable。
- 录制捕获 open shadow root 内原生 `<select>` 的选项变化；这类控件的 `change` 事件不会到达 document。
- strict DOM 定向动作仅容忍自身悬停后增减的非交互提示气泡，以及自身聚焦后增减、通过 `maxlength` 或 `aria-describedby` 与聚焦文本框关联的字数计数器。目标含义、链接、普通文字、表单状态、模态正文和显式依赖继续精确比较；脚本、无目标按键和视觉点击在准备阶段也保留完整观测检查（[#540](https://github.com/Tencent/BrowserSkill/issues/540)）。
- 未声明 `--depends-on` 的定向 strict 动作，与声明了依赖时一样，容忍页面其他位置经正向识别的媒体时间轴。无名、会提交或位于表单内的滑块，以及无目标动作，仍保持精确比较。
- 证据拒绝返回 `observed_change`（第一处差异的节点、字段、所属检查，以及发生在决策阶段还是准备阶段），不包含输入值和敏感文本。准备步骤之后被拒绝的 strict 点击同时返回 `press_sent: false`。
- 因同一会话上一条命令仍在结算（例如被取消的观测截图）而被拒绝的请求，现在带有 `reason: operation_settling`、`retryable` 和 `retry_after_ms`。`cooperate sync --settle` 会暂停后重新同步（最多 5 秒，旧版扩展同样适用），CLI 不再建议同样需要该次同步的 reload（[#527](https://github.com/Tencent/BrowserSkill/issues/527)）。
- `upload` 在事务清理主动断开 debugger 或操作后框架收集失败时保留具体的处理器失败回执（如未开启扩展“允许访问文件网址”权限时的 `set_file_input_failed` 与 `file_drop_failed` `-32000 Not allowed`），不再将其掩盖为 `control_context_invalid`；`dragEnter` 立即拒绝时保持 `effect_state: none`，且不再冗余发送 `dragCancel`（[#636](https://github.com/Tencent/BrowserSkill/issues/636)）。
- 录制保留提交、重置和图片输入按钮的点击，包括搜索框旁的按钮操作，并使用重置按钮的可见值作为名称。

- 协作状态刷新保留正在使用的点击穿透，避免控制面板或收起后的箭头吞掉自动化页面点击。
- 录制保留编辑器内 `contenteditable="false"` 区域（如附件操作）中按钮和链接的点击，不再将其当作编辑器输入而丢弃。

- `extract` 对表格单元格、表头、列表字段和发现预览中的文本应用 CSS `uppercase` 与 `lowercase`，保留子元素样式覆盖和语言相关的大小写映射；转换后的文本仍受字节预算约束（[#597](https://github.com/Tencent/BrowserSkill/issues/597)）。
- 关闭保留的 Agent 窗口或停止最后一个会话时，释放剩余的 CDP 调试连接并取消会话在途操作，避免任务窗口关闭后浏览器顶部仍残留调试横幅。

## [0.4.2] - 2026-11-05

### 新增

- 浏览器浮层显示会话控制者的 Agent 名称、项目、会话 ID 和颜色；CLI 和 DSH 启动会话时支持传入这些显示信息。
- 填写支持 date、time、datetime-local、month 和 week 输入框，校验格式与 min/max 范围，并保留后台输入状态。
- `bsk mcp` 让 MCP 客户端通过标准输入和输出，借助现有守护进程与浏览器扩展控制 BrowserSkill。`bsk install-skill --mcp` 可为 Codex、Claude Code 和 Cursor 配置 MCP 服务。

### 变更

- 借用标签根据原相邻标签恢复归还位置，改善固定标签和分组恢复；关闭借用确认后，符合条件的请求支持自动借用。
- 扩展恢复使用 `tabGroups` 权限，以读取和还原借用标签的原分组。
- 共享控制在用户最后一次已完成操作后连续安静 2 秒再交回 Agent，原阈值为 650 毫秒。
- CLI 和 daemon 更新优先使用官网国内下载源；清单或安装包下载、验证失败时回退 GitHub。安装包回退固定为已选版本并保留 SHA256 校验，两个源都失败时逐项报告 URL 和失败原因。显式指定的自定义清单仍只使用配置的源。

### 修复

- 元素等待在匹配节点被替换后重新查询选择器，避免替代节点仍可见却误报隐藏或移除成功。
- 仅在请求时开启控制台采集，避免部分反调试页面反复刷新，并保留采集诊断。
- 调试证据对精确匹配的厂商凭据请求头脱敏。
- DSH 填写和选择以 `-` 开头的值时，将其作为选项值传递，避免被解析为 CLI 参数。
- 共享控制工具栏在自动点击期间让出指针命中，包括被其右下角遮住的页面操作；点击结束或穿透租约到期后，工具栏控件恢复交互。
- Enter 的 keydown 与文本事件一并派发，保留已完成的链接或表单导航回执，避免向新页面再发送独立字符事件；导航后的下一操作仍须获取新的控制上下文。
- 页面操作超时后取消执行并等待有界清理，错误回包保留执行阶段、效果状态和操作标识；缺失回执时明确表示效果未知。CLI 和 MCP 的超时提示要求先检查应用结果再决定下一操作，避免盲目重试。
- 同名操作优先使用自身 DOM 容器内的文本作为上下文，也支持按钮之后的标签，避免相邻记录被错误地关联到目标。
- CLI 取消时继续推进原 RPC，并重试先于 daemon 注册到达的取消请求，减少调用方停止后后台截图仍占用会话的情况。取消确认和响应等待共用两秒预算，MCP 取消也使用同一预算；文件传输清理保留独立的有限预算。超过该期限才注册的请求仍需 daemon 侧取消追踪解决（[#419](https://github.com/Tencent/BrowserSkill/pull/419)）。
- 保存的 HTML 调试捕获在 `autocomplete` 含首尾空白或多个令牌时（如 `section-login one-time-code` 或 `section-checkout billing cc-number`）也会对敏感输入值脱敏；`section-login email` 等非敏感令牌列表保持不变（[#566](https://github.com/Tencent/BrowserSkill/pull/566)）。
- 处理旧版 `mousewheel` 事件的页面（如哔哩哔哩播放器的音量调节）重新能收到滚轮输入。此前扩展即使没有共享控制会话也会在每个页面监听 `wheel`，导致 Chromium 跳过这些处理函数；现在只在采集期间于 `window` 上监听。
- 截断的页面文本把 emoji 切成两半时（例如对 `Hi 🚀 there` 执行 `bsk console --max-text-chars 4`），命令不再一直等到超时。此前截断留下的孤立代理项会让 daemon 丢弃扩展的整条回复；现在扩展会把它替换为 `U+FFFD` 再发送。
- 共享控制在滚动和无效按键期间继续执行，真实网页点击、键盘激活和有效字段编辑时向人工让路。待确认手势在输入发送前等待，取消后保留原控制上下文；依赖坐标的操作等待滚动稳定。仅聚焦文本框不再持续保持编辑控制。

- 目标策略下，轮播、嵌入视频或广告刷新 iframe 时，主文档内的目标和业务条件可继续使用现有控制凭证。涉及 iframe 引用或严格观察的操作会在框架文档变化后要求重新同步。
- 以 `autocomplete`（`one-time-code`、`cc-*`、`current-password`、`new-password`）标记的一次性验证码、银行卡和密码字段，其值此前已在观察结果中隐藏，现在也不会出现在共享控制字段状态、`expect` 失败详情、结构化提取和录制的填写步骤中。所有检查均逐个匹配 `autocomplete` 令牌，因此 `section-login current-password` 或 `billing cc-number` 的值同样会被隐藏。被“显示密码”切换为 `type=text` 的密码框，在共享控制字段状态以及录制步骤和状态观察中也保持隐藏。
- 在 Windows 上，配对、轮换或撤销远程浏览器时，若另一请求正在读取授权存储，不再因 `replace authorization snapshot: Access is denied` 而失败。
- 调整窗口大小时验证实际窗口边界和目标标签页的布局视口，并报告受限边界、非活动标签页及未随窗口变化的视口。已发送的调整操作还会使下一次共享控制同步重新采集页面。
- 共享控制同步跳过失败的子框架和非活动文档，在 `frame_gaps` 中仅报告 HTTP(S) 的来源和路径或其他 URL 的协议，并立即为当前文档修复一次缺失的交互采集器。缺少覆盖的活动框架仍以 `frame_unobservable` 阻止操作，主页面失败则报告 `page_load_failed`。
- `cooperate sync --settle` 在等待报告覆盖不可用时继续有限重试；全部失败时返回最后一次同步错误。临时人工控制仍返回 `not_ready`，包括导航期间的显式保持。首次成功协商策略前状态和等待操作报告 `control_policy: null`。
- 共享控制的 `observation_required` 恢复提示、目标策略同步指南及技能文档明确要求使用同步响应顶层的 `observation_id`，而非用于引用映射的 `observation.observation_id`。

## [0.4.1] - 2026-11-02

### 变更

- **共享控制默认策略：**新的 CLI 和 DSH 同步调用默认使用 `target`。DOM 操作可在已完成操作及补充读取之间复用控制上下文，无关页面更新不再要求全页重新同步；人工干预或导航会撤销控制。使用 `--expect` / DSH `expect` 保护已观察到的业务事实。脚本、无目标按键和视觉操作仍需同步返回的 `--observation` / `observationId` 及严格观察检查。首次同步时可选择 `--policy strict` / `policy: "strict"` 保留每次操作使用一个上下文的流程；后续同步和步骤保留会话策略。
- CLI/守护进程与扩展使用协议 1.8。目标策略要求双方均支持 1.8；应同时更新 CLI、运行中的守护进程、扩展和 DSH 插件。
- 补充观察期间 DOM 引用保持指向原节点；已移除节点不会被静默替换，导航会使文档引用失效。DOM 操作可在超时范围内等待已有目标就绪，不会重放输入。

### 修复

- `crypto.randomUUID()` 不可用时，普通 HTTP 内网页面及子框架使用兼容的 UUID 回退方案初始化交互采集。
- 共享控制同步等待已取消的观察缩略图完成清理。视口捕获读取有 10 秒期限及独立的有限清理时间；超时返回 `timeout`（退出码 4）和截图指引，浏览器/CDP 捕获失败仍返回 `cdp_failed`（退出码 3）。
- 已完成的输入即使触发导航也保留成功回执，包括点击、回车提交、拖拽提交以及填写或选择后的表单提交。导航后应先同步再执行下一操作。
- CLI 在发送浏览器命令前启用取消处理，立即按 Ctrl-C 也能取消操作并返回结果。
- 指针命中测试限定在目标文档内；框架变化期间的人工输入仍会撤销控制，同时保留已完成操作。
- Windows 守护进程启动错误区分已确认的 Job Object 限制、未确认的脱离失败、可执行文件访问失败、部分脱离及恢复失败，并提供对应恢复指引。
- DSH 注入消息在原生持久格式 v4 中使用插件来源，同时兼容旧格式的来源结构。

### 移除

- 移除自动创建的原生 Agent Window 标签组及 `tabGroups` 权限，避免 Chrome 同步导致浏览器中不断累积 `BrowserSkill` 组。已有保存组不会删除；页面控制指示、后台窗口行为和用户标签路由仍可用。

### 升级

1. 完成当前任务，安装 CLI 0.4.1 并重启运行中的守护进程。
2. 升级 DSH 插件到 0.4.1 前先安装扩展 0.4.1。商店审核可能导致延迟，应确认实际安装的扩展版本。
3. 重启 DSH 配置并再次调用 `/browser-skill`，或开始新的 CLI agent 会话以加载更新后的技能。自定义工具集成需要支持目标策略操作的新观察和期望字段。
4. 检查 `bsk --version`、`bsk status` 和 `bsk doctor`；运行中的守护进程和扩展均应报告协议 1.8。

## [0.4.0] - 2026-10-30

### 变更

- **破坏性变更——扩展兼容性：**扩展要求守护进程协议 1.6 或更高，使用协议 1.3 的 CLI/守护进程 0.3.3 无法连接。先更新 CLI 并重启守护进程，再更新扩展和 DSH 插件。0.4.0 使用协议 1.7。
- **破坏性变更——浏览器共享控制：**新会话及其任务标签页自动启用人机协作。初始导航后使用 `bsk cooperate sync` 同步，并为每个操作传入一次性 `--context`；DSH 使用 `bsk_session action:sync` 和 `contextId`。人工输入或页面证据变化可能撤销待执行操作，此时应重新同步并判断结果。已有会话需重新加载技能。
- 将受控标签移出原 Agent Window 会结束整个会话，保留页面并移除控制指示；移回不会重启任务。正常停止会保留有人参与的页面，清理未触及的任务创建页面。
- macOS CLI 发布包的两种架构均要求 Developer ID 签名和 Apple 公证，Windows 仍要求 EV 签名。`Publish CLI` 在发布完整版本前验证两个平台；压缩包名称和安装命令不变。
- 中英文隐私政策涵盖共享控制观察、显式保存的观察文件、无痕任务和 `tabGroups`。升级和发布说明采用 CLI 优先的更新顺序。

### 新增

- 人机协作支持可见控制指示、手动保持与恢复、有限的活动证据、页面变化保护及显式决策区域。原生 JavaScript 对话框也参与控制和恢复。
- 原生拖拽交互支持跨源框架目标，并新增点击—移动—点击范围选择模式，CLI 和 DSH 均可使用。
- `bsk step` 执行指定操作、可选等待元素后同步；后续阶段失败时保留操作回执。显式保存观察、复用基线及 `bsk view` 可在本地读取和搜索历史证据。DSH 通过 `step`、`view`、`saveFull` 和基线选项提供这些能力。
- 通过 `session start --incognito` 创建无痕 Agent Window，需明确授予浏览器无痕权限，且不会借用普通标签页。同一配置下的无痕窗口共享无痕登录状态。
- 使用新增的 `tabGroups` 权限以橙色标签组标记受控 Agent Window 标签；任务结束时移除分组。

### 修复

- 浏览器交互为动态菜单保留当前元素引用，正确分发 Shadow DOM 输入事件，处理加号组合键，并拒绝聚焦时变为禁用状态的选择控件。提取遵循 `content-visibility`，观察 token 估算及证据范围更加一致。
- 网站调试保留失败请求体元数据和原始值控制台异常。视频捕获尊重人工控制，播放回归检查等待解码帧后再检查颜色。
- Windows DSH 子进程取消保留终止宽限期；远程授权处理存储繁忙，WebSocket 连接限制约束传入连接。前台守护进程控制台保持可见。
- 浏览器评测框架处理 Windows 跨盘路径、相对导入 URL 和长运行 ID；子进程输出保留 UTF-8。安装依赖时准备扩展类型。
- 扩展弹窗解释运行中的 bsk 守护进程版本过旧导致无法连接，展示版本、可复制的更新命令和重启指引。工具栏警告和通知提前提示，重复重连不会重复通知。
- CLI 参数解析失败遵循 `--json`，在标准输出返回带 `data.reason: "cli_parse_error"` 的 `invalid_params` 错误。错误位置的 `--session` / `--tab-id` 会提示将其放在支持的子命令之后（[#387](https://github.com/Tencent/BrowserSkill/issues/387)）。
- DSH 插件在移除 `sessions.list` 快照中 `current` 的 DSH 0.2.0+ 上恢复自动打开右侧观察标签，回退到 `uiSession` 主绑定，并在切换会话时重新触发（[#484](https://github.com/Tencent/BrowserSkill/issues/484)）。
- 扩展在时钟、计数器等文本自行更新的页面上不再永久拒绝共享控制操作。首次变化报告前后文本并要求同步；之后仅当变化文本与目标共享容器时阻止引用或选择器操作。无目标操作、表单值、模态层和 `--depends-on` 区域仍严格检查，被拒绝的上下文不能重试（[#495](https://github.com/Tencent/BrowserSkill/issues/495)）。

## [0.3.3] - 2026-10-14

### 变更

- **破坏性变更——DSH 插件：**将 `browser_session`、`browser_page`、`browser_inspect`、`browser_interact`、`browser_tabs` 和 `browser_assist` 替换为对应的 `bsk_*` 名称；操作、参数、结果和技能名称不变，旧名称不再注册。升级插件前先将 CLI 和扩展升级至 0.3.3，更新硬编码调用和工具策略，重启宿主并重新加载技能。参见[迁移指南](packages/dsh-plugin-browserskill/README.md#breaking-tool-api-migration-033)。
- CLI 发布前要求验证 Windows EV 签名。构建、内部签名和最终发布分阶段进行，Windows 压缩包包含已验证的签名可执行文件，`version.json` 保存最终包的哈希。
- 后台 Agent Window 中的外部链接和手动创建的标签路由到普通用户窗口，同时保留任务弹窗、人工协助和录制流程。待处理外部标签不作为默认工具目标。
- 中英文隐私政策描述任务视频捕获、`offscreen` 权限、浏览器本地保留、授权导出及删除；主 README 说明视频录制和 DSH 迁移。

### 新增

- [任务视频录制](docs/video-recording.md)：通过 CLI、DSH 或扩展选择性地对一个授权标签录制无声 H.264 MP4，支持预览、导出、删除和恢复部分录制；限制为 10 分钟、256 MiB 和保留 24 小时。
- [结构化提取](docs/structured-extraction.md)：将已加载的表格和列表导出为 JSON/CSV，保留列顺序、页面/框架来源、合并单元格元数据和完整性信息。DSH 限制返回模型上下文的行数。
- CLI、扩展及 DSH `bsk_page` 的[元素条件等待](docs/wait-for-element.md)，提供明确期限和恢复指引。
- CLI 浏览器选择器找不到匹配实例时列出已连接浏览器。

### 修复

- DSH 插件回滚不完整的工具注册，报告激活失败，并在技能/会话生命周期边界重试；首个 `/browser-skill` 请求包含工具 schema，失败和恢复通知与模型技能结果同步（[#444](https://github.com/Tencent/BrowserSkill/issues/444)）。
- Chrome 未断开连接却丢失焦点覆盖时，后台 Agent Window 标签的输入不再持续报 `input_not_ready`；后台执行租约重新发送覆盖并等待渲染帧，仅在页面可见时发送输入（[#355](https://github.com/Tencent/BrowserSkill/issues/355)）。
- agent 空闲时控制光效仅绘制一次并脉冲透明度两次，遵循减少动态效果设置；读取无障碍树后关闭 Accessibility 域，降低 GPU 和 CPU 使用（[#391](https://github.com/Tencent/BrowserSkill/issues/391)）。
- 通过编辑宿主填写可编辑控件和编辑器段落，保留段落范围，拒绝不可编辑目标，并统一读取行模型。
- 下载检测浏览器忽略指定目录的情况，并在导入文件前验证最终路径。
- 元素等待遵循状态和期限约定，将不存在元素视为隐藏，并在节点过期后重试选择器。
- 结构化提取保留 DOM 值和有限的部分结果，保持拆分网格行完整，并遵循嵌套行归属和框架可见性。
- CLI 导航生命周期等待超时时退出码为 4；DSH 在带 URL 启动导航超时时保留已创建会话。
- 视频录制保持启动可取消、限制捕获等待、从导航和短暂覆盖层发现失败中恢复、防止控制层闪烁，并为较大帧选择合适的 H.264 级别。
- 避免 Yandex 中不必要的调试器取消和不完整标签清理，保留任务弹窗来源并恢复短暂焦点变化。

## [0.3.2] - 2026-09-30

### 变更

- DSH 插件支持 DSH `0.2` 宿主，同时兼容 `0.1.5-rc.3` SDK。
- 扩展简化浏览器配置控制，并在无法复制时解释配置说明不可用的原因。
- 使用 `--foreground` 启动的守护进程不再安装更新或自行替换为后台进程。`bsk update` 保留其运行（JSON 中为 `"daemon": "left_to_host"`）；更新后应在所属终端或管理器中重启。
- 无法写入可执行文件所在目录的守护进程只报告新版本。更新尝试、阶段和错误记录于 `update-state.json` 并由 `bsk doctor` 展示；Windows `bsk update --json` 返回 `"status": "updated"`。
- 安装和技能指南说明 `BSK_AUTO_UPDATE=off`、在 WorkBuddy 和 CodeBuddy 中启动守护进程，以及并行任务的共享登录检查。
- 中英文隐私政策明确通过 `downloads` 导出截图、人工协助通知及导出文件的保留方式。

### 修复

- CLI/守护进程的跨平台更新可恢复（[#336](https://github.com/Tencent/BrowserSkill/issues/336)）：自动更新验证新程序并等待其服务相同端口后旧进程才退出；接管失败或超过 20 秒时恢复旧版本和服务，6 小时后重试。Windows 无需后台更新脚本即可替换运行中的程序。
- `bsk update` 在停止后台守护进程前验证替换文件，重启失败时恢复旧版本，并保留实际服务端口（包括 `--port 0`）。宿主无法重启时保留运行中的进程（`"daemon": "left_running"`）。
- 跨 bsk home 串行更新同一可执行文件；Linux 回滚后保留可执行文件路径；自动更新期间守护进程停止时安全恢复。
- 扩展连接关闭或替换时立即结束待处理调用，对输入、传输和标签借用保留结果未知错误。`bsk doctor` 和 `bsk browsers` 报告停止发送心跳的扩展及已关闭连接。
- 协议保留显式 `null` 结果，拒绝冲突的 result/error 字段和空 error 字段。
- 下载捕获通过 `target="_blank"` 打开的附件并归属于点击的标签；关联下载与点击派发，触发失败时保留已发生的效果，防止取消或过期触发器延迟输入或留下覆盖层。
- DOM 多击操作发送每次按下，遵循持久后台执行租约，并将模拟覆盖限定在所属会话和调试器连接中。
- 导航至无法承载覆盖层的 blob 或受限页面后完成录制，仅清除所属会话的过期 CLI 录制状态。
- 限制人工协助 URL 正则表达式工作量并防止完成轮询重叠。
- 扩展覆盖层忽略旧代次及旧 worker 实例的过期状态。
- 网站调试在保留证据前遮盖 HTML 编码的敏感输入属性。
- DSH 插件重连失败的观察流，在观察视图和折叠胶囊中展示中断，并允许祖先会话归档后创建新浏览器会话。
- `bsk doctor` 将已安装技能与 CLI 内置版本比较；技能入口在 CRLF 检出时也符合大小限制。

## [0.3.1] - 2026-09-23

### 新增

- [任务范围的网站调试](docs/website-debugging.md)：有限的请求/响应体捕获、关联操作的控制台和页面上下文、本地历史及 JSON 导出、CLI 和 DSH 入口及扩展证据工作区；保留原弹窗控制并新增当前任务卡片。
- 调试操作卡片包含手动输入、字段变化链、延迟证据、按来源过滤噪声及明确的捕获缺口。
- 网站调试支持任务范围的 HTTP 规则、请求重放、原生性能指标、请求聚合和重复请求分析。
- 远程网关任务预览，以及将 agent 打开的弹窗和标签归属于对应任务。
- 扩展弹窗支持浏览器实例命名，CLI、DSH 和技能指南支持显式[选择浏览器配置](docs/browser-profiles.md)。
- 新增繁体中文、日语、法语、意大利语、西班牙语、德语和巴西葡萄牙语界面。
- CLI 和 DSH 技能参考包支持资源路径验证、安全升级及现有受管理安装的迁移。

### 变更

- 扩展隐私政策描述网站调试数据、本地历史保留与删除、按请求分享及脱敏限制。
- DSH 插件依赖对齐 SDK `0.1.5-rc.3`、Cordis `4.0.2` 和 Schemastery `3.18.2`。
- 对重复操作标签复用相邻上下文，减少重复观察工作。
- 技能指南明确安装前提、浏览器就绪状态、配置选择及将页面内容视为不可信数据的方式。

### 修复

- 浏览器会话启动和停止可恢复，包括待处理清理以及启动器超时后对共享守护进程的保护。
- Windows 守护进程启动时与调用方 Job Object 隔离。
- 后台导航和视口/全页截图无需激活受控标签；全页截图支持小数 DPI 和覆盖式滚动条。
- 限制渲染器和框架读取时间，可选布局读取超时后保留可用观察，并防止超时后的读取重叠。
- 页面操作保持显示在非模态侧栏旁，并遵循无障碍模态状态。
- 防止控制覆盖层吞掉点击，并在释放观察标签时清理过期覆盖层。
- 接受小写特殊按键，不区分大小写匹配 ARIA 加载状态，选择操作返回可见选项标签，并在录制中保留同 URL 重新加载。
- 在传输过期前交付导航超时结果，并限制人工协助清理时间。
- 跨待连接设备执行远程容量限制，重命名浏览器实例时保留活动会话。
- DSH 插件在子进程退出但流未关闭时结束命令，限制取消和输出排空时间，并保留已完成结果。
- DSH 插件在重载和恢复会话后恢复延迟工具注册，避免反复扫描流式历史。
- DSH 插件独立于宿主附件 UI 渲染截图卡片，在宿主重新渲染时保留预览，并确保极端宽高比缩略图可用。
- 保留受管理技能来源链接，处理 CRLF 元数据和不完整安装。

## [0.3.0] - 2026-09-16

### 新增

- [远程浏览器连接](docs/remote-extension-connection.md)：内置服务器、一次性配对链接、设备凭据续期和撤销，以及原生 TLS 或 TLS 反向代理；不支持远程上传下载。
- [操作审计](docs/operation-audit.md)：可选的守护进程主机任务历史，包含脱敏操作元数据、导出、删除和 30 天保留。
- 扩展快捷操作和 CLI 的[全页截图](docs/long-screenshot.md)，支持流式 PNG 输出、取消和懒加载页面捕获。
- Canvas 视觉引用、按需元素截图和与截图绑定的坐标点击；显式设置 token 限制时可续接观察游标。
- CLI、扩展和 DSH 插件的[滚动到元素](docs/scroll-to.md)，支持祖先裁剪后的可见边界、iframe 和协作取消。
- 原生[鼠标滚轮输入](docs/wheel.md)，以及显式聚焦和失焦操作。
- 为命令沙箱会回收后台进程的 agent 提供[宿主管理的守护进程设置](docs/sandboxed-agents.md)，支持 `BSK_HOME` 和 `BSK_AUTO_START=0`。
- 扩展弹窗支持配置本地连接端口，并新增韩语本地化。

### 变更

- **自动化设置：**扩展保存的借用确认和人工协助开关适用于已有及新会话。`--unattended`、`tab borrow --no-confirm` 和 `BSK_REQUEST_HELP=off` 为弃用的兼容输入，不能覆盖这些开关。升级无人值守流程时请设置浏览器偏好。
- 受管理的 CLI 技能仅在内容与已安装基线一致时更新；保留自定义指令和本地修改，`doctor` 提供恢复指引。
- DSH 插件优先使用原生浏览器侧栏，不可用时回退到浮动面板。

### 修复

- Windows 安装程序路径处理、已解析可执行文件的验证，以及使用其他目录守护进程的安装替换。
- 分阶段升级组件时的浏览器连接偏好恢复和兼容性。
- 观察文档和框架几何一致性、Canvas 目标身份检查，以及取消或导航期间的截图/会话清理。

## [0.2.1] - 2026-09-09

### 变更
- DSH 插件：明确安装、配置、重启配置及升级说明。

### 修复
- CLI：可靠的 Windows 自更新，包括可执行文件替换和守护进程重启。
- CLI：Windows 命名管道连接连续性及过期守护进程检测。
- Windows 安装程序：PowerShell 5.1 兼容性、路径引用和分阶段替换可执行文件。
- CLI / DSH 插件：父进程退出时传播取消并清理上传下载。
- 扩展：agent 标签打开失败或借用标签归还、关闭时的标签归属和会话清理。
- 扩展：其他扩展限制 Chrome DevTools Protocol 访问时的导航恢复。
- 扩展：后台输入填充、自动追加，以及报告成功前验证字段值。
- 扩展：页面变化后将观察到的表单状态匹配到正确元素。
- 扩展：非安全来源上录制和覆盖层的 UUID 回退生成。
- 匹配地区语言变体的浏览器语言设置。
- DSH 插件：观察状态同步、缩略图捕获生命周期及过期预览清理。
- DSH 插件：移除过时的客户端运行时宿主依赖。

## [0.2.0] - 2026-09-02

### 新增
- CLI、扩展和 DSH 插件支持文件上传下载。
- 文件拖放上传（`drop-to-upload`）。
- VOM 语义图、名称丰富和悬停感知模块。
- VOM 悬停探测（通过 `observe` 参数启用）。
- DSH 插件的浏览器工具与 CLI 命令对齐。
- CI 自动发布 Edge Add-ons。
- CLI / 扩展协议版本不同时提醒升级。
- 浏览器评测框架（`evals/browser/`）。
- 统一发布脚本（`scripts/release.mjs`）。

### 变更
- **版本方案：**三个组件使用相同的语义化版本号。
- 优化 VOM 渲染算法。
- 精简 SKILL.md agent 指令。
- DSH 插件：简化浏览器命令。
- 借用确认体验：主动聚焦并延长超时。
- 画中画窗口新增关闭按钮。

### 修复
- 截图媒体类型检测（此前硬编码为 `image/png`）。
- DSH 插件会话生命周期稳定性。
- DSH 插件 Cordis 包 ID 不匹配。
- 观察缩略图媒体类型识别。
- 上传下载竞态和布局绕过问题。
- VOM 重复名称和安全策略问题。

---

*更早的版本各组件使用独立版本号。*

## CLI 0.1.11 / Extension 0.1.7 / DSH Plugin 0.1.2 — 2026-08-26 ~ 2026-08-29

### 新增
- DSH 插件侧栏集成、会话生命周期和归档清理。
- 录制器支持 iframe 和 OOPIF。

### 变更
- VOM 功能重构。

### 修复
- 录制器安全策略和错误修复。

## CLI 0.1.10 / Extension 0.1.6 — 2026-08-08

### 新增
- VOM 观察录制和稳定状态检测。
- 录制覆盖层计时器。

### 修复
- 浏览器保活断连处理。

## CLI 0.1.9 / Extension 0.1.5 — 2026-07-29

### 新增
- CLI 自动更新机制。
- Trace v3 协议和录制器。

### 修复
- MV3 保活断连。

## CLI 0.1.8 / Extension 0.1.4 — 2026-07-22

### 新增
- 更多浏览器交互操作。

### 修复
- Windows 命名管道仅哈希路径问题。

## CLI 0.1.7 / Extension 0.1.3 — 2026-07-07

首次公开发布的组件版本。

## CLI 0.1.6 — 2026-06-30

### 修复
- CLI 小问题修复。

## CLI 0.1.5 / Extension 0.1.2 — 2026-06-22

首次打标签发布。
