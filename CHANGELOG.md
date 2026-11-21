# Changelog

All notable changes to BrowserSkill will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).
See the [Chinese changelog](CHANGELOG.zh-CN.md). Update both versions in the same PR.

The CLI and extension may release separately. Protocol compatibility
determines which versions can connect.

## [Unreleased]

### Added

- Release benchmarks now report empirical `pass@k`, `pass^k`, and flaky cases across independent runs of the same candidate and test plan.
- **MCP 100% parity**: Added `bsk_ledger`, `bsk_debug`, `bsk_video`, and `bsk_record` first-class tools alongside full CLI parity on existing tools (`session open/stop --all`, `sync` waits/filters, `wait_ms`, `view`, full-page `screenshot` / `extract` `--out`/`--overwrite`/`--format`/`--csv-safe`, `read` `context`, `upload`/`download`, `tab_borrow`, full `emulate`, and `operation_await --out/--overwrite`), unified behind request-scoped `ClientContext`.
- **Compile-time `MethodSpec` & `RpcErrorReason` SSOT**: Defined exhaustive `bsk_protocol::method::MethodSpec` metadata across all 77 RPC methods (exported to TypeScript `transport/generated/`) and exhaustive `RpcErrorReason` variants with dual CLI/MCP recovery hints (`cli_hint` / `mcp_hint`).
- DeepSeek Harness (`dsh`) is now a first-class skill installation target via
  `bsk install-skill --harness dsh` (honoring `$DSH_HOME`, defaulting to
  `~/.dsh/skills`), `DSH_SESSION_ID` is recognized as an automatic host
  subagent scope in `ImplicitScopeRegistry`, and MCP `bsk_session(action="start")`
  now accepts `agent_name`, `project`, and `controller_color` controller identity
  labels matching `bsk session start` (#731).
- Added an **Open Agent Windows minimized** preference under popup Automation
  settings (`bsk_interaction_preferences.openAgentWindowMinimized`, off by
  default) so background Agent Windows can start directly in the minimized state
  without flashing a normal window frame on screen, while keeping explicit
  foreground sessions (`--focus`) and action recording visible ([#649](https://github.com/Tencent/BrowserSkill/issues/649)).

### Changed

- **Complete `browser-driver/` boundary encapsulation, strict `CdpRunner` RAII contract, unified `--selector` DOM predicates, and structured VOM metadata**: Sealed `CdpTarget`, `CdpFrame`, `CdpFrameGraph`, `sendToTarget`, `sendGuarded`, `sendAttached`, and `getFrameGraph` inside `apps/extension/src/browser-driver/` behind `FrameDocumentHandle`, `FrameNodeHandle`, `FrameProcessBoundary`, and `TabEventSource` across all remaining upper-layer modules (`read`, `extract`, `waits`, `wheel`, `drag`, `action-guard`, `vom/facts`, `AccessibilityLease`, `debug/`, `recording-runtime`, and `geometry/frame-context`); promoted all `CdpRunner` methods to a non-optional interface backed by `delegateCdpRunner`, `createStubCdpRunner`, and deterministic RAII `withObjectGroup` / `withRemoteObject` V8 handle release (`handleSelect`, `handleFill`, `handleFocus`/`handleBlur`, `action-checks`, `file-input-transaction`, `file-drop-transaction`, `waits`, `element-geometry`, `cdpRunnerForFrame`, and `evaluate` with `return_by_value: false`, without resurrecting detached tabs or masking pre-dispatch errors); unified cross-frame, open Shadow DOM, `[data-bsk-overlay]` / `[data-bsk-overlay-host]` exclusion, sensitive `autocomplete`, and interactive ARIA role predicates across `interaction`, `CooperationController`, `human-loop`, `read`, `extract`, and `content/dom-primitives`; and converged `cooperate sync` and `observe` onto structured `@browser-skill/vom` `VomLineMetadata` (`inspectVomLine` and `VOM_DERIVED_NAME_CAP`).
- **Lightweight `@wxg-prc-cpg/browser-skill-dsh-plugin` on the unified `bsk` CLI runtime**: Replaced the ~22k-LOC bespoke `bsk_*` wrapper and Web UI bundle in `packages/dsh-plugin-browserskill` with a lightweight Cordis plugin (free of `@deepseek-ai/dsh-*` host `rc` peer locks) that packages the canonical `crates/bsk-cli/skill` bundle, automatically heals host `PATH` for `~/.local/bin` (`$BSK_INSTALL_DIR`) and configured `bskPath`, and bundles an on-demand cross-platform `bsk` CLI + browser extension setup workflow (`bin/install-bsk.mjs` + `AGENT_INSTALL.md`) sharing the standard `bsk` CLI and `DSH_SESSION_ID` daemon scoping alongside restored `dsh-plugin-v*` release automation.
- **Zero-tax Chrome MV3 `registration: "runtime"` dual-tier content script injection, SW-startup orphan Agent Window reaping, and shared `content/dom-primitives.ts`**: Migrated all four MV3 content-script entrypoints (`content`, `cooperation.content`, `record-frame.content`, and `long-screenshot-page.content`) out of static `manifest.json` `content_scripts` into idempotent runtime injection (`claimIdempotentContentScript`) with `noScriptStartedPostMessage: true` so ordinary browsing incurs zero content-script, `window.postMessage`, or React 19 overhead; injected Tier A (`content.js` and `long-screenshot-page.js`) per `tabId`/`documentId` via idempotent `ensureOverlayInjected` across controlled task tabs, `webNavigation.onCommitted` (including Speculation Rules prerender outermost frames, sequenced strictly after Tier B `cooperation.js` arming/repair), pre-confirmation `tab_borrow` candidate user tabs, `request_help`, `record`, and active `video` overlays while skipping uninjected tabs on `hidden` / `CAPTURE_SUPPRESS` / `INPUT_PASSTHROUGH`; dynamically registered/unregistered pure-TypeScript Tier B (`cooperation.js` and `record-frame.js`) with `persistAcrossSessions: false` when active sessions or recordings transition between `0` and `>= 1`, loading silently at `document_start` with 0 DOM listeners and 0 startup IPC until armed by Background (`COOPERATION_ARM_FRAME` / `RECORD_FRAME_START` plus 50ms per-tab subframe coalescing, `cooperation.js` co-injection in `injectRecordFrameAllFrames`, and non-destructive per-frame `injectCooperationAllFrames` repair across `tab_borrow`, `ack === undefined` frames, and dynamically inserted light-DOM or open/closed `ShadowRoot` `about:blank` / `srcdoc` subframes); tracked dedicated Agent Window `ownedTabIds` in `chrome.storage.session` (`bsk.orphan_agent_windows`) to reap orphaned pure Agent Windows on Service Worker restart without ever closing windows containing user, borrowed, or human-preserved tabs; and extracted `apps/extension/src/content/dom-primitives.ts`.
- **Single daemon `tool_pipeline`, 4-module `daemon/ipc` decomposition, non-blocking persistence, and shared `cli::orchestration` kernel**: Decomposed 3,489-line `daemon/ipc.rs` into `daemon/tool_pipeline.rs` (single unified `tool.*` pipeline with RAII `AuditTicketGuard`, `SessionActivityGuard`, `ToolInflightRegistry`, `IntentWal`, and post-settlement scope/run-log reconciliation), `daemon/ipc_sessions.rs`, `daemon/ipc_transport.rs`, and a slim `daemon/ipc.rs` router; promoted exhaustive `OutcomeKind` (`bsk-protocol`) / `Outcome` (`daemon/tool_policy.rs`) routing in `daemon/queue.rs`; moved `TransferRegistry` staging/import/session-teardown I/O, `AuditStore` JSONL `sync_data()` writes (including `session.user_interrupt` markers), and monotonic-sequence `IntentWal` flushes/atomic `sync_data()` compactions out of global state `Mutex`es and Tokio worker threads via `spawn_blocking`; and extracted `cli/orchestration.rs` to share Canvas screenshot point-click validation, `open`/`sync`/action/positive timeout bounds, explicit `--session` + `--browser` conflict checks, cached VOM hydration, and 2-second `CANCEL_RESPONSE_GRACE` settlement across `bsk` CLI and `bsk mcp`.
- **100% strongly typed `bsk-protocol` contracts, typed `EventFrame` payloads, out-of-band WS correlation, and native `ActionMetadata` SSOT**: Replaced all 19 remaining `serde_json::Value` RPC contracts in `Method::contract_meta` (`ToolCooperate`, `LocalAuth*`, `AuditRequest`, `LedgerRequest`, `Session*`, `BrowserList`, `ToolOperationAwait`, and `Transfer*`) with strict Rust/JSON Schema structs, replaced untyped `EventFrame.payload: Value` across Rust and TypeScript with an exhaustive 10-variant `EventFrame` discriminated union, moved `_audit_id` and `_operation_id` out of business `params` into top-level `RequestFrame` envelope fields (deleting in-place `params` mutation and `stripEnvelopeParams`), embedded `ActionMetadata` / passive `context_id` natively with `#[serde(deny_unknown_fields)]` across all 23 `Full` and 9 passive-read `*Params` structs (eliminating post-hoc `catalog.rs` JSON Schema surgery and manual 4-key copy/re-insertion in `daemon/ipc.rs`), and unified `MethodSpec.action_metadata` (`Full` / `ContextOnly` / `TabBindingContext` / `Dynamic` / `None`) as the single source of truth across `bsk-protocol` and `bsk-cli`.
- **Unified daemon session teardown, strongly typed `IpcEnvelope`, and MCP host-scope lifecycle**: Converged all 6 session teardown paths across `state.rs`, `ws.rs`, `ipc.rs`, `start.rs`, `session_requests.rs`, and `sessions.rs` into `DaemonState::teardown_session(session_id, reason)` covering all 12 session-associated state tables, promoted `HOST_AGENT_ENV_KEYS` ahead of transient `mcp:<pid>:<nonce>` scopes so `bsk mcp` and `bsk` CLI within the same host agent thread share one implicit session (while immediately stopping orphan sessions on `stdio` EOF or disconnect read errors only for exclusive transient `mcp:` scopes), added 256-entry LRU eviction for inactive scope tombstones and idle `start_locks`, and replaced private `_`-prefixed IPC JSON fields with strongly typed `IpcEnvelope` metadata (`IpcRequestMeta` / `IpcResponseMeta`) negotiated via `StatusResult.ipc_envelope` and `DaemonInfo.ipc_envelope` (preserving bidirectional rolling-upgrade compatibility with pre-envelope `"2.0"` `bsk mcp`, CLI, and daemon processes) plus explicit extension-WS `WsCorrelation`.
- **Single `TabAttachment` state machine & `FrameNodeHandle` addressing**: Collapsed `ChromiumCdp`'s 33 parallel per-tab `Map`/`Set` fields into a single `Map<TabId, TabAttachment>` discriminated union (`detached | attaching | attached | soft_detached`), made `onEvent(tabId, handler)` a tab-scoped `Disposable` subscription holding an automatic idle lease, and sealed all transient `cdpSessionId` routing inside `browser-driver/` behind `FrameNodeHandle` and `FrameDocumentHandle` across `RefStore`, VOM visual observation and capture mappings, `read`, `extract`, `observation`, `interaction`, `waits`, `human-loop`, `recording`, and `CooperationController`.
- **Protocol `2.0` baseline**: Raised `PROTOCOL_VERSION` and `MIN_COMPATIBLE_PROTOCOL` to `"2.0"`, eliminated extension/daemon legacy version drift, and slimmed `apps/extension/src/transport/generated/validators.js` by over 60% (`~992 KB` -> `<= 390 KB`).
- **Daemon & extension routing consolidation**: Replaced 9 independent handwritten method tables and `OnceLock` process globals with generated/exhaustive `MethodSpec` tables and explicit `ClientContext` request state.
- Unified all real-browser test and regression harnesses onto `BSK_TEST_CHROME`
  and `BSK_TEST_CLI` (resolving Windows `.exe` binaries and stripping host agent
  scope env vars in isolated daemon fixtures), separated `.browser.test.ts` and
  `.bench.ts` from the unit Vitest configuration into
  `apps/extension/vitest.browser.config.ts` and `scripts/run-browser-tests.mjs`
  (routing `pnpm --filter @browser-skill/extension test:browser` through the
  runner and enforcing `skipped === 0`, non-empty suite assertions, and
  per-target suite coverage), and wired every extension `.browser.test.ts` suite
  plus `eval:browser:check` and `eval:browser:dynamic-read` into CI (#731, #732).
- Converged scattered default daemon ports, WebSocket URLs, pairing/auth protocol constants, instance ID length, JSON-RPC standard error codes, and `BASE_TOOL_NAMES` into `bsk-protocol` / `bsk` SSOT exports (eliminating hand-maintained duplicates and brittle collection-length assertions), consolidated Rust integration test binaries from 51 to 6 while adding `debug = "line-tables-only"` for `dev`/`test` profiles, split extension Vitest unit runs into `unit-node` and `unit-dom` projects under `threads` pool while removing dead/trivial tests and consolidating single-helper files, replaced fixed wall-clock test sleeps with deterministic clock/mtime/readiness control, added `copyIsolatedExtension` to eliminate redundant per-port `ext:build` CI steps, and added Rust Cargo cache and batched CI steps in `.github/workflows/ci.yml`.

### Fixed

- Fixed VOM `applyActiveRegionPolicy` falsely hiding clickable cards, links, buttons, and their descendants whenever a non-full-viewport `position: fixed/absolute/sticky` element partially overlapped even a single corner or edge (such as product/video card corner badges, sticky headers grazing a control's top edge, or floating support buttons grazing a card corner): region occlusion now requires all 9 inset interaction sample points to be covered by eligible higher-paint-order foreground regions (including multi-region joint coverage while still hiding controls behind sidebars, drawers, and overlapping positioned panes), preserves geometrically uncovered interactive/visual descendants inside covered clickable containers (keeping rescued Canvas visuals attached under their surviving ancestor while still pruning passive descendants of truly blocked controls), and ignores root document shells and negative `z-index` / `paintOrder` decorative backgrounds including positioned descendants inside negative-`z-index` stacking contexts (propagating parsed CSS `z-index` from `DOMSnapshot` so Chromium's `PaintLayer` ordering never treats `z-index: -1` backdrops as foreground blockers).
- Fixed a permanent session deadlock when `tool.evaluate` runs a slow or never-resolving Promise (such as `new Promise(() => {})`) and is cancelled by a user or daemon deadline: `ChromiumCdp.send()` and `getFrameGraph()` now forward their `AbortSignal` into `command()` / `CdpReadGate.run()` and wait abortably on shared `ensureAttached()` setup (so cancelling during a slow initial `Page.enable` also unblocks immediately with `effect_state: "none"`), `waitForAbort()` (and `runCdpCommand()`) attach `.catch(() => {})` to abandoned native CDP promises so late tab-close/detach rejections never emit unhandled rejections, `CdpReadGate` skips tripping its renderer read blocker when an `awaitPromise: true` `Runtime.evaluate`/`Runtime.callFunctionOn` call is aborted (so subsequent `observe`/`click`/`evaluate` calls recover immediately instead of failing with `renderer_read_timeout`), `handleEvaluate` dispatches `Runtime.evaluate` through `sendToFrame` with `signal` and an `onDispatch` fence to classify aborts accurately as `code: "cancelled"` with `effect_state: "none"` (`dispatched: false`) before dispatch and `effect_state: "unknown"` after dispatch, `withRemoteObject`/`withObjectGroup` bound `Runtime.releaseObject*` cleanup waits to 1s so hung cleanup cannot lock the session, `CooperationController` skips redundant post-action frame refreshes on already-aborted `evaluate`/`upload` calls, and `ToolDispatcher` awaits pending (including synchronously chained) JS dialog dismissal within daemon's 2s cancel budget (`1.5s`) before releasing `activeDialogOperations` without disturbing the `DialogPending` accept/dismiss workflow.
- `bsk daemon start` now explains a failed bind on the default daemon port: on Windows, WinNAT / Hyper-V / WSL2 can reserve port 52800 inside the TCP dynamic port range after a reboot, so the error names that cause, shows `netsh int ipv4 show excludedportrange protocol=tcp` to confirm it, and points to `bsk daemon start --foreground --port <port>` with the extension pointed at that port. Failures on an explicit `--port` keep the plain OS error (#767).
- Fixed false `"the user has control of this tab"` (`human_intervention` / `"User activity revoked this action"`) interruptions when scripted JavaScript (such as `bsk evaluate` calling `document.execCommand('insertHTML' | 'delete' | 'insertText', ...)` on rich-text `contenteditable` / form editors, or `.click()` on `<input type="checkbox">` / `<input type="radio">` / `<label>` controls) triggers Chromium's trusted default-activation `input`/`change` events without any real user gesture: `cooperation-capture.ts` now tracks untrusted programmatic clicks in the current task (so synchronous default checkbox/radio activations are not misclassified as human input) and ignores bare `InputEvent("input")` (plus its same-task blur `change`) dispatched on editable fields with no originating `beforeinput`, keyboard, pointer, wheel, drop, or IME composition event while still updating `fields`/`revision` and preserving detection of all genuine user interactions; capped `CooperationController`'s pre-execution readiness poll (`target_hidden` / `target_disabled` / `target_readonly`) at 5s (and below explicit short `timeout_ms` with a reply margin) so clicking permanently hidden controls (such as visually hidden WeUI checkbox `<input>`s) returns structured `target_hidden` (`effect_state: "none"`) instead of hanging for 30s/2m and losing the race to the daemon's RPC timeout; and allowed `tab_create`, `tab_select`, `tab_borrow`, `tab_return`, and `tab_close` to proceed when an owned non-borrowed agent tab (including human-preserved `observedTabs`) is stuck on a settled `page_load_failed` error page instead of deadlocking with `"shared page control or observation changed"`.
- Eliminated `"A page frame is not responding"` (`cooperation_sync_required`) failures and session traps on heavy Canvas/CSS-in-JS web applications such as Lark Base / Feishu Bitable: short-circuited `cooperation-capture.ts` `styleFacts()` immediately when any stylesheet is cross-origin unreadable instead of serializing all inline CSSOM `rule.cssText` strings, skipped `@font-face` / `@keyframes` rules, deferred `invisibleAttribute` style checks until after structural `childList` filtering, and extracted `data-*` attribute names directly (`/^data-[-\w]+$/`) without full-sheet string concatenation while replacing quadratic `querySelectorAll("*")` / `closest()` / unconditional `chrome.dom.openOrClosedShadowRoot` sweeps across `dom-primitives.ts` and `cooperation-capture.ts` with `TreeWalker` subtree pruning and shadow-host tag filtering; forwarded caller `timeout_ms` (up to `25000ms`, including default `15000ms` `cooperate wait` and post-action `evaluate`/`upload` refreshes, with matching daemon transport and CLI/MCP IPC snapshot headroom) and `AbortSignal` across `bsk open`, `bsk sync`, `bsk cooperate sync|enable|wait`, and MCP `bsk_session(open|sync)` into `collectCooperationFrames` using a single non-duplicated `COOPERATION_READ` sweep per frame while still retiring silent hidden child frames after `3000ms`, retrying transient mid-observation document replacements in `--settle`, and bounding `settle` retries to the caller's remaining wall-clock `timeout_ms` budget; broadened `hidden-frames.ts` `ownedByHiddenElement` to recognize unfocused `pointer-events: none` and offscreen `position: fixed` frames, tolerate non-document `<object>`/`<embed>` or un-navigated `<iframe>` placeholders (`owners.length >= siblings.length`), and safely disambiguate silent hidden cross-origin iframes (such as session-refresh or third-party extension iframes) via exact-before-origin owner `declaredSrc` matching alongside visible cross-origin widgets; allowed `navigate`, `reload`, `navigate_back`, and `navigate_forward` to escape tabs stuck on `FrameUnresponsiveError` (including uncommitted `pendingUrl` states and `CdpReadGate`-tripped tabs) or `frame_unobservable` (including when `ImplicitScopeRegistry` auto-injects a prior `target` `context_id` after a cross-document transition, while proportioning short `timeout_ms` entry refreshes and bounding preflight CDP probes plus `Page.getFrameTree` / `networkidle` post-commit recovery handoffs in `navigation.ts` to remaining `timeout_ms` without corrupting reported timeout diagnostics); and bounded `executeScript` (`ensureOverlayInjected`, `injectCooperationAllFrames`, `injectRecordFrameAllFrames`, and `armCommittedFrame`), `pushOverlayStateForTab`, hover/record `bypassOverlay`, `RECORD_FRAME_START` / recording `sendToTab` / `waitForDocumentSettled` (plus proven-hidden child frame tolerance in `RecordFrameCoordinator.stop`), `CAPTURE_SUPPRESS` / `VIDEO_OVERLAY` / fallback screenshot bounds, `resetAgentOverlays`, and `COOPERATION_ARM_FRAME` to `3000ms` alongside alarm-tick keepalive heartbeats so wedged renderers never hang `session stop`, `navigate`, `screenshot`, `record`, or `video` or trigger MV3 Service Worker `kRequestTimeout` evictions (#766).
- `bsk window resize` on fractional display scaling (Windows 10 at 125%): a committed
  resize is now accepted when the browser reports bounds within 2 px of the request on
  either axis (`1100x700` landing at `1101x701`), instead of failing with
  `protocol_error` / `window_resize_constrained` / exit code `2` after burning the
  settling retries, while a genuinely constrained window still reports the same reason
  and the `window_resize_viewport_unchanged` guard stays unchanged (#771).
- `upload` and CSS `--selector` targeting across `iframe`s and hidden `<input type="file">`
  widgets (such as Layui's `display: none` file inputs) (#725): action and `wait-for-element`
  selectors now search accessible same-origin `iframe`s and cross-origin OOPIFs in parallel
  via `FrameDocumentHandle`s (bounded per child frame with unresponsive OOPIF `processKey`
  isolation in `CdpReadGate`, ownerless `getFrameDocuments` queries without poisoning geometry
  caches, deterministic frame-graph order, and mid-poll child-frame navigation resilience in
  `wait-for-element`) after checking the main document (enforcing cross-frame uniqueness under
  strict/target policy and tracking child-frame `frameEpoch` invalidation in cooperative
  control, while keeping `expect` preconditions main-document-scoped); when `upload` (`--mode
  input`) resolves directly to an `<input type="file">`, it validates connectedness, enabled
  state, and `multiple` before calling `DOM.setFileInputFiles` without requiring visual
  geometry or renderer-frame click readiness; OOPIF and same-origin cross-frame chooser
  triggers ensure the child `Page` domain is enabled and accept intercepted
  `Page.fileChooserOpened` events (including dynamically created detached file inputs); and
  CLI, MCP, and bundled skill descriptions now guide callers to prefer visible upload trigger
  `@eN` refs or target `<input type="file">` selectors directly.
- Fixed native input commands (`click`, `fill`, `press`, `wheel`, `drag`, `step`, `plan`) failing with `"Native input clock calibration failed: Cannot attach to this target."` (`cdp_failed` / `input_clock_unavailable`) on Chrome 157+ Web Store and policy-installed builds where Chromium restricts `chrome.debugger` discovery/attachment or offscreen helper creation on `video-offscreen.html`: `sampleNativeInputClock` and `NativeInputClock` now automatically fall back to uncalibrated wall-clock dispatch (`offset: 0`, caching non-transient probe restrictions across `NativeInputClock.invalidate()` so the offscreen document is not respawned on subsequent sessions while retaining `sameClock` monotonic drift fencing before native dispatch), and aligned real-browser wheel zoom assertions and documentation with Chromium 158+ preserving CSS-pixel `Input.dispatchMouseEvent` wheel deltas across browser zoom (#742).
- Eliminated frequent false `"Page interaction coverage changed; wait and synchronize"` (`control_context_invalid` with `effect_state: "unknown"` and `IntentWal` tab freezes) across SPA sites and pages with dynamic subframes: separated same-document root URL updates (`Page.navigatedWithinDocument` and `FrameState.url`) from cross-document root destruction via `ChromiumCdp.onRouteChanged` / `CooperationController.invalidateRoute` (restoring `rootFrameId`, reconciling child frames across `soft_detached` reattach and post-dialog checks on same-document route updates, and stopping same-process child-iframe `DOM.documentUpdated` events from firing root `onDocumentChanged`) so live collectors stay available, multi-step inputs (`fill`, `scroll-to`, `wheel`, `press`, `select`, `click`, `drag`) and `bsk plan` batches survive same-pathname query/anchor updates (while consuming strict baselines for untargeted actions) and pathname/hash-router transitions revoke stale contexts cleanly after action settlement (`effect_state: "none"`), completed `fill` Step 3 across both `onBeforeNavigate` and instant-commit auto-submitting forms (`finalValueAlreadyNotified`) as well as post-input `Runtime.callFunctionOn` / `DOM.getBoxModel` visibility measurement across main and child frames, sequenced background `observeTab` behind `armCommittedFrame` while initializing collection leases on `COOPERATION_ARM` and `COOPERATION_RESUME` for newly mounted child frames, allowing `collectCooperationFrames` replacement passes past proven-hidden unobservable subframes, and isolating in-flight `state.working` operations and `target` contexts from non-owner `refresh` failures, and preserved explicit handler errors (`navigate`/`reload` errors and structured `result.data.reason` errors such as `download_capture_failed` and `fill_target_changed`) while revoking stale implicit `target` context auto-injection in `ImplicitScopeRegistry` (without dropping cached `last_vom` / alias hydration for `unchanged` and `delta` syncs) and allowing `navigate`/`reload`/`navigate_back`/`navigate_forward` recovery off `page_load_failed` error pages (#762).
- Fixed `tool.wheel` skipping compositor paint readiness (`waitForInputPaint`) under `ToolDispatcher` persistent background leases on unfocused or minimized windows by decoupling `ReadyInput.hidden` (`lacksForegroundPresentation`) from temporary `restoreFocus` and wiring `windowsApi` in `ToolDispatcher`; stopped `target`-policy `--selector` actions in `CooperationController` from polluting `session.refStore`, emitting `used_ref` (while preserving `used_selector` on `--selector` action receipts without polluting `tool.drag`'s `DragResult` or `tool.press`'s `PressResult`), or leaking hallucinated `@eN` references in `handleSelect` custom-dropdown error messages (`withPinnedSelectorTargets`); refreshed live frame activity inside `CooperationController.beginDomMutation()` under `target` policy before scripted DOM writes while preserving `state.baseline` (`observation_id`) when pre-write validation fails with `effect_state: "none"`; fixed `clearRecordingForSession` to use the caller/dispatcher's `deps` (`RECORD_CANCEL` + `bypassOverlay(tabId, false)`), required explicit `isAgentWindowId` in `returnBorrowedTab` so returning a borrowed user tab never routes into another session's Agent Window, replaced module-global download locking with instance-scoped `DownloadConcurrencyGate` (`session_busy`, `effect_state: "none"`, `dispatched: false`), and cleaned up `observeIdentityStreaks`, `hoverLatches`, and `hoverBypassTabs` on session teardown and `tabs.onRemoved`; enabled Canvas `[visual:screenshot]` `@eN` parity on `cooperate sync`, budgeted the `renderDoubleLayer` `L2 page … occluded by L1` footer line within `maxTokens`, and moved popup `[expanded]` / `[has-submenu]` tags out of `vom.name` to post-quote VOM tags so custom dropdowns no longer emit duplicate `[expanded]` suffixes.
- Eliminated redundant back-to-back frame collection sweeps in `guardedRunner.runBrowserMutation` (`action-guard.ts`), skipped mutation fencing on passive `inspect` probes in `handleFullPageScreenshot`, and raised the per-frame cooperation IPC reply deadline (`FRAME_REPLY_TIMEOUT_MS` / `OWNER_REPLY_MS`) from `1200ms` to `3000ms` so cold high-DPR / software-rasterized full-page captures and Tier-A overlay mounts do not spuriously fail with `FrameUnresponsiveError` (#761).
- Added `--max-tokens` (`max_tokens` in MCP) to `bsk step`, `bsk plan`, `bsk_interact` (with `sync_after` or `until_visible`), and `bsk_plan`, forwarding it to the post-action `tool.cooperate` sync instead of hardcoding `None` so `--max-tokens` baselines stay reusable across `delta` and `unchanged` syncs without forcing an unbounded page re-capture (#755).
- Ignored internal `data-bsk-*` attributes and `<browser-skill-overlay>` (`[data-bsk-overlay]`) ShadowHost mutations in `cooperation-capture.ts` so active recording and sensitive-field markers no longer advance `FrameState.structure`, excluded extension ShadowRoot UI controls (`HelpRequestOverlay`, `RecordOverlay`, `BorrowConfirmationOverlay`) across `record-capture.ts`, `record-hover-surface.ts`, and `cooperation-capture.ts` so overlay interactions and hover surfaces are never mis-recorded as webpage steps, and re-evaluated tab control ownership after awaiting `ensureOverlayInjected` so mid-injection tab detachments never flash stale `control` state.
- VOM token estimation now handles unpaired UTF-16 surrogates without combining them with the following symbol or throwing a `RangeError`; valid emoji pairs retain their existing estimates.

- Fixed non-`start` `tool.video` (`status`/`stop`/`list`/`get`/`delete`), `tool.operation_await`, and scope-bound `tool.wait_ms` bypassing `ToolInflightRegistry` cancellation (and scope-bound `tool.wait_ms` omitting `SessionActivityGuard` idle leases or `ToolDialogAccept`/`ToolDialogDismiss` `decision_lock` waits masking `UserAborted`/`SessionEnded` reasons) on `session.user_interrupt` and `DaemonState::teardown_session` (`session.window_closed` / idle reap / disconnect), fixed `IntentWal` `flush_pending_async` returning before concurrently drained `DISPATCHED` records hit disk and `on_session_ended` leaving un-reconciled `dispatched`/`unknown` records on disk across daemon restarts, fixed `queue.rs` misattributing deadline cancel-cleanup timeouts on non-transfer tools (`navigate`, `screenshot_full_page`, `window_resize`, etc.) as `"file transfer timed out"` (`transfer_outcome_unknown`) and stripping extension `effect_state` / `cancelled_before_dispatch` metadata on cancelled file transfers (including when terminal session teardown reasons are present), fixed Canvas screenshot point-click and zero-timeout validation drift across `bsk` CLI and MCP (`bsk_interact`, `bsk_page`, `bsk_inspect`, `bsk_tabs`, `bsk_assist`, `bsk sync --wait-for/--wait-not --timeout-ms` up to `120000`ms, and structured `scope_browser_conflict` errors on MCP `bsk_session(open)`), and fixed MCP `notifications/cancelled` dropping in-flight IPC futures at `0`ms without awaiting `CANCEL_RESPONSE_GRACE` (recovering real `effect_state` receipts and releasing staged upload files on `cancelled_before_dispatch`).
- Fixed `dump-schema --method <name> --output` emitting input schemas instead of `output_schema`, fixed `scripts/protocol.mjs` omitting input-only nested `$ref` types (such as `ActionExpectation`, `CookieFilter`, and `UserAgentBrandVersion`) from `transport/generated/input.ts`, fixed MCP `strip_schema` deleting argument and nested property `description` fields from `tools/list` `inputSchema` (stripping only the root struct doc comment at `depth == 0` and preserving inner `oneOf` `null` branches when collapsing `Option<T>`), typed `LoggedStep::Action.modifiers` as `Option<Vec<KeyModifier>>` while closing the `RunLogs` `character_key` input-privacy filter bypass on `modifiers: []` / `null` / `["shift"]`, typed `CooperationController.command` against `CooperateResult` while failing `cooperate wait` immediately on concurrent tab close/release instead of spinning until timeout with `state: undefined`, accepted explicit `"payload": null` on empty-payload `EventFrame` variants, and aligned `bsk sync` activity fixtures with genuine `CooperateActivity` wire contracts.
- Fixed mid-call idle-timeout session reaping during `Unlocked` tool RPCs, `operation await`, `debug(activity|wait)`, `video`, `ledger`, and `session.run_log` via RAII `SessionActivityGuard` leases, promoted `ToolDialogAccept` to `cancel_at_deadline: true` + `EffectAwareAction` serialized behind a per-session `dialog_operations` decision lock before `IntentWal` reconciliation, gated `ImplicitScopeRegistry` binding on explicit `bind_scope || reuse_or_start_scope` so ephemeral `record` and `recipe` sessions never clobber or tombstone the caller's bound session, eliminated prose-substring `IntentWal` classification in favor of structured `dispatched: false` / `effect_state` error data across `CooperationController` (`bootstrap` / `strict` / `target`), `Dispatcher`, `dialog-control`, and `queue`, added `ErrorCode::UserAborted` to `IntentWal` `Unknown` reconciliation with authoritative multi-tab `tab_id` attribution, and pinned open tabs' active `cN`/`oN` short aliases across >32 ring evictions.
- Closed the post-#737 VOM cache last-mile gaps across CLI, MCP, and daemon: hydrated `observation` and `observation_origin` in `bsk sync --json` (and normalized `{ "vom": ... }` receipts in `bsk view`) so saved `bsk sync --json` files work directly with `bsk view` and `--baseline`, reused `scope_meta.cached_vom` on slim `unchanged` and text-patched `delta` frames in `authoritative_full_vom` (`--wait-for`/`--wait-not` without redundant `tool.snapshot` fallbacks) and MCP `bsk_session(open|sync)`, hydrated slim `delta` VOM into `RunLogs` while isolating `known`/`masked` ref tables per tab across multi-tab sessions, pinned Step 0's resolved `session_id`/`tab_id`/`context_id` across Steps `1..N` in `bsk plan` and `bsk_plan`, wired `endpoint_pipe_name` across Windows named-pipe server/client IPC, and expanded cross-platform Windows daemon CI unit and integration test coverage alongside updated `2.0` protocol and skill references.
- Fixed session idle-timeout reaping missing `dialog_operations.remove_session` and losing the `session_idle_timeout` tombstone reason on subsequent browser disconnect, fixed unclaimed `session_requests` cleanup missing `dialog_operations`, `scopes`, and `intent_wal` teardown, and unified `DialogOperation` post-settlement reconciliation (`scopes`, `intent_wal`, and `run_logs`) so operations suspended with `DialogPending` and completed via `dialog accept/dismiss` + `operation await` update `run_logs` to their real completion outcome instead of leaving `Uncertain`.
- Fixed `--max-tokens` truncated baselines short-circuiting subsequent unbounded or differently budgeted `bsk sync` calls (`baseline_reason: "token_budget_changed"` across both `strict` and `target` policies plus daemon budget/predecessor checks), patched cached `last_vom` in-place on `target`-policy text `delta` updates (including equal-budget `--max-tokens` truncated observations and whitespace-collapsed empty line patches) while clearing `last_vom` on unpatched form `field` deltas so `bsk sync --match-text` never matches stale input values, preserved `truncated`, `capture_truncated`, `next_cursor`, and `presentation` across `bsk sync` cached hydration and receipt formatting, and added symmetric unbounded `tool.snapshot` fallback (with automatic cooperation re-sync) for `--wait-for` when `--max-tokens` truncates the observation.
- Fixed cross-origin OOPIF `visual-region` `@eN` references and `--capture-id` coordinate clicks failing with `visual_target_changed` after 75s idle Soft-Detach reconnects (when Chrome assigns a new internal child `sessionId` while `frameId + loaderId` remain unchanged), deterministically rejected stale `FrameNodeHandle` / `FrameDocumentHandle` targets across child-frame `loaderId` navigations and same-`loaderId` `document.open()` replacements, and restored 75s idle Soft-Detach after one-shot `console` / `network` reads and `debug start -> stop` lease release.
- Fixed native-dialog gate bypass when `tool.debug` (`replay`) triggers browser dialogs, missing `intent_wal` tracking on `download`/`dialog_accept`/`debug(replay)`/`navigate`/`reload`, and missing `EffectAwareAction` policies on `window_resize`/`emulate`/`tab_close`.
- Fixed MCP error hints emitting CLI-only commands (such as `bsk ledger resolve`), missing `discard`/`exported` video cooperation actions, missing `navigate_back`/`forward`/`dialog_*` debug evidence classification, missing audit labels, and `recipe` `session_gone` detection of `session_stopped`/`no_active_session`.
- Preserved user window focus on macOS and Linux/X11 Chromium when creating or
  initializing background Agent Windows and tabs (`chromeAgentWindowApi.create`
  seeding an inactive tab via `tabId` on Linux while excluding active or
  starting Agent Windows from donor selection, and `tool.tab_create` /
  `ensureActiveTab` creating inactive tabs before activating via
  `chrome.tabs.update`, closing orphan tabs or claiming cleanup failures into
  `agentCreatedTabs`), enabled the Aura screencast compositor keepalive (and
  full-page stale-frame guard) on headed Linux and Windows across `screenshot`
  and `screenshot --full-page` on unselected tabs and unfocused/occluded or
  minimized Agent Windows (skipping `HeadlessChrome/`), and made
  `parsePngDimensions` charset-independent when bundled (#731, #732).
- Preserved foreground window focus during native pointer interactions (`click`,
  `drag`, `download`, and `upload`) in background Linux Agent Windows, ordered
  CDP focus emulation, temporary `about:blank` tab unselection, and background
  lease visibility checks so shared tabs do not emit spurious `blur` events,
  claimed temporary tabs to prevent leaked `about:blank` fallback routing, and
  rechecked focus after transient X11 events when restoring task popup focus or
  routing an external link (#731, #732).
- Accepted hyphen-prefixed base64url local `device_id` values (`Bytes<16>`) in
  `bsk daemon revoke`, `bsk daemon rotate`, and `bsk daemon pair --replace`
  without requiring `--`, while still rejecting malformed hyphenated flags at
  CLI parse time (#732).
- Failed closed with `invalid_params` when cooperation action metadata
  (`context_id`, `depends_on`, `observation_id`, `expect`) is supplied to
  unguarded CLI or MCP commands while stripping auxiliary follow-up RPCs inside
  multi-phase commands (`open`, `step`, `upload`, `download`, and
  `screenshot --full-page`), and re-verified `--expect` business conditions in
  `CooperationController` (`prepare` — including `primaryEffect` hover/focus
  steps — and `beginDomMutation` before marking `nativeInputStarted`) under
  `target` policy so last-moment DOM mutations fail closed before the committing
  press or scripted mutation (#731, #732).
- VOM tree folding (`shouldSkipRedundantRefChildren` and `renderTreeRows`) preserves
  independent interactive descendants under named interactive controls (such as Vue 3 +
  Element Plus nested `<el-sub-menu>` popups inside a parent `menuitem` or custom ARIA
  combobox popups) so each expanded, actionable child item renders on its own row with a
  distinct `@eN` reference across `bsk sync`, `observe`, and `snapshot`, while keeping
  passive inner wrappers, inherited `cursor: pointer` / click-skin descendants, and native
  `<input>` / `<textarea>` / `<select>` controls folded without duplicate refs; added
  required pre-release audit scenario `EDGE-NESTED-MENU-REFS`.
- Structured list extraction (`extract list`) collects slot-assigned items and default
  item links (`url`) across open Shadow DOM `<slot>` projections while preserving rendered
  slot order, closed-`<details>` hidden row positions, nested-list item and link ownership,
  visibility checks, and collection limits ([#588](https://github.com/Tencent/BrowserSkill/issues/588),
  [#612](https://github.com/Tencent/BrowserSkill/pull/612)); added required pre-release
  audit scenario `EDGE-SLOTTED-LIST-EXTRACT`.
- Structured extraction (`extract table`, `extract list`, and `extract discover`) applies
  computed CSS `text-transform` (`uppercase` and `lowercase`) and rendered locale casing
  rules to visible non-sensitive `<input>` and `<textarea>` values while preserving browser
  UA `text-transform: none` defaults and byte-budget accounting (follow-up to
  [#613](https://github.com/Tencent/BrowserSkill/pull/613)).

### Removed

- Removed upper-layer imports of `browser-driver/frame-graph` (`CdpTarget`, `CdpFrame`, `CdpFrameGraph`, `sendToTarget`, `sendGuarded`, `sendAttached`, and `getFrameGraph`), optional `?` mock-accommodating methods on `CdpRunner`, module-global `downloadActive` state, the `isAgentWindowId: () => false` fallback default in `returnBorrowedTab`, hardcoded Chinese benchmark heading filters from `@browser-skill/vom`, and regex line re-parsing / duplicated `DERIVED_NAME_CAP` in `cooperation/text-delta.ts`.
- Removed dead write-only `apps/extension/src/lib/sessions-live-flag.ts` (`bh.sessions_live` / `SESSIONS_LIVE_FLAG_KEY`) and ineffective Isolated World `history.pushState` / `history.replaceState` monkey-patching in `apps/extension/src/content/record-capture.ts`.
- Removed `reattachIfSoftDetached`, `reconcileSoftDetachedFrames`, and `resolveTarget` compensation hooks from `CdpRunner`, `RefStore.remapChildFrameSessions`, partial hand-written `CdpRunner` wrapper object literals (replaced with full `delegateCdpRunner` delegation), and isolated default `new ChromiumCdp()` fallback instances outside `background.ts`.
- Removed deprecated `TraceV2` recording types/converters (retaining `TraceV3` only), all 9 legacy `1.x` `Feature::*` compatibility gates, extension/daemon `"1.6"`/`LEGACY_MIN_COMPATIBLE_PEER` shims, duplicate `DragParams.observation_id` / legacy drag modes, and duplicate `wire_*` runtime validators from generated TypeScript artifacts.
- Removed the legacy bespoke `bsk_*` tool wrapper, duplicated session start journal,
  forked DSH-only skill markdown, and Web UI thumbnail-polling React overlay from
  `packages/dsh-plugin-browserskill` (along with `@deepseek-ai/dsh-*` host `rc` peer
  locks and DSH-specific test shims); DeepSeek Harness now uses the standard `bsk` CLI
  and `bsk mcp` server, with in-flight MCP cancellation, cooperation settlement, CLI
  video export, and dynamic-reading browser regressions migrated to `bsk` CLI and
  `bsk mcp` (#731, #732).

## [0.5.0] - 2026-11-12

### Added

- Daemon-local `<3ms` Intent Write-Ahead Ledger (`$BSK_HOME/intent_ledger.jsonl`, `0600`)
  and `bsk ledger status | resolve`: intercepts all mutating tools (`click`, `fill`,
  `press`, `select`, `upload`, `drag`, `evaluate`) regardless of `--ref`, raw CSS
  `--selector`, or visual `(image_x, image_y)` targeting while persisting only redacted
  target summaries (never plaintext `fill` values or `evaluate` scripts). Transitions
  timed-out, cancelled, disconnected, or `effect_state: "unknown"` actions (plus leftover
  `DISPATCHED` entries across daemon restarts) to `UNKNOWN`, blocking blind mutating
  replays on that tab in `<1ms` (`uncertain_prior_effect`) while allowing 100% of
  read-only/diagnostic commands and auto-reconciling on `bsk sync`.
- Zero-ceremony lifecycle commands (`bsk open`, `bsk sync`, `bsk close`) and a
  daemon-memory `ImplicitScopeRegistry` with deterministic `caller_scope` isolation
  (`--session` > `--scope` / `BSK_SESSION` / `BSK_SCOPE` > per-process MCP stdio
  `conn_scope` > host subagent IDs > anti-silent-hijack `"default"`), monotonic short
  evidence aliases (`c1..cN`, `o1..oN`), omitted `--session` / target-policy
  `--context` resolution, and `unchanged` VOM hydration without altering extension-side
  cooperative safety verification.
- Affordance-typed VOM rendering and `<select>` label selection: bare input controls bind
  preceding static captions as `[field: "..."]` without duplicating consumed labels; CJK
  parent-child text deduplication requires exact equality; non-sensitive native `<select>`
  elements inline up to 10 options (`[options: val="Label"* | ...]`), while `select`
  accepts unique visible option labels, rejects ambiguous duplicate labels
  (`option_ambiguous`), lists up to 12 available candidates on `option_not_found`, and
  guides callers to click custom ARIA comboboxes (`[custom-dropdown: ...]`); runs of 3 or
  more consecutive pure read-only table rows fold into compact pipe-delimited rows.
- Computed-style stealth prompt-injection stripping and zero-extra-RPC virtual-scroll row
  business-key guards: observation and hover probes strip non-interactive subtrees hidden
  via `opacity < 0.05`, `font-size <= 1.5px`, zero foreground/background contrast,
  far-offscreen layout bounds, or `< 2px` clipped boxes (preserving interactive controls,
  `.sr-only` accessible button labels, `<label for>` and `aria-labelledby`/`aria-describedby`
  targets); `@eN` refs inside table, list, or virtual rows record a normalized `rowAnchor`
  and verify it atomically in `checkActionTarget`'s single `SAMPLE_TARGET` probe, blocking
  in-place recycled DOM slots before dispatch (`virtual_row_recycled`, `effect_state: none`).
- Qoder and Qoder CN are available as skill-only install targets through
  `bsk install-skill --harness qoder` and `--harness qoder-cn`.
- Local pairing with mutual proofs, durable key rotation and interruption recovery.
  Paired connections verify the daemon before sending business traffic; activation
  invalidates the original link. Device revocation and browser registration are
  serialized, and successful revocation completes live connection cleanup.
- `bsk daemon pair --replace`, local device listing/revocation, `daemon rotate`
  and `daemon trust-local on|off`; status and doctor expose pairing guidance.
- Extension pairing settings, staged verification, ten-language guidance,
  explicit bypass confirmation and retained remote grants when using local mode.
  Pairing is optional for new installs and upgrades; unpaired connections remain
  usable with an identity warning and a link to the official security overview.
  Paired connections and saved recovery candidates never automatically downgrade.
- `bsk daemon pair` reuses or starts the daemon before returning a usable link.
  Explicit Required mode remains available; unverified connections cannot claim
  an existing paired identity under the default policy.

- The in-page control panel can minimize to a right-edge expand arrow. Its display
  state is retained for the current task across status updates and navigation.
- `bsk plan` and the MCP tool `bsk_plan` run several already-decided actions in one
  call, then return the synchronized state, so a form or a set of filters takes one
  model turn instead of one per action. Each step keeps the checks of its own command,
  and the first step that does not complete stops the plan without any retry.
- The DSH plugin runs decided actions together with `bsk_interact(action=plan)`, with the
  same checks, stopping rule and receipt as `bsk plan`.
- The DSH plugin offers `bsk_recipe` when its `recipes` option or `BSK_RECIPES=1` is set.
  A run uses an owned session, keeps the receipt of a run that did not complete, and has
  no approve action.
- `bsk recipe` saves a verified flow as a local file and replays it, returning its
  outputs without a model turn per step; MCP lists `bsk_recipe` with `BSK_RECIPES=1`.
  Targets match exactly by role, name and context, and a run stops at the first deviation
  and hands the page back. This version replays only read and reversible steps: a lowered
  risk runs only after a person approves it with `bsk recipe approve`, and an uncertain run
  holds its recipe until the caller checks it. See `docs/recipes.md`.
- `bsk read`, MCP and DSH `bsk_inspect(action=read)` sample bounded DOM fields
  through fixed synchronous isolated-world queries. Agents can read current title,
  URLs, text, attributes and control state across unrelated animation, then act
  with explicit business conditions. No caller JavaScript, callbacks or delayed
  effects are accepted; sensitive fields are masked.
- DOM reads negotiate protocol 1.9 and reject older peers explicitly, without
  script fallback. Visual/untargeted input retains strict guards.
- `bsk evaluate --unverified` (MCP `params.unverified`, DSH `unverified`) runs a script
  without comparing the page with any observation, for pages that never hold still and
  scripts whose dependencies cannot be stated. Control authority, main-document identity
  and tab ownership are still enforced; it cannot be combined with `--expect`,
  `--observation` or `--depends-on`, and its result carries `verified: false`. It needs
  protocol 1.9 on the daemon and extension; peers below 1.9 are rejected before dispatch.
  Earlier 1.9 development builds require updating the CLI, daemon and extension together.

### Changed

- Accelerated single-step interaction hot paths by ~85%: under `target` cooperation
  policy, internal non-input CDP steps (`Runtime.callFunctionOn`, `DOM.focus`,
  `DOM.scrollIntoViewIfNeeded`, `Emulation.*`, `DOM.getBoxModel`) run against a zero-RPC
  in-memory push-interruption fence after a single entry `verifyDecision()` (preserving
  real-time `isTrusted` human takeover cancellation and strict-policy semantics), merged
  duplicate `beforeinput` cross-frame refreshes, and made `finishInput` cleanup
  non-blocking on untouched Agent Window tabs; compressed `handleFill` to a 3–4 step CDP
  fast path that retires hard `fill_value_mismatch` errors on auto-formatted inputs and
  returns `actual_value` / `formatted` on non-sensitive fields; switched business CLI
  commands to optimistic single-UDS direct connection via `daemon.json` with zero-replay
  connect-failure auto-spawn fallback.
- Rewrote the CLI `SKILL.md` into a zero-preread workflow (`<= 2,000` UTF-8 bytes)
  preserving all four cooperative safety invariants, removed repeated static `guidance`
  prose from `cooperate sync` replies, and added 75-second four-guard idle
  `chrome.debugger` soft-detach (preserving `tabOwners`, console/network `since`
  cursors, unchanged `@vN` and cross-origin OOPIF `@eN` refs, pending JavaScript
  dialogs, and active download/upload/navigation/screencast attachment leases across
  transparent reattach) alongside immediate 0ms detach on `bsk close` and
  `bsk tab return`.
- Cooperative synchronization and strict pre-action verification reuse a sliding
  10-second `Accessibility` domain lease per tab, skip unused VOM text rendering on
  scene-only evidence and delta captures, stream unrelaxed whole-page evidence
  comparison without per-node serialization, and reduce semantic-graph and VOM
  allocations on large pages.
- The extension popup always shows Connection settings instead of hiding them behind
  a disclosure. The optional-pairing advice collapses to a warning-triangle icon beside
  the heading and expands on click; skipped verification and states that block the
  connection stay visible. The current address sits under the selected mode, the
  pairing steps move behind an info icon, "Use a new pairing link" is a button, and the
  save notice appears only once there is a valid change to save.
- `bsk plan` and `bsk recipe` are documented standard CLI workflows, with packaged
  guidance for batching and replay; recipe schemas remain opt-in in MCP and DSH.
- Recipe execution and edits share an exclusive lock. Replay refuses unreadable
  safety state or an unwritable run marker, and retains interrupted-run holds even
  when the host process remains alive. DSH drains cancelled plan and recipe receipts.

- The extension removes obsolete migration flags and version gates while keeping
  pairing optional. There is no automatic enforcement deadline.
- `bsk-protocol` is the single source of truth for method metadata, JSON schemas,
  TypeScript request/result codecs, exhaustive daemon/extension execution policies,
  and protocol 1.2–1.9 peer feature compatibility checks (`pnpm protocol:check`).

### Fixed

- Stopping a recording coordinates cleanup of the recording session and preserves
  the captured steps if cleanup needs to be retried ([#720](https://github.com/Tencent/BrowserSkill/pull/720)).
- The DSH skill and plugin documentation explain how to call BrowserSkill tools
  through `run_code` in PTC mode ([#721](https://github.com/Tencent/BrowserSkill/pull/721)).
- Idle debugger detach preserves element references across reattach and waits for
  open dialogs and active downloads to finish ([#711](https://github.com/Tencent/BrowserSkill/pull/711)).
- A target-policy `cooperate sync` no longer re-sends the whole VOM when the only page
  activity since the last observation replaced visible text in place. The content script
  logs text-only mutation batches separately from structural ones, and the extension
  answers `kind: "delta"` with `observation_patch.lines`, `kind: "text"` entries in
  `changes` (previous value, value, touched VOM lines) and `previous_observation_id`.
  With `--baseline` on the exact predecessor the CLI applies the patch, saves the merged
  observation through `--save-full` and keeps the page text out of stdout; `view` reads
  the merged version with zero browser calls. On the 6,857-node `ARENA-MEGA-VOM-DELTA`
  fixture the third sync went from about 2.2 s and 574 KB to about 0.2 s and 2 KB, and
  the merged text equals a fresh capture. Structural changes, replaced documents or
  refs, human activity, field changes, focus moves under focus-dependent styles, log
  gaps, text outside or ambiguous in the held observation, child frames and token-budget
  shifts still return a fresh `baseline`, now with a `baseline_reason`. Strict-policy
  behaviour and the target and observation guards are unchanged
  ([#722](https://github.com/Tencent/BrowserSkill/pull/722)).
- Hardened VOM stealth prompt-injection stripping against CSS Color 4/5, gradient-clip
  text, HiDPI microboxes, inner scroll containers, and mixed textstyle containers:
  resolves `oklch`/`oklab`/`lab`/`lch`/`hsl`/`hwb`/`color()`/`color-mix()` to sRGB for
  accurate cross-space zero-contrast and zero-alpha detection (including Tailwind v4
  `oklch()` backdrops and `currentColor 0%` mixes); preserves genuine
  `background-clip: text` / `-webkit-background-clip: text` gradient headings while
  stripping transparent, zero-span, or background-matching gradient stops; scales `1px`
  microbox and offscreen bounds on HiDPI/Retina displays; verifies inner
  `overflow: auto | scroll` scroll offsets (`scrollRects`) and `#text` glyph bounds so
  legitimate scrolled rows remain intact while unscrolled `left: -99999px` / `-2000px` /
  `text-indent: -9999px` injections are stripped; and clears direct stealth text and
  tainted AX `name`s on retained containers ([#709](https://github.com/Tencent/BrowserSkill/pull/709)).
- `wait-for-navigation` no longer returns on the old page when the navigation it waits
  for is scheduled or still in flight. A settled page counts as reached only after a
  short grace period without a main-frame navigation start; once a navigation starts
  or Chrome reports one as pending, only the successor document can satisfy the wait.
  Same-document and back/forward-cache restores still complete immediately
  ([#700](https://github.com/Tencent/BrowserSkill/issues/700)).
- VOM snapshot decoding and semantic DOM text resolution exclude `<style>`, `<script>`,
  `<noscript>`, and `<template>` subtrees (alongside HTML comment nodes) when collecting
  fallback element text, preventing controls without an accessible name from leaking raw
  CSS, script, or template markup as their label
  ([#694](https://github.com/Tencent/BrowserSkill/issues/694)).
- Native clicks, key presses and wheel input calibrate Chromium's input clock so
  long-running browsers do not misclassify their own input as human intervention
  after sleep or clock changes. Calibration uses the extension's hidden document,
  preserves the existing input checks, and reports clock failures before dispatch
  ([#665](https://github.com/Tencent/BrowserSkill/issues/665)).
- `tool.record_start` enforces shared-tab cooperation ownership, stop, and human-control
  guards and invalidates stale control contexts when starting recording; `tool.tab_return`
  clears active recordings for local sessions as well as remote ones.
- `navigate back` and `navigate forward` no longer time out when Chrome restores
  the history entry from the back/forward cache. A restored document is already
  loaded and emits no new load lifecycle event, so the restore commit now
  satisfies `domcontentloaded` and `load`, and re-enables lifecycle replay on the
  restored document so `networkidle` also completes on previously idle pages
  ([#701](https://github.com/Tencent/BrowserSkill/issues/701)).
- Daemon shutdown retains its WebSocket stop notification when the accept loop is
  between waits, avoiding a lost notification that can leave `daemon stop` waiting.
- Website debugging attributes agent uploads and downloads to their transfer
  operations instead of recording the resulting file changes and clicks as human input.
- The Intent WAL no longer freezes a tab after actions that provably never took
  effect. A click refused after only scrolling (`effect_state: "unknown"` with
  `press_sent: false`) and any failure reporting `dispatched: false` now settle.
  `select` checks the requested options before scrolling or focusing the element,
  and `fill` validates the value before clearing; rejections found there
  (`option_not_found`, `option_ambiguous`, disabled `<select>`, `fill_value_invalid`,
  `target_not_fillable`) report `effect_state: "none"` with `phase: "precondition"`,
  so a corrected retry neither needs `bsk ledger resolve` nor loses the
  shared-control context. The same reasons reported later, after `select` moved
  focus or after `fill` cleared the field, keep an unknown effect. A `<select>` that is already disabled is now
  reported as `invalid_params` instead of a `cdp_failed` focus error
  ([#702](https://github.com/Tencent/BrowserSkill/issues/702)).
- Local validation failures in upload, download, plan and step return stable
  parameter/file error codes and relevant recovery hints. Upload sources are checked
  before contacting the daemon or staging any files.
- `bsk get-html --json --out <file>` no longer prints the HTML to stdout. With
  `--out`, JSON output reports `tab_id`, `path`, `written_bytes`, `byte_size`,
  `truncated` and any dialogs, so large pages stay out of the caller's context;
  without `--out`, the JSON result still includes `html`
  ([#715](https://github.com/Tencent/BrowserSkill/issues/715)).
- `fill` on a page without focus (a background tab, or the agent window while
  another window is focused) delivers focus before validating and clearing the
  field, so focus listeners that set a default value no longer leave it in front of
  the typed text or restore it when the tab is activated. A visible page receives
  focus from a pointer move outside the viewport, which reaches no element; a hidden
  or hovered page keeps the previous no-op key press, which pages can observe as an
  empty key. Truncated or reformatted password, card and one-time-code fills report
  `formatted: true` (also in the human CLI output) without `actual_value`, and text
  inputs named like passwords, as left by a "show password" toggle, are treated as
  sensitive ([#713](https://github.com/Tencent/BrowserSkill/issues/713)).
- `fill` notifies each final value once. Native insertion and clearing already
  dispatch `input`; the completion step no longer repeats it
  ([#624](https://github.com/Tencent/BrowserSkill/issues/624)).
- Borrowing a user tab that still shows `about:blank` or the browser's empty New
  Tab page (`chrome://newtab/`, `edge://newtab/`, `about:newtab`, including
  query/fragment variants) no longer deadlocks tab management or initial
  navigation in the session. Empty initial/new-tab root pages without a
  collector are skipped during tab-management preparation and may perform an
  initial bootstrap navigation, and `tab return` can also hand back a borrowed
  tab stuck on a browser-restricted page or failed root load without tearing
  down the session. Observable `about:blank` popups, other unobservable web
  pages, and subframes are still refused without synchronization
  ([#703](https://github.com/Tencent/BrowserSkill/issues/703)).
- Window blur releases completed text-editing holds, and new task synchronizations
  after an idle gap automatically resume paused or editing tabs when no gesture or
  recent input is active, avoiding unnecessary manual hand-back prompts between tasks.
- `bsk sync` and `bsk open` evaluate `--wait-for` and `--wait-not` against the full
  page. A strict-policy `delta` frame or an `unchanged` frame without a cached page
  is read once with `tool.snapshot` instead of matching only its `[change ...]` lines
  or empty text, and a page cut by `--max-tokens` is read in full before `--wait-not`
  accepts that text is gone. A wait that returns after several polls also reports
  the field changes, activity and `history_complete=false` of the frames it did not
  return. A failed page read keeps the wait polling instead of ending it
  ([#714](https://github.com/Tencent/BrowserSkill/issues/714)).
- Recording keeps clicks on buttons and links whose name is longer than 48 characters,
  such as GOV.UK step-by-step sections and long news headlines.
- Recording keeps clicks on links, filter disclosures, checkboxes and other controls
  that share a form with a search field, such as GOV.UK search results and filters.
- Recorded steps keep their element ref after the page scrolls or the target changes size:
  when no position matches, the only same-tag ref with the same role and name is used.
  A click on text inside a `<summary>`, tab or option is measured on that control.
- Recipe save refuses oversized input and formatted documents before publishing a
  revision that its own reader could not open.
- `press` maps US-layout punctuation to its physical `code` and virtual key code,
  so shortcuts such as `Ctrl+/` reach handlers that check `event.code`.
- Main-document SPA route changes, including away-and-back and hash routes,
  invalidate old control contexts and refs. Supplementary reads never renew them.
  This also covers passive reads of already loaded tabs and fresh debugger attachments.
- Context-bound reads preserve frame-collection diagnostics and report failures before
  dispatch with `effect_state: none`. Missing root or child document elements report
  `read_target_stale` instead of a generic CDP failure.
- CLI, MCP, DSH and bundled skills direct dynamic-page data gathering to read/extract
  instead of repeated sync/evaluate refusals.
- A script that states what it relies on is checked against that instead of the whole
  page, so unrelated clocks, feeds and media no longer refuse it in a loop. Under target
  policy, `evaluate` with `--expect` and no `--observation` reuses its context and is not
  refused when a child frame navigates; passing `--observation` as well still checks the
  whole page. Under strict policy, `evaluate` with
  `--depends-on` checks those regions, form values and modal layers only; it previously
  also required the whole page to match. A script that states nothing is checked as before.
- A refusal caused by a changed observation also reports `observed_changes`: the number
  of changed, added and removed nodes with up to five examples. For scripts, the recovery
  text and the bundled skills give the order to try: state the facts, and use
  `--unverified` only when they cannot be stated.
- Control-state sampling recollects once after the browser proves that a failed child document retired; an active unobservable frame still blocks input.
- A frame that does not answer collection in time is named in the error message and
  `data.frames` (frame ID with the sanitized origin and path; tab operations add the tab).
  The refusal remains `cooperation_sync_required`, so `--settle`, recipes and DSH still
  retry it, and its recovery explains how to leave a frame that keeps failing
  ([#614](https://github.com/Tencent/BrowserSkill/issues/614)).
- A child frame that cannot be collected while its element is not displayed, has no area
  or is invisible, and does not hold focus, is listed in `frame_gaps` as `hidden_frame`
  instead of blocking the tab, as with micro-frontend sandbox iframes. Later collections
  recheck the element instead of waiting for the frame again, and a displayed frame still
  blocks input ([#614](https://github.com/Tencent/BrowserSkill/issues/614)).
- Removed nodes already collected by CDP report target_detached with node identity, consistently with detached nodes that remain inspectable; other CDP failures remain target_unavailable.
- Recording captures option changes on native `<select>` controls inside open shadow roots,
  whose `change` events do not reach the document.
- Strict DOM-targeted actions tolerate added or removed noninteractive tooltips after their
  own hover, and character counters tied to a focused text field by `maxlength` or
  `aria-describedby` after their own focus. Target meaning, links, ordinary text, form state,
  modal contents and explicit dependencies stay exact. Scripts, untargeted keys and visual
  clicks retain the full observation check, including during preparation
  ([#540](https://github.com/Tencent/BrowserSkill/issues/540)).
- A targeted strict action without `--depends-on` tolerates a positively identified media
  timeline elsewhere on the page, as it already did with dependencies. Unnamed, submitted and
  in-form sliders, and untargeted actions, stay exact.
- Evidence refusals report `observed_change` (the first differing node, field and check, and
  whether it happened before or during preparation) without values or sensitive text. Strict
  click refusals after preparation also report `press_sent: false`.
- A request refused because an earlier command on the session is still settling (for
  example a cancelled observation screenshot) now carries `reason: operation_settling`,
  `retryable` and `retry_after_ms`. `cooperate sync --settle` pauses and syncs again
  (up to 5 s, also for older extensions), and the CLI no longer suggests a reload that needs
  the same sync ([#527](https://github.com/Tencent/BrowserSkill/issues/527)).
- `upload` preserves its concrete handler failure receipts (`set_file_input_failed` and
  `file_drop_failed`, such as `-32000 Not allowed` when Chrome's "Allow access to file URLs"
  extension toggle is off) when transaction cleanup detaches the debugger or post-action
  frame collection fails, instead of masking them as `control_context_invalid`. Pre-drop
  `dragEnter` refusals also keep `effect_state: none` without dispatching a redundant
  `dragCancel` ([#636](https://github.com/Tencent/BrowserSkill/issues/636)).
- Recording preserves clicks on submit, reset and image input buttons, including
  actions beside search fields, and uses reset buttons' visible values as names.

- Cooperative status updates preserve an active click-passthrough lease, so the
  control panel and its minimized arrow do not swallow automated page clicks.
- Recording keeps clicks on buttons and links inside an editor's `contenteditable="false"`
  regions, such as attachment actions, instead of treating them as editor input.

- `extract` applies CSS `uppercase` and `lowercase` to text in table cells,
  headers, list fields and discovery previews, respecting nested style overrides
  and language-specific casing. Transformed text remains subject to the byte
  budget ([#597](https://github.com/Tencent/BrowserSkill/issues/597)).
- Closing a retained Agent Window or stopping the last session detaches remaining
  CDP debugger attachments and cancels active session operations, so the browser's
  debugging infobar does not linger after the task window is closed.

## [0.4.2] - 2026-11-05

### Added

- Session controller labels show an agent name, project, session ID and color in
  browser overlays. CLI and DSH session startup accept the display metadata.
- Fill supports date, time, datetime-local, month and week inputs, validates
  formats and min/max limits, and preserves background input state.
- `bsk mcp` lets MCP clients control BrowserSkill over stdio using the existing
  daemon and browser extension. `bsk install-skill --mcp` can configure Codex,
  Claude Code, and Cursor.

### Changed

- Borrowed tabs return relative to their original neighbors, with improved pinned
  tab and group restoration. Eligible requests support automatic borrowing when
  borrow confirmation is disabled.
- The extension restores the `tabGroups` permission to read and restore borrowed
  tabs' original groups.
- Shared control waits for two seconds of quiet after the person's last completed
  action before returning control to the Agent, up from 650 ms.
- CLI and daemon updates prefer the official website's domestic download source,
  falling back to GitHub for failed manifest or archive requests and verification.
  Archive fallback stays on the selected version with SHA256 verification; if both
  sources fail, the error includes each URL and cause. Explicit manifest overrides
  continue to use only the configured source.

### Fixed

- Element waits requery selectors when matched nodes are replaced, avoiding false
  hidden/detached success while a replacement remains visible.
- Console capture is enabled only when requested, avoiding repeated reloads on
  affected anti-debugging pages while preserving capture diagnostics.
- Debug evidence redacts exact vendor credential headers.
- DSH fill/select values beginning with `-` are passed as option values rather
  than being parsed as CLI flags.
- The shared-control toolbar yields pointer hits during automated clicks,
  including page actions beneath its lower-right corner. Its controls become
  interactive again when the click finishes or its passthrough lease expires.
- Enter dispatches keydown and text together, preserving a completed link or
  form navigation receipt without sending a separate character to a new page.
  The next action still requires a fresh control context after navigation.
- Timed-out page actions cancel and await bounded cleanup. Error responses retain
  execution phase, effect state and operation identity; missing receipts remain
  explicitly uncertain. CLI and MCP timeout guidance asks callers to inspect the
  application result before choosing another action instead of blindly retrying.
- Repeated action labels use their own DOM container's text for context, including
  labels after the button, so adjacent records no longer misidentify their target.
- CLI cancellation keeps the original RPC progressing and retries cancellation
  that arrives before daemon registration, reducing background screenshots that
  keep a session busy after the caller stops. Confirmation and response waiting
  share a two-second budget, including MCP cancellation; transfer cleanup keeps
  its separate bounded budget. Requests registered after that deadline still
  require daemon-side cancellation tracking
  ([#419](https://github.com/Tencent/BrowserSkill/pull/419)).
- Saved HTML debug captures redact sensitive input values when `autocomplete`
  contains surrounding whitespace or multiple tokens, such as
  `section-login one-time-code` or `section-checkout billing cc-number`.
  Non-sensitive token lists such as `section-login email` remain unchanged
  ([#566](https://github.com/Tencent/BrowserSkill/pull/566)).
- Pages that handle the legacy `mousewheel` event, such as Bilibili's player volume,
  receive wheel input again. The extension listened for `wheel` on every page even
  without a shared-control session, which made Chromium skip those handlers; it now
  listens only while collecting, on `window`.
- Commands no longer wait until their timeout when truncated page text cuts an
  emoji in half, for example `bsk console --max-text-chars 4` on `Hi 🚀 there`.
  The lone surrogate left by the cut made the daemon drop the extension's whole
  reply; the extension now sends it as `U+FFFD`.
- Shared control keeps running during scrolling and ineffective key presses. Completed
  page clicks, keyboard activation and actual field edits yield to the person. Pending
  gestures wait at dispatch without revoking control, and coordinate input waits for
  scrolling to settle. Focusing a text field alone no longer holds editing control.

- With target control, a carousel, video embed or ad refreshing an iframe no
  longer revokes actions whose targets and preconditions are all in the main
  document. Actions involving iframe refs or a strict observation require a
  fresh sync when the frame documents change.
- Values in one-time-code, card and password fields marked by `autocomplete`
  (`one-time-code`, `cc-*`, `current-password`, `new-password`), which observations
  already hide, are also kept out of shared-control field state, `expect` failure
  details, structured extraction and recorded fill steps. Every check matches each
  `autocomplete` token, so `section-login current-password` or `billing cc-number`
  values stay hidden too. Password fields that a "show password" toggle switches to
  `type=text` also stay masked across shared-control field state and recorded steps
  and state observations.
- On Windows, pairing, rotating or revoking a remote browser no longer fails with
  `replace authorization snapshot: Access is denied` when another request is
  reading the authorization store at the same moment.
- Window resize verifies the browser's resulting bounds and the target tab's
  layout viewport. It reports constrained bounds, inactive tabs and viewports
  that did not follow the resize instead of echoing the requested size as success.
  A dispatched resize also forces the next shared-control sync to recapture the
  page, even when no DOM mutation recorded the layout change.
- Shared-control synchronization skips failed child frames and inactive documents,
  reporting them in `frame_gaps` with only HTTP(S) origins and paths or other URL schemes,
  and repairs missing interaction collectors immediately once per current
  document. Active frames without coverage still block actions with
  `frame_unobservable`; a failed main page reports `page_load_failed`.
- `cooperate sync --settle` continues bounded retries when a wait reports unavailable
  coverage, returning the last sync error if all attempts fail instead of a
  successful `not_ready` reply or an invented permanent frame failure. Temporary
  human control retains the existing `not_ready` behavior, including explicit
  holds during navigation. Status and wait report
  `control_policy: null` until the first successful policy negotiation.
- Shared control: the `observation_required` recovery, the target-policy sync
  guidance and the skill references now say to pass the sync reply's top-level
  `observation_id`. The reply also carries `observation.observation_id` for its
  ref map, and passing that one was refused with a hint that did not say which
  of the two ids to use.

## [0.4.1] - 2026-11-02

### Changed

- **Shared-control default:** new CLI and DSH sync calls select `target` policy.
  DOM actions can reuse the returned control context across completed actions
  and supplementary reads; unrelated page updates no longer require a full-page
  resync. Human intervention or navigation revokes control. Use `--expect` / DSH
  `expect` to protect observed business facts. Scripts, untargeted keys and visual
  actions still require the sync's `--observation` / `observationId` and strict
  observation checks. Select `--policy strict` / `policy: "strict"` on the first
  sync to retain the one-action-per-context workflow; later syncs and steps
  preserve that session's policy.
- CLI/daemon and extension now use protocol 1.8. The new target policy requires
  both peers to support 1.8; update the CLI, running daemon, extension and DSH
  plugin together rather than relying on a successful mixed-version connection.
- DOM references remain attached to the same nodes across supplementary
  observations. Removed nodes are not silently replaced, and navigation
  invalidates the document's refs. DOM actions can wait for an existing target
  to become ready within their timeout without replaying input.

### Fixed

- Interaction capture initializes on ordinary HTTP intranet pages and their
  child frames when `crypto.randomUUID()` is unavailable. A compatible UUID
  fallback restores the frame coverage needed for shared control.
- Shared-control synchronization waits for cancelled observation thumbnails to
  settle. Viewport capture reads have a 10-second deadline with separate bounded
  cleanup; reaching that deadline returns `timeout` (exit 4) with screenshot-specific
  guidance. Browser/CDP capture failures remain `cdp_failed` (exit 3).
- Completed inputs retain their successful receipts when they navigate, including
  clicks, Enter submissions, drag submissions, and forms submitted after filling
  or selecting a value. After navigation, synchronize before the next action.
- CLI cancellation is armed before sending a browser command, so an immediate
  Ctrl-C can cancel the operation and return its outcome instead of terminating silently.
- Pointer hit tests stay within the target's document, and human input during
  frame changes continues to revoke control without discarding completed actions.
- Windows daemon startup errors distinguish verified Job Object restrictions,
  unverified breakaway failures, executable access failures, partial breakaway
  and resume failures, with recovery guidance for the actual failure stage.
- DSH-injected messages use native durable-format v4 plugin sources while
  retaining the legacy source shape for older formats.

### Removed

- Automatic native Agent Window tab groups and the `tabGroups` permission, to
  prevent new `BrowserSkill` groups from accumulating across browsers through
  Chrome sync. Existing saved groups are not deleted; page control indicators,
  background window behavior and user-tab routing remain available.

### Upgrade

1. Finish active tasks, install CLI 0.4.1 and restart the running daemon.
2. Install extension 0.4.1 before upgrading the DSH plugin to 0.4.1. Store review
   can delay availability; verify the installed extension, not just its submission.
3. Restart the DSH profile and invoke `/browser-skill` again, or start a new CLI
   agent conversation to load the updated skill. Custom tool integrations need
   the new observation and expectation fields for target-policy actions.
4. Check `bsk --version`, `bsk status` and `bsk doctor`; the running daemon and
   extension should both report protocol 1.8.

## [0.4.0] - 2026-10-30

### Changed

- **Breaking — extension compatibility:** the extension now requires daemon
  protocol 1.6 or later; CLI/daemon 0.3.3 uses protocol 1.3 and cannot connect.
  Update the CLI and restart the running daemon before updating the extension,
  then update the DSH plugin. CLI/daemon and extension 0.4.0 use protocol 1.7.
- **Breaking — shared browser control:** new sessions and their task tabs enable
  human/agent collaboration automatically. After initial navigation, synchronize
  with `bsk cooperate sync` and pass its single-use `--context` to each action;
  DSH uses `bsk_session action:sync` and `contextId`. Human input or changed page
  evidence can revoke a pending action; synchronize and reconsider the result
  instead of replaying it. Reload the updated skill in existing conversations.
- Moving any controlled tab out of its original Agent Window ends the whole
  session, preserves pages in place and removes control indicators. Moving the
  tab back does not restart the task. Normal session stop preserves pages with
  human participation and cleans up untouched task-created pages.
- macOS CLI releases require Developer ID signing and Apple notarization for
  both architectures, alongside the existing Windows EV signature checks.
  `Publish CLI` verifies both platforms before publishing the complete release;
  archive names and installation commands remain unchanged.
- English and Chinese privacy policies cover shared-control observations,
  explicitly saved observation files, incognito tasks and `tabGroups`. Upgrade
  and publishing instructions use CLI-first rollout for this compatibility change.

### Added

- Human/agent collaboration with visible control indicators, manual hold and
  resume, bounded activity evidence, page-change guards and explicit decision
  regions. Native JavaScript dialogs participate in control and recovery.
- Native drag interactions, including cross-origin frame targets, and a
  click–move–click mode for selecting ranges. CLI and DSH expose the new actions.
- `bsk step` executes one chosen action, optionally waits for an element and then
  synchronizes, preserving the action receipt if a later stage fails. Explicit
  observation saving, baseline reuse and `bsk view` let agents read and search
  historical evidence locally without another browser call. DSH exposes these
  through `step`, `view`, `saveFull` and baseline options.
- Incognito Agent Windows through `session start --incognito`, with explicit
  browser incognito permission and no borrowing of ordinary tabs. Incognito
  windows in one profile share their incognito login state.
- Orange BrowserSkill tab groups mark controlled Agent Window tabs using the
  new `tabGroups` permission; grouping is removed when the task ends.

### Fixed

- Browser interactions retain current element references for dynamic menus,
  dispatch shadow-DOM input events correctly, handle plus-key chords, and reject
  select controls that become disabled during focus. Extraction respects
  `content-visibility`, and observation token estimates and evidence scope are
  more consistent.
- Website debugging preserves failed request-body metadata and primitive console
  exceptions. Video capture respects human control, and playback regressions wait
  for decoded frames before checking colors.
- Windows DSH child-process cancellation preserves its termination grace period;
  remote authorization handles a busy store, and WebSocket connection limits
  bound incoming peers. Foreground daemon consoles remain visible.
- Browser evaluation scaffolding handles Windows cross-drive paths, relative
  import URLs and long run IDs; child output preserves UTF-8. Extension types are
  prepared during dependency installation.
- Extension: explain when the running bsk daemon is too old to connect, with
  its version, a copyable update command and restart guidance in the popup.
  A toolbar warning and a notification make the problem visible before opening
  the popup; repeated reconnects do not repeat the notification.
- CLI: argument parsing failures now honor `--json`, returning an
  `invalid_params` error on stdout with `data.reason: "cli_parse_error"`
  instead of leaving stdout empty. A misplaced `--session` / `--tab-id` now
  explains that it belongs after a supporting subcommand, replacing the
  misleading `--version` suggestion and usage line
  ([#387](https://github.com/Tencent/BrowserSkill/issues/387)).
- DSH Plugin: the right-sidebar observation tab auto-opens again on DSH
  0.2.0+, which removed `current` from the `sessions.list` snapshot. The
  auto-open target now falls back to the `uiSession` main binding (exposed by
  DSH 0.1.5 and 0.2.x alike), and conversation switches on 0.2.x hosts keep
  re-triggering it
  ([#484](https://github.com/Tencent/BrowserSkill/issues/484)).
- Extension: shared-control actions no longer refuse forever on pages with
  self-updating text such as clocks or counters. The first change is reported
  with its before/after text and requires a sync; after that, changes to that
  text stop blocking actions on a ref or selector unless it shares a form,
  list, dialog, panel or other container with the target. Actions without a
  target, form values, modal layers and `--depends-on` regions stay exact,
  and a refused context can no longer be retried
  ([#495](https://github.com/Tencent/BrowserSkill/issues/495)).

## [0.3.3] - 2026-10-14

### Changed

- **Breaking — DSH Plugin:** replace `browser_session`, `browser_page`,
  `browser_inspect`, `browser_interact`, `browser_tabs`, and `browser_assist` with
  the corresponding `bsk_*` names to coexist with other browser plugins.
  The tool-name migration leaves actions, arguments, results and the
  `browser-skill` skill name unchanged.
  Old tool names are not registered as aliases. Upgrade the CLI and extension
  to the coordinated 0.3.3 release before upgrading the plugin.
  Update hardcoded calls and tool policies, restart the host, and reload the skill
  in existing conversations. See the [migration guide](packages/dsh-plugin-browserskill/README.md#breaking-tool-api-migration-033).
- CLI releases require verified Windows EV signing before publication. Builds,
  internal signing and final publication are separate stages. Windows archives
  contain the verified signed executable, and `version.json` hashes the final archives.
- External links and manually created tabs that land in a background Agent Window
  are routed to a normal user window, preserving task popups and human-assistance
  or recording flows. Pending external tabs are excluded from default tool targeting.
- English and Chinese privacy policies describe task video capture, the
  `offscreen` permission, browser-local retention, authorized video exports and
  deletion. The main READMEs document video recording and the DSH migration.

### Added

- [Task video recording](docs/video-recording.md): opt-in, silent H.264 MP4 capture
  of one authorized tab through CLI, DSH or extension controls, with preview,
  export, deletion and recovery of playable partial recordings. Recordings have
  a 10-minute duration limit, a 256 MiB size limit and 24-hour retention.
- [Structured extraction](docs/structured-extraction.md): discover and export
  loaded tables and lists as JSON/CSV, retaining column order, page/frame sources,
  merged-cell metadata and explicit completeness information. DSH bounds rows
  returned to the model context.
- [Element condition waits](docs/wait-for-element.md) in the CLI, extension and
  DSH `bsk_page` tool, with explicit deadlines and recovery guidance.
- CLI browser-selector errors list connected browsers when no instance matches.

### Fixed

- DSH Plugin: roll back incomplete tool registration, surface activation failures,
  and retry at skill/session lifecycle boundaries without leaving a partial suite.
  Include tool schemas in the first `/browser-skill` request, and keep failure and
  recovery notices synchronized with model skill results
  ([#444](https://github.com/Tencent/BrowserSkill/issues/444)).
- Extension: input to a background Agent Window tab no longer keeps failing with
  `input_not_ready` after Chrome drops the session's focus override without a detach
  ([#355](https://github.com/Tencent/BrowserSkill/issues/355)). The session's
  background-execution lease resends the override and waits for a rendered frame; the
  input is sent only once the page reports `visible`, and otherwise still fails before
  dispatch.
- Extension: an agent session no longer keeps the browser's GPU and CPU busy while the
  agent is idle ([#391](https://github.com/Tencent/BrowserSkill/issues/391)). The control
  glow is painted once and pulses only its opacity, twice, instead of repainting the
  viewport every frame, and stays still under reduced motion. Observation disables
  Chrome's Accessibility domain again once it has read the accessibility trees.
- Fill editable controls and editor paragraphs through their editing host while
  preserving the target paragraph's scope; reject noneditable targets and use a
  consistent line model for reading editor text.
- Downloads detect when the browser ignores the requested transfer directory and
  validate the final path before importing a file.
- Element waits enforce state and deadline contracts, treat absent elements as
  hidden, and retry selectors after stale-node lookups.
- Structured extraction preserves DOM values and bounded partial results, keeps
  split grid rows together, and respects nested row ownership and frame visibility.
- CLI navigation exits with code 4 when its lifecycle wait times out; DSH retains
  the created session when start-with-URL navigation times out.
- Video recording keeps startup cancellable, bounds capture waits, recovers from
  navigation and transient overlay-discovery failures, prevents control-overlay
  flashes, and selects an H.264 level appropriate for larger frames.
- Avoid unnecessary debugger cancellation and incomplete tab cleanup in Yandex;
  preserve task-popup provenance and recover transient focus changes.

## [0.3.2] - 2026-09-30

### Changed

- DSH Plugin: support DSH `0.2` hosts while retaining compatibility with the
  `0.1.5-rc.3` SDK.
- Extension: simplify browser profile controls and explain why profile
  instructions are unavailable when they cannot be copied.
- Daemons started with `--foreground` no longer install updates or replace
  themselves with a detached process. `bsk update` leaves them running
  (`"daemon": "left_to_host"` in JSON output); restart them in their owning
  terminal or supervisor after updating.
- A daemon that cannot write next to its executable reports new releases
  instead of installing them. Update attempts, stages and errors are recorded
  in `update-state.json` and shown by `bsk doctor`. Windows `bsk update --json`
  now reports `"status": "updated"` instead of `"staged"`.
- Installation and skill guidance document `BSK_AUTO_UPDATE=off`, daemon
  startup in WorkBuddy and CodeBuddy, and shared-login checks for parallel tasks.
- English and Chinese privacy policies clarify screenshot exports through
  `downloads`, human-help notifications, and retention of exported files.

### Fixed

- CLI/Daemon: make updates recoverable across platforms
  ([#336](https://github.com/Tencent/BrowserSkill/issues/336)). Auto-update
  verifies the new executable and waits for its daemon to serve the same port
  before the old daemon exits. If takeover fails or exceeds 20 seconds, the
  previous executable and service are restored; auto-update retries after 6 hours.
  Windows replaces the running executable without a detached update script.
- `bsk update` verifies the replacement before stopping a background daemon,
  restores the previous version if restart fails, and preserves the actual
  serving port, including daemons started with `--port 0`. If the host cannot
  restart the daemon, it is left running (`"daemon": "left_running"`).
- Serialize updates to the same executable across bsk homes; retain the
  executable path after rollback on Linux; and recover safely if a daemon
  stops during auto-update.
- Daemon: settle pending calls immediately when an extension connection closes
  or is replaced, preserving unknown-outcome errors for inputs, transfers and
  tab borrows. `bsk doctor` and `bsk browsers` report connected extensions that
  have stopped sending heartbeats; closed connections report a disconnect.
- Protocol: preserve explicit `null` results without silently turning invalid
  responses into null results, and reject conflicting result/error fields and
  null error fields.
- Downloads: capture attachments opened through `target="_blank"` and attribute
  them to the clicked tab. Correlate downloads with click dispatch, preserve
  effects that already occurred when a trigger fails, and stop cancelled or
  expired triggers from dispatching later input or leaving overlays behind.
- Browser input: dispatch every press in DOM multi-click actions, honor
  persistent background execution leases, and keep emulation overrides scoped
  to their session and debugger attachment.
- Recording: finish recordings after navigation to blob or restricted pages
  that cannot host the overlay, and clear stale CLI recording state only for
  the session that owns it.
- Human help: bound URL regular-expression work and prevent overlapping
  completion polling so checks cannot block the extension worker.
- Extension overlays: ignore stale state from earlier generations and worker
  instances.
- Website debugging: redact HTML-encoded sensitive input attributes before
  retaining evidence.
- DSH Plugin: reconnect failed observation streams, show outages in the
  observation view and collapsed capsule, and allow new browser sessions after
  an ancestor session is archived.
- `bsk doctor` compares installed skills against the CLI's bundled version;
  skill entry points also fit their size budget on CRLF checkouts.

## [0.3.1] - 2026-09-23

### Added

- [Task-scoped website debugging](docs/website-debugging.md): bounded request/body
  capture, operation-linked console and page context, browser-local history and JSON export,
  CLI and DSH entry points, and an extension evidence workspace. Existing popup
  controls are preserved, with an additive current-task card.
- Debug operation cards now include manual inputs, field-change chains, delayed
  evidence, source-aware noise filtering and explicit capture gaps.
- Website debugging: task-scoped HTTP rules and request replay, native performance
  metrics, request aggregation and duplicate-request analysis.
- Remote gateway task previews and attribution of agent-opened popups and tabs
  to the task that opened them.
- Browser instance naming in the extension popup and explicit
  [browser profile selection](docs/browser-profiles.md) across CLI, DSH and skill guidance.
- Seven additional interface languages: Traditional Chinese, Japanese, French,
  Italian, Spanish, German and Brazilian Portuguese.
- CLI and DSH skill reference bundles with resource-path validation, safe upgrades
  and migration of existing managed installations.

### Changed

- Extension privacy policies now describe website debugging data, browser-local
  history retention and deletion, requested sharing, and redaction limits.
- DSH Plugin: align SDK dependencies with `0.1.5-rc.3`, Cordis `4.0.2` and
  Schemastery `3.18.2`.
- Reduce repeated observation work by reusing sibling context for repeated action labels.
- Skill guidance clarifies installation prerequisites, browser readiness, profile
  selection and the treatment of page content as untrusted data.

### Fixed

- Recoverable browser session startup and stop handling, including pending cleanup
  and protection of shared daemons after launcher timeouts.
- Windows daemon startup isolation from caller job objects.
- Background navigation and viewport/full-page screenshots without activating
  controlled tabs; full-page capture at fractional DPI and with overlay scrollbars.
- Bounded renderer and frame reads, preserving usable observations when optional
  layout reads time out and preventing overlapping reads after a timeout.
- Keep page actions visible beside nonmodal sidebars and honor accessibility modality.
- Prevent control overlays from swallowing clicks and clear stale overlays when
  observed tabs are released.
- Accept lowercase special keys, match ARIA loading states case-insensitively,
  return visible option labels from selection, and retain same-URL reloads in recordings.
- Deliver navigation timeout results before transport expiry and bound human-help cleanup.
- Enforce remote device capacity across pending connections and preserve active
  sessions while renaming browser instances.
- DSH Plugin: settle commands when child processes exit without closing their
  streams, bound cancellation and output draining, and preserve completed results.
- DSH Plugin: restore lazy tool registration after plugin reloads and resumed
  conversations without repeatedly scanning streaming history.
- DSH Plugin: render screenshot cards independently of host attachment UI components,
  preserve previews across host rerenders, and keep extreme-aspect-ratio thumbnails usable.
- Preserve managed skill source links and handle CRLF metadata and incomplete installations.

## [0.3.0] - 2026-09-16

### Added

- [Remote browser connections](docs/remote-extension-connection.md) with a built-in
  server, one-use pairing links, device credential renewal and revocation, and
  support for native TLS or a TLS reverse proxy. Remote upload and download are unsupported.
- [Operation audit](docs/operation-audit.md): opt-in task history stored on the
  daemon host, with redacted operation metadata, export, deletion and 30-day retention
- [Full-page screenshots](docs/long-screenshot.md) from extension Quick Actions and
  the CLI, with streamed PNG output, cancellation and lazy-loaded page capture
- Canvas visual refs, on-demand element screenshots and screenshot-bound point
  clicks; observation cursor continuation when an explicit token limit is used
- [Scroll-to element primitive](docs/scroll-to.md) across CLI, Extension and DSH Plugin,
  with ancestor-clipped visible bounds, iframe support and cooperative cancellation
- Native [mouse-wheel input](docs/wheel.md), explicit focus and blur actions
- [Host-managed daemon setup](docs/sandboxed-agents.md) with `BSK_HOME` and
  `BSK_AUTO_START=0` for agents whose command sandboxes reap background processes
- Configurable local connection port in the extension popup and Korean localization

### Changed

- **Automation settings:** the extension's saved borrow-confirmation and human-help
  switches govern existing and new sessions. `--unattended`, `tab borrow --no-confirm`
  and `BSK_REQUEST_HELP=off` are deprecated compatibility inputs and cannot override
  these switches. Set the browser preferences when upgrading unattended workflows.
- Managed CLI skills update only while their content matches the installed baseline;
  custom instructions and local edits are preserved, with recovery guidance in `doctor`
- DSH Plugin: use the native browser sidebar when available, with a floating-panel fallback

### Fixed

- Windows installer path handling, verification of the resolved executable, and
  replacement of installations using a daemon from another directory
- Browser connection preference recovery and compatibility during staggered component upgrades
- Observation document and frame geometry consistency, Canvas target identity checks,
  and screenshot/session cleanup during cancellation or navigation

## [0.2.1] - 2026-09-09

### Changed
- DSH Plugin: clarified installation, configuration, profile restart, and upgrade instructions

### Fixed
- CLI: reliable Windows self-updates, including executable replacement and daemon restart
- CLI: Windows named-pipe connection continuity and stale daemon process detection
- Windows installer: PowerShell 5.1 compatibility, path quoting, and staged executable replacement
- CLI / DSH Plugin: cancellation propagation and upload/download cleanup when the parent process exits
- Extension: tab ownership and session cleanup when agent tabs fail to open or borrowed tabs are returned or closed
- Extension: navigation recovery when other extensions restrict Chrome DevTools Protocol access
- Extension: background input filling, automatic append behavior, and verification of field values before reporting success
- Extension: match observed form state to the correct element after page changes
- Extension: UUID generation fallback for recording and overlays on insecure origins
- Browser locale matching for regional language variants
- DSH Plugin: observation state synchronization, thumbnail capture lifecycle, and stale preview cleanup
- DSH Plugin: removed the obsolete client runtime host dependency

## [0.2.0] - 2026-09-02

### Added
- File transfer: upload and download support across CLI, Extension, and DSH Plugin
- File transfer: drag-and-drop upload (`drop-to-upload`)
- VOM semantic graph, name enrichment, and hover perception modules
- VOM hover probing (opt-in via `observe` parameter)
- DSH Plugin: browser tool parity with CLI commands
- Edge Add-ons automated publishing in CI
- Protocol upgrade reminder when CLI / Extension protocol versions differ
- Browser evaluation harness (`evals/browser/`)
- Unified release script (`scripts/release.mjs`)

### Changed
- **Version scheme**: all three components now share the same semver
- VOM rendering algorithm optimizations
- Leaner SKILL.md agent instructions
- DSH Plugin: simplified browser commands
- Borrow confirmation UX — proactive focus and longer timeout
- PiP window now has a close button

### Fixed
- Screenshot media type detection (was hard-coded to `image/png`)
- DSH Plugin session lifecycle stability
- DSH Plugin Cordis package ID mismatch
- Observation thumbnail media type sniffing
- Upload/download race conditions and layout bypass issues
- VOM repeated name and safety policy issues

---

*Previous releases used independent version numbers per component.*

## CLI 0.1.11 / Extension 0.1.7 / DSH Plugin 0.1.2 — 2026-08-26 ~ 2026-08-29

### Added
- DSH Plugin sidebar integration, session lifecycle, and archive cleanup
- Recorder iframe and OOPIF support

### Changed
- VOM functional refactor

### Fixed
- Recorder safety policy and bug fixes

## CLI 0.1.10 / Extension 0.1.6 — 2026-08-08

### Added
- VOM observation recording and settled-state detection
- Record overlay timer

### Fixed
- Browser keepalive disconnect handling

## CLI 0.1.9 / Extension 0.1.5 — 2026-07-29

### Added
- CLI auto-update mechanism
- Trace v3 protocol and recorder

### Fixed
- MV3 keepalive disconnect

## CLI 0.1.8 / Extension 0.1.4 — 2026-07-22

### Added
- More browser interaction actions

### Fixed
- Windows named-pipe hash-only path issue

## CLI 0.1.7 / Extension 0.1.3 — 2026-07-07

Initial public release pair.

## CLI 0.1.6 — 2026-06-30

### Fixed
- Minor CLI fixes

## CLI 0.1.5 / Extension 0.1.2 — 2026-06-22

First tagged releases.
