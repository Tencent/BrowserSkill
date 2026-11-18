//! Namespaced RPC methods (§4.3) and their compile-time [`MethodSpec`] catalog.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::{MethodDescriptor, MethodOwner};
use crate::local_auth::*;
use crate::system::*;
use crate::tools::*;
use crate::{CancelParams, CancelResult};

/// Observable browser-side effect class for a protocol method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MethodEffect {
    /// Reads browser/session state without dispatching page input.
    PassiveRead,
    /// Dispatches temporary input such as hover probes. It must not submit,
    /// navigate, or persist page state, but it can trigger page event handlers.
    TransientInput,
    /// Drives browser/page state such as clicking, filling, navigation, tabs,
    /// or arbitrary page script.
    BrowserMutation,
    /// Control-plane/session lifecycle operation. These are deliberately not
    /// gated by the pending browser-action interrupt path.
    ControlPlane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActionMetadataPolicy {
    /// Rejects all action metadata (`context_id`, `depends_on`, `observation_id`, `expect`).
    None,
    /// Passive read (`tool.read`): accepts optional caller-supplied `context_id` to validate
    /// context and bind tab without renewing control; rejects `depends_on`, `observation_id`,
    /// and `expect`.
    ContextOnly,
    /// Passive read whose daemon-to-extension wire payload accepts optional `context_id` to bind
    /// a scoped tab without renewing control, while caller CLI/MCP/IPC surfaces fail closed on
    /// caller-supplied `context_id`.
    TabBindingContext,
    /// Guarded/transient action: accepts full [`ActionMetadata`].
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeadlineKind {
    Standard,
    FullPage,
    BorrowConfirmation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeKind {
    Ordinary,
    SessionStop,
    TabBorrow,
    RequestHelp,
    FullPageCapture,
    EffectAwareInput,
    EffectAwarePage,
    FileTransfer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DialogGate {
    Bypass,
    Gated,
    DynamicDebug,
    DynamicVideo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueueMode {
    Serial,
    Unlocked,
    CooperateDynamic,
    VideoDynamic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WalTracking {
    Never,
    Always,
    DynamicDebug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ImplicitSession {
    Never,
    Always,
    DynamicVideo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutoInjectContext {
    Never,
    Always,
    DynamicObserve,
    DynamicDebug,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundRequirement {
    None,
    Accessible,
    Controlled,
    Navigation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResumeControl {
    Effect,
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperationMode {
    None,
    SessionStart,
    Session,
    Dialog,
    Cooperate,
    ManageTabs,
    RequestHelp,
    RecordStart,
    PassiveRead,
    Debug,
    Video,
    GuardedAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DebugEvidenceKind {
    None,
    Action,
    FormInput,
    Navigation,
    Dialog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecipeStepKind {
    Ignore,
    Cooperate,
    Observe,
    Extract { action: &'static str },
    Navigate,
    WaitElement,
    TabBorrow,
    TabReturn,
    Skip { reason: &'static str },
}

/// Complete compile-time specification for one RPC method. Every `Method` variant
/// must fill every field explicitly (no defaults, no wildcards) so Daemon, CLI,
/// Recipe, Audit, Debug, and Extension share one single source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MethodSpec {
    pub owner: MethodOwner,
    pub effect: MethodEffect,
    pub action_metadata: ActionMetadataPolicy,
    pub deadline: DeadlineKind,
    pub response_grace: bool,
    pub cancel_at_deadline: bool,
    pub outcome: OutcomeKind,
    pub wal_tracking: WalTracking,
    pub dialog_gate: DialogGate,
    pub queue_mode: QueueMode,
    pub implicit_session: ImplicitSession,
    pub auto_inject_context: AutoInjectContext,
    pub tab_transition: bool,
    pub remote_allowed: bool,
    pub background: BackgroundRequirement,
    pub resume_control: ResumeControl,
    pub opens_tabs: bool,
    pub auto_borrow_write: bool,
    pub cooperation: CooperationMode,
    pub dom_targeted: bool,
    pub bootstrap_allowed: bool,
    pub debug_evidence: DebugEvidenceKind,
    pub audit_key: Option<&'static str>,
    pub recipe_step: RecipeStepKind,
}

/// The method catalog is the only list of wire methods and their payloads.
macro_rules! methods {
    ($($variant:ident => ($wire:literal, $params:ty, $result:ty)),* $(,)?) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
        pub enum Method {
            $(#[serde(rename = $wire)] $variant,)*
        }

        impl Method {
            pub const ALL: &'static [Method] = &[$(Self::$variant,)*];

            pub const fn wire_name(&self) -> &'static str {
                match self { $(Self::$variant => $wire,)* }
            }

            pub fn describe(&self, generator: &mut schemars::SchemaGenerator) -> MethodDescriptor {
                match self {
                    $(Self::$variant => MethodDescriptor::new::<$params, $result>(
                        $wire,
                        self.spec(),
                        generator,
                    ),)*
                }
            }
        }
    };
}

methods! {
    ToolCooperate => ("tool.cooperate", CooperateParams, CooperateResult),
    LocalAuthPair => ("local_auth.pair", LocalAuthPairParams, LocalAuthPairResult),
    LocalAuthDevices => ("local_auth.devices", LocalAuthDevicesParams, LocalAuthDevicesResult),
    LocalAuthRevoke => ("local_auth.revoke", LocalAuthRevokeParams, LocalAuthRevokeResult),
    LocalAuthRotate => ("local_auth.rotate", LocalAuthRotateParams, LocalAuthRotateResult),
    LocalAuthSetMode => ("local_auth.set_mode", LocalAuthSetModeParams, LocalAuthSetModeResult),
    AuditRequest => ("audit.request", AuditRequestParams, AuditRequestResult),
    LedgerRequest => ("ledger.request", LedgerRequestParams, LedgerRequestResult),
    SystemHandshake => ("system.handshake", HandshakeRequest, HandshakeResponse),
    SystemPing => ("system.ping", PingParams, PingResult),
    SystemStatus => ("system.status", StatusParams, StatusResult),
    SessionStart => ("session.start", DaemonSessionStartParams, DaemonSessionStartResult),
    SessionStartTracked => ("session.start_tracked", DaemonSessionStartTrackedParams, DaemonSessionStartResult),
    SessionRequest => ("session.request", SessionRequestParams, SessionRequestResult),
    SessionStop => ("session.stop", DaemonSessionStopParams, DaemonSessionStopResult),
    SessionStopAll => ("session.stop_all", DaemonSessionStopAllParams, DaemonSessionStopResult),
    SessionList => ("session.list", SessionListParams, SessionListResult),
    SessionRunLog => ("session.run_log", SessionRunLogParams, RunLog),
    BrowserList => ("browser.list", BrowserListParams, BrowserListResult),
    ToolSessionStart => ("tool.session_start", SessionStartParams, SessionStartResult),
    ToolSessionStop => ("tool.session_stop", SessionStopParams, SessionStopOutcome),
    ToolWindowResize => ("tool.window_resize", WindowResizeParams, WindowResizeResult),
    ToolEmulate => ("tool.emulate", EmulateParams, EmulateResult),
    ToolTabList => ("tool.tab_list", TabListParams, TabListResult),
    ToolTabCreate => ("tool.tab_create", TabCreateParams, TabCreateResult),
    ToolTabClose => ("tool.tab_close", TabCloseParams, TabCloseResult),
    ToolTabBorrow => ("tool.tab_borrow", TabBorrowParams, TabBorrowResult),
    ToolTabReturn => ("tool.tab_return", TabReturnParams, TabReturnResult),
    ToolTabSelect => ("tool.tab_select", TabSelectParams, TabSelectResult),
    ToolNavigate => ("tool.navigate", NavigateParams, NavigateResult),
    ToolNavigateBack => ("tool.navigate_back", NavigateBackParams, NavigateBackResult),
    ToolNavigateForward => ("tool.navigate_forward", NavigateForwardParams, NavigateForwardResult),
    ToolReload => ("tool.reload", ReloadParams, ReloadResult),
    ToolClick => ("tool.click", ClickParams, ClickResult),
    ToolHover => ("tool.hover", HoverParams, HoverResult),
    ToolDrag => ("tool.drag", DragParams, DragResult),
    ToolWheel => ("tool.wheel", WheelParams, WheelResult),
    ToolScrollTo => ("tool.scroll_to", ScrollToParams, ScrollToResult),
    ToolFocus => ("tool.focus", FocusParams, FocusResult),
    ToolBlur => ("tool.blur", BlurParams, BlurResult),
    ToolFill => ("tool.fill", FillParams, FillResult),
    ToolPress => ("tool.press", PressParams, PressResult),
    ToolSelect => ("tool.select", SelectParams, SelectResult),
    ToolUpload => ("tool.upload", UploadParams, UploadResult),
    ToolDownload => ("tool.download", DownloadParams, DownloadResult),
    ToolSnapshot => ("tool.snapshot", SnapshotParams, SnapshotResult),
    ToolObserve => ("tool.observe", ObserveParams, ObserveResult),
    ToolGetHtml => ("tool.get_html", GetHtmlParams, GetHtmlResult),
    ToolRead => ("tool.read", ReadParams, ReadResult),
    ToolExtract => ("tool.extract", ExtractParams, ExtractResult),
    ToolScreenshot => ("tool.screenshot", ScreenshotParams, ScreenshotResult),
    ToolScreenshotFullPage => ("tool.screenshot_full_page", ScreenshotFullPageParams, ScreenshotFullPageResult),
    ToolScreenshotRead => ("tool.screenshot_read", ScreenshotReadParams, ScreenshotReadResult),
    ToolScreenshotRelease => ("tool.screenshot_release", ScreenshotReleaseParams, ScreenshotReleaseResult),
    ToolConsole => ("tool.console", ConsoleParams, ConsoleResult),
    ToolDebug => ("tool.debug", DebugParams, DebugResult),
    ToolNetwork => ("tool.network", NetworkParams, NetworkResult),
    ToolEvaluate => ("tool.evaluate", EvaluateParams, EvaluateResult),
    ToolDialogStatus => ("tool.dialog_status", DialogStatusParams, DialogStatusResult),
    ToolDialogAccept => ("tool.dialog_accept", DialogHandleParams, DialogHandleResult),
    ToolDialogDismiss => ("tool.dialog_dismiss", DialogHandleParams, DialogHandleResult),
    ToolOperationAwait => ("tool.operation_await", OperationParams, OperationAwaitResult),
    ToolOperationCancel => ("tool.operation_cancel", OperationParams, CancelResult),
    ToolWaitForNavigation => ("tool.wait_for_navigation", WaitForNavigationParams, WaitForNavigationResult),
    ToolWaitForElement => ("tool.wait_for_element", WaitForElementParams, WaitForElementResult),
    ToolWaitMs => ("tool.wait_ms", WaitMsParams, WaitMsResult),
    ToolRequestHelp => ("tool.request_help", RequestHelpParams, RequestHelpResult),
    ToolRecordStart => ("tool.record_start", RecordStartParams, RecordStartResult),
    ToolRecordStop => ("tool.record_stop", RecordStopParams, RecordStopResult),
    ToolRecordAwait => ("tool.record_await", RecordAwaitParams, RecordAwaitResult),
    ToolVideo => ("tool.video", VideoParams, VideoResult),
    TransferBegin => ("transfer.begin", TransferBeginParams, TransferBeginResult),
    TransferChunk => ("transfer.chunk", TransferChunkParams, TransferChunkResult),
    TransferFinish => ("transfer.finish", TransferIdParams, TransferReadyResult),
    TransferRead => ("transfer.read", TransferReadParams, TransferChunkResult),
    TransferRelease => ("transfer.release", TransferIdParams, TransferReleaseResult),
    Cancel => ("cancel", CancelParams, CancelResult),
}

fn parse_debug_action(params: &serde_json::Value) -> Option<DebugAction> {
    params
        .get("action")
        .cloned()
        .and_then(|action| serde_json::from_value::<DebugAction>(action).ok())
}

fn parse_video_action(params: &serde_json::Value) -> Option<VideoAction> {
    params
        .get("action")
        .cloned()
        .and_then(|action| serde_json::from_value::<VideoAction>(action).ok())
}

fn parse_cooperate_action(params: &serde_json::Value) -> Option<CooperateAction> {
    params
        .get("action")
        .cloned()
        .and_then(|action| serde_json::from_value::<CooperateAction>(action).ok())
}

/// **Judgment calls** (read these before adding new variants):
///
/// * `tool.evaluate` is classified as browser-mutating because the
///   daemon cannot statically distinguish a `document.title`
///   read from a `form.submit()` write.
/// * `tool.observe` is classified as transient input: its bounded
///   hover probes do not commit browser state, but they dispatch real
///   page input events and therefore must be gated like automation.
/// * `tool.wait_*` are classified as read-only: they do not
///   initiate any browser action; they observe state only.
/// * `session.*` and `tool.session_*` are NOT gated. Blocking
///   `session.stop` would prevent the agent from gracefully
///   tearing down after observing the user's interrupt.
/// * `cancel`, `tool.dialog_dismiss`, and `tool.operation_cancel` are
///   control-plane operations so cleanup/teardown remains available
///   after a user stop.
macro_rules! method_spec {
    (
        owner: $owner:ident,
        effect: $effect:ident,
        action_metadata: $meta:ident,
        remote_allowed: $remote:expr,
        deadline: $deadline:ident,
        response_grace: $grace:expr,
        cancel_at_deadline: $cancel:expr,
        outcome: $outcome:ident,
        wal: $wal:ident,
        dialog: $dialog:ident,
        queue: $queue:ident,
        implicit_session: $imp:ident,
        auto_inject: $auto:ident,
        tab_transition: $tab:expr,
        background: $bg:ident,
        resume: $resume:ident,
        opens_tabs: $opens:expr,
        auto_borrow_write: $borrow:expr,
        cooperation: $coop:ident,
        dom_targeted: $dom:expr,
        bootstrap: $boot:expr,
        debug_evidence: $dbg:ident,
        audit_key: $audit:expr,
        recipe: $recipe:expr $(,)?
    ) => {
        &MethodSpec {
            owner: MethodOwner::$owner,
            effect: MethodEffect::$effect,
            action_metadata: ActionMetadataPolicy::$meta,
            deadline: DeadlineKind::$deadline,
            response_grace: $grace,
            cancel_at_deadline: $cancel,
            outcome: OutcomeKind::$outcome,
            wal_tracking: WalTracking::$wal,
            dialog_gate: DialogGate::$dialog,
            queue_mode: QueueMode::$queue,
            implicit_session: ImplicitSession::$imp,
            auto_inject_context: AutoInjectContext::$auto,
            tab_transition: $tab,
            remote_allowed: $remote,
            background: BackgroundRequirement::$bg,
            resume_control: ResumeControl::$resume,
            opens_tabs: $opens,
            auto_borrow_write: $borrow,
            cooperation: CooperationMode::$coop,
            dom_targeted: $dom,
            bootstrap_allowed: $boot,
            debug_evidence: DebugEvidenceKind::$dbg,
            audit_key: $audit,
            recipe_step: $recipe,
        }
    };
}

impl Method {
    /// Exhaustive compile-time single source of truth for every `Method` variant.
    pub const fn spec(&self) -> &'static MethodSpec {
        use RecipeStepKind::*;
        match self {
            Self::ToolCooperate => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: CooperateDynamic, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Cooperate, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("cooperate"), recipe: Cooperate
            ),
            Self::LocalAuthPair => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::LocalAuthDevices => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::LocalAuthRevoke => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::LocalAuthRotate => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::LocalAuthSetMode => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::AuditRequest => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::LedgerRequest => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SystemHandshake => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SystemPing => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SystemStatus => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionStart => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionStartTracked => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionRequest => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionStop => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionStopAll => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionList => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::SessionRunLog => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::BrowserList => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::ToolSessionStart => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: SessionStart, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("sessionStart"), recipe: Ignore
            ),
            Self::ToolSessionStop => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: SessionStop,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Session, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("sessionStop"), recipe: Ignore
            ),
            Self::ToolWindowResize => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: GuardedAction, dom_targeted: false, bootstrap: true,
                debug_evidence: None, audit_key: Some("resize"), recipe: Ignore
            ),
            Self::ToolEmulate => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: true,
                debug_evidence: None, audit_key: Some("emulate"), recipe: Ignore
            ),
            Self::ToolTabList => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Session, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("tabList"), recipe: Ignore
            ),
            Self::ToolTabCreate => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: true,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: ManageTabs, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("tabCreate"), recipe: Ignore
            ),
            Self::ToolTabClose => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: true,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: GuardedAction, dom_targeted: false, bootstrap: true,
                debug_evidence: None, audit_key: Some("tabClose"), recipe: Ignore
            ),
            Self::ToolTabBorrow => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: None, remote_allowed: true,
                deadline: BorrowConfirmation, response_grace: false, cancel_at_deadline: true, outcome: TabBorrow,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: true,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: ManageTabs, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("tabBorrow"), recipe: TabBorrow
            ),
            Self::ToolTabReturn => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: true,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: ManageTabs, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("tabReturn"), recipe: TabReturn
            ),
            Self::ToolTabSelect => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: true,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: ManageTabs, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("tabSelect"), recipe: Ignore
            ),
            Self::ToolNavigate => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: EffectAwarePage,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Navigation, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: true,
                debug_evidence: Navigation, audit_key: Some("navigate"), recipe: Navigate
            ),
            Self::ToolNavigateBack => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: EffectAwarePage,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Navigation, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: false,
                debug_evidence: Navigation, audit_key: Some("navigateBack"), recipe: Skip { reason: "history_navigation" }
            ),
            Self::ToolNavigateForward => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: EffectAwarePage,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Navigation, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: false,
                debug_evidence: Navigation, audit_key: Some("navigateForward"), recipe: Skip { reason: "history_navigation" }
            ),
            Self::ToolReload => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: EffectAwarePage,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Navigation, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: false,
                debug_evidence: Navigation, audit_key: Some("reload"), recipe: Skip { reason: "history_navigation" }
            ),
            Self::ToolClick => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: true, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("click"), recipe: Extract { action: "click" }
            ),
            Self::ToolHover => method_spec!(
                owner: Extension, effect: TransientInput, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("hover"), recipe: Extract { action: "hover" }
            ),
            Self::ToolDrag => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: true, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("drag"), recipe: Skip { reason: "drag" }
            ),
            Self::ToolWheel => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("scroll"), recipe: Skip { reason: "wheel" }
            ),
            Self::ToolScrollTo => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("scroll"), recipe: Extract { action: "scroll-to" }
            ),
            Self::ToolFocus => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("focus"), recipe: Skip { reason: "focus" }
            ),
            Self::ToolBlur => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("blur"), recipe: Skip { reason: "focus" }
            ),
            Self::ToolFill => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: FormInput, audit_key: Some("fill"), recipe: Extract { action: "fill" }
            ),
            Self::ToolPress => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: true, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("press"), recipe: Extract { action: "press" }
            ),
            Self::ToolSelect => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: FormInput, audit_key: Some("select"), recipe: Extract { action: "select" }
            ),
            Self::ToolUpload => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: false,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: FileTransfer,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("upload"), recipe: Skip { reason: "file_transfer" }
            ),
            Self::ToolDownload => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: false,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: FileTransfer,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: true, bootstrap: false,
                debug_evidence: Action, audit_key: Some("download"), recipe: Skip { reason: "file_transfer" }
            ),
            Self::ToolSnapshot => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("read"), recipe: Observe
            ),
            Self::ToolObserve => method_spec!(
                owner: Extension, effect: TransientInput, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: DynamicObserve, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("read"), recipe: Observe
            ),
            Self::ToolGetHtml => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("read"), recipe: Ignore
            ),
            Self::ToolRead => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: ContextOnly, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("read"), recipe: Ignore
            ),
            Self::ToolExtract => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("read"), recipe: Ignore
            ),
            Self::ToolScreenshot => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("screenshot"), recipe: Ignore
            ),
            Self::ToolScreenshotFullPage => method_spec!(
                owner: Extension, effect: TransientInput, action_metadata: Full, remote_allowed: true,
                deadline: FullPage, response_grace: false, cancel_at_deadline: true, outcome: FullPageCapture,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("screenshotFullPage"), recipe: Ignore
            ),
            Self::ToolScreenshotRead => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Session, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("screenshotRead"), recipe: Ignore
            ),
            Self::ToolScreenshotRelease => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Session, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("screenshotRelease"), recipe: Ignore
            ),
            Self::ToolConsole => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("console"), recipe: Ignore
            ),
            Self::ToolDebug => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: DynamicDebug, dialog: DynamicDebug, queue: Serial, implicit_session: Always, auto_inject: DynamicDebug, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Debug, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("debug"), recipe: Ignore
            ),
            Self::ToolNetwork => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("network"), recipe: Ignore
            ),
            Self::ToolEvaluate => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: Full, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwarePage,
                wal: Always, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Always, tab_transition: false,
                background: Accessible, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: GuardedAction, dom_targeted: false, bootstrap: false,
                debug_evidence: Action, audit_key: Some("evaluate"), recipe: Skip { reason: "script" }
            ),
            Self::ToolDialogStatus => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Unlocked, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Never, opens_tabs: false, auto_borrow_write: false, cooperation: Dialog, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("dialogStatus"), recipe: Ignore
            ),
            Self::ToolDialogAccept => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: true, outcome: EffectAwareInput,
                wal: Always, dialog: Bypass, queue: Unlocked, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Never, opens_tabs: false, auto_borrow_write: false, cooperation: Dialog, dom_targeted: false, bootstrap: false,
                debug_evidence: Dialog, audit_key: Some("dialogAccept"), recipe: Ignore
            ),
            Self::ToolDialogDismiss => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Unlocked, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Never, opens_tabs: false, auto_borrow_write: false, cooperation: Dialog, dom_targeted: false, bootstrap: false,
                debug_evidence: Dialog, audit_key: Some("dialogDismiss"), recipe: Ignore
            ),
            Self::ToolOperationAwait => method_spec!(
                owner: Daemon, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("operationAwait"), recipe: Ignore
            ),
            Self::ToolOperationCancel => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("operationCancel"), recipe: Ignore
            ),
            Self::ToolWaitForNavigation => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("wait"), recipe: Ignore
            ),
            Self::ToolWaitForElement => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: TabBindingContext, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: Controlled, resume: Effect, opens_tabs: false, auto_borrow_write: true, cooperation: PassiveRead, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("waitForElement"), recipe: WaitElement
            ),
            Self::ToolWaitMs => method_spec!(
                owner: Daemon, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("wait"), recipe: Ignore
            ),
            Self::ToolRequestHelp => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: true, cancel_at_deadline: true, outcome: RequestHelp,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Always, opens_tabs: false, auto_borrow_write: false, cooperation: RequestHelp, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("help"), recipe: Ignore
            ),
            Self::ToolRecordStart => method_spec!(
                owner: Extension, effect: BrowserMutation, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Always, opens_tabs: false, auto_borrow_write: false, cooperation: RecordStart, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("recordStart"), recipe: Ignore
            ),
            Self::ToolRecordStop => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Unlocked, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Session, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("recordStop"), recipe: Ignore
            ),
            Self::ToolRecordAwait => method_spec!(
                owner: Extension, effect: PassiveRead, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Gated, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Session, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("recordAwait"), recipe: Ignore
            ),
            Self::ToolVideo => method_spec!(
                owner: Extension, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: DynamicVideo, queue: VideoDynamic, implicit_session: DynamicVideo, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: Video, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: Some("video"), recipe: Ignore
            ),
            Self::TransferBegin => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Always, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::TransferChunk => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::TransferFinish => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::TransferRead => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::TransferRelease => method_spec!(
                owner: Daemon, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
            Self::Cancel => method_spec!(
                owner: Shared, effect: ControlPlane, action_metadata: None, remote_allowed: true,
                deadline: Standard, response_grace: false, cancel_at_deadline: false, outcome: Ordinary,
                wal: Never, dialog: Bypass, queue: Serial, implicit_session: Never, auto_inject: Never, tab_transition: false,
                background: None, resume: Effect, opens_tabs: false, auto_borrow_write: false, cooperation: None, dom_targeted: false, bootstrap: false,
                debug_evidence: None, audit_key: None, recipe: Ignore
            ),
        }
    }

    pub const fn owner(&self) -> MethodOwner {
        self.spec().owner
    }

    pub const fn effect(&self) -> MethodEffect {
        self.spec().effect
    }

    /// Compile-time wire action metadata acceptance policy
    /// (`None`, `ContextOnly`, `TabBindingContext`, or `Full`).
    pub const fn action_metadata_policy(&self) -> ActionMetadataPolicy {
        self.spec().action_metadata
    }

    /// Param-sensitive caller action-metadata policy derived purely from `MethodSpec`:
    /// - `Full` for guarded browser actions (including dynamic `observe` only when
    ///   `probe_hover == true` and `debug` only when `action.cooperation_guarded()`).
    /// - `ContextOnly` for `tool.read` (`--context` / `context` allowed from callers).
    /// - `None` for all other methods (including `TabBindingContext` passive reads, whose
    ///   wire contract accepts `context_id` to resolve a target tab without renewing
    ///   control while CLI/MCP callers do not pass `--context` / `context` directly).
    pub fn caller_action_metadata_policy_with_params(
        &self,
        params: Option<&serde_json::Value>,
    ) -> ActionMetadataPolicy {
        match self.spec().action_metadata {
            ActionMetadataPolicy::None | ActionMetadataPolicy::TabBindingContext => {
                ActionMetadataPolicy::None
            }
            ActionMetadataPolicy::ContextOnly => ActionMetadataPolicy::ContextOnly,
            ActionMetadataPolicy::Full => {
                let guarded = match self.spec().auto_inject_context {
                    AutoInjectContext::Always => true,
                    AutoInjectContext::Never => false,
                    AutoInjectContext::DynamicObserve => params.is_some_and(|p| {
                        p.get("probe_hover") == Some(&serde_json::Value::Bool(true))
                    }),
                    AutoInjectContext::DynamicDebug => params
                        .and_then(parse_debug_action)
                        .is_some_and(|action| action.cooperation_guarded()),
                };
                if guarded {
                    ActionMetadataPolicy::Full
                } else {
                    ActionMetadataPolicy::None
                }
            }
        }
    }

    /// Whether the wire parameter contract merges full [`ActionMetadata`]
    /// (`context_id`, `observation_id`, `depends_on`, `expect`).
    pub const fn accepts_action_metadata(&self) -> bool {
        matches!(self.action_metadata_policy(), ActionMetadataPolicy::Full)
    }

    /// Whether this method belongs to the `tool.*` namespace audited and
    /// logged per session operation.
    pub const fn is_tool(&self) -> bool {
        self.spec().audit_key.is_some()
    }

    /// Debug reads/teardown remain available after interruption, while explicit
    /// network interventions and replay are gated like other browser writes.
    pub fn requires_interrupt_gate_with_params(&self, params: &serde_json::Value) -> bool {
        let effect = if matches!(self, Method::ToolDebug) {
            parse_debug_action(params)
                .map(|action| action.effect())
                .unwrap_or(self.effect())
        } else {
            self.effect()
        };
        (matches!(self, Method::ToolVideo)
            && parse_video_action(params).is_some_and(VideoAction::interrupt_gated))
            || matches!(
                effect,
                MethodEffect::BrowserMutation | MethodEffect::TransientInput
            )
    }

    pub fn dialog_gated_with_params(&self, params: &serde_json::Value) -> bool {
        match self.spec().dialog_gate {
            DialogGate::Bypass => false,
            DialogGate::Gated => true,
            DialogGate::DynamicDebug => {
                parse_debug_action(params).is_some_and(|action| action.dialog_gated())
            }
            DialogGate::DynamicVideo => {
                parse_video_action(params).is_some_and(VideoAction::dialog_gated)
            }
        }
    }

    pub fn wal_tracked_with_params(&self, params: &serde_json::Value) -> bool {
        match self.spec().wal_tracking {
            WalTracking::Never => false,
            WalTracking::Always => true,
            WalTracking::DynamicDebug => {
                parse_debug_action(params).is_some_and(|action| action.wal_tracked())
            }
        }
    }

    pub fn implicit_session_with_params(&self, params: &serde_json::Value) -> bool {
        match self.spec().implicit_session {
            ImplicitSession::Never => false,
            ImplicitSession::Always => true,
            ImplicitSession::DynamicVideo => {
                params.get("session_id").is_some()
                    || parse_video_action(params).is_some_and(|action| action == VideoAction::Start)
            }
        }
    }

    pub fn auto_injects_context_with_params(&self, params: &serde_json::Value) -> bool {
        match self.spec().auto_inject_context {
            AutoInjectContext::Never => false,
            AutoInjectContext::Always => true,
            AutoInjectContext::DynamicObserve => {
                params.get("probe_hover") == Some(&serde_json::Value::Bool(true))
            }
            AutoInjectContext::DynamicDebug => {
                parse_debug_action(params).is_some_and(|action| action.cooperation_guarded())
            }
        }
    }

    pub fn queue_unlocked_with_params(&self, params: &serde_json::Value) -> bool {
        match self.spec().queue_mode {
            QueueMode::Serial => false,
            QueueMode::Unlocked => true,
            QueueMode::CooperateDynamic => {
                parse_cooperate_action(params) != Some(CooperateAction::Enable)
            }
            QueueMode::VideoDynamic => {
                parse_video_action(params).is_some_and(|action| !action.uses_session_queue())
            }
        }
    }

    /// Whether this RPC drives browser/page state in the traditional sense.
    pub fn is_mutating(&self) -> bool {
        self.effect() == MethodEffect::BrowserMutation
    }

    /// Whether a pending user interrupt should reject this method.
    pub fn requires_interrupt_gate(&self) -> bool {
        matches!(
            self.effect(),
            MethodEffect::TransientInput | MethodEffect::BrowserMutation
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CancelParams, CancelResult};
    use serde_json::json;

    #[test]
    fn method_spec_invariants_hold_for_every_method() {
        for method in Method::ALL {
            let spec = method.spec();
            assert_eq!(
                spec.audit_key.is_some(),
                method.wire_name().starts_with("tool."),
                "{} audit_key must match tool.* namespace",
                method.wire_name(),
            );
            assert_eq!(
                spec.action_metadata == ActionMetadataPolicy::Full,
                spec.auto_inject_context != AutoInjectContext::Never,
                "{} action_metadata and auto_inject_context out of sync",
                method.wire_name(),
            );
            assert_eq!(
                matches!(
                    spec.action_metadata,
                    ActionMetadataPolicy::ContextOnly | ActionMetadataPolicy::TabBindingContext
                ),
                spec.cooperation == CooperationMode::PassiveRead
                    && spec.effect == MethodEffect::PassiveRead,
                "{} ContextOnly/TabBindingContext policy must match passive-read cooperation methods",
                method.wire_name(),
            );
            assert_eq!(
                spec.action_metadata == ActionMetadataPolicy::ContextOnly,
                *method == Method::ToolRead,
                "{} only tool.read accepts caller-supplied context_id as a passive read",
                method.wire_name(),
            );
            if matches!(
                method,
                Method::ToolWindowResize
                    | Method::ToolEmulate
                    | Method::ToolTabClose
                    | Method::ToolDialogAccept
            ) {
                assert_eq!(spec.outcome, OutcomeKind::EffectAwareInput);
                assert!(spec.cancel_at_deadline);
            }
            if spec.cancel_at_deadline {
                assert_ne!(
                    spec.outcome,
                    OutcomeKind::Ordinary,
                    "{} sets cancel_at_deadline=true so it must declare a specific OutcomeKind",
                    method.wire_name()
                );
            }
        }
    }

    #[test]
    fn dynamic_dialog_and_wal_gates_cover_mutating_subactions() {
        assert!(Method::ToolDebug.dialog_gated_with_params(&json!({"action": "replay"})));
        assert!(!Method::ToolDebug.dialog_gated_with_params(&json!({"action": "request"})));
        assert!(Method::ToolDebug.wal_tracked_with_params(&json!({"action": "replay"})));
        assert!(Method::ToolDebug.wal_tracked_with_params(&json!({"action": "rule_add"})));
        assert!(Method::ToolDebug.wal_tracked_with_params(&json!({"action": "rule_enable"})));
        assert!(!Method::ToolDebug.wal_tracked_with_params(&json!({"action": "request"})));
        assert!(Method::ToolVideo.dialog_gated_with_params(&json!({"action": "start"})));
        assert!(!Method::ToolVideo.dialog_gated_with_params(&json!({"action": "stop"})));
        assert!(Method::ToolDownload.wal_tracked_with_params(&json!({})));
        assert!(Method::ToolDialogAccept.wal_tracked_with_params(&json!({})));
        assert!(Method::ToolNavigate.wal_tracked_with_params(&json!({})));
        assert!(Method::ToolReload.wal_tracked_with_params(&json!({})));
    }

    #[test]
    fn video_start_respects_interrupts_but_teardown_and_artifact_reads_remain_available() {
        assert!(
            super::Method::ToolVideo
                .requires_interrupt_gate_with_params(&serde_json::json!({"action":"start"}))
        );
        for action in [
            "capabilities",
            "list",
            "status",
            "stop",
            "read",
            "exported",
            "discard",
        ] {
            assert!(
                !super::Method::ToolVideo
                    .requires_interrupt_gate_with_params(&serde_json::json!({"action": action}))
            );
        }
    }

    #[test]
    fn cancel_method_round_trips() {
        let method: Method = serde_json::from_value(json!("cancel")).unwrap();
        assert_eq!(method, Method::Cancel);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("cancel"));
    }

    #[test]
    fn console_method_round_trips() {
        let method: Method = serde_json::from_value(json!("tool.console")).unwrap();
        assert_eq!(method, Method::ToolConsole);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("tool.console"));
    }

    #[test]
    fn network_method_round_trips() {
        let method: Method = serde_json::from_value(json!("tool.network")).unwrap();
        assert_eq!(method, Method::ToolNetwork);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("tool.network"));
    }

    #[test]
    fn emulate_method_round_trips() {
        let method: Method = serde_json::from_value(json!("tool.emulate")).unwrap();
        assert_eq!(method, Method::ToolEmulate);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("tool.emulate"));
    }

    #[test]
    fn cancel_params_and_result_round_trip() {
        let params: CancelParams = serde_json::from_value(json!({ "rpc_id": "wait-1" })).unwrap();
        assert_eq!(params.rpc_id, "wait-1");
        let result = CancelResult { cancelled: true };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "cancelled": true })
        );
    }

    #[test]
    fn full_page_capture_is_input_but_export_reads_are_not() {
        assert!(Method::ToolScreenshotFullPage.requires_interrupt_gate());
        assert_eq!(
            Method::ToolScreenshotFullPage.effect(),
            MethodEffect::TransientInput
        );
        assert!(!Method::ToolScreenshot.requires_interrupt_gate());
        assert!(!Method::ToolScreenshotRead.requires_interrupt_gate());
        assert!(!Method::ToolScreenshotRelease.requires_interrupt_gate());
    }

    #[test]
    fn debug_network_writes_respect_interrupts_without_blocking_teardown() {
        for action in ["rule_add", "rule_enable", "replay"] {
            assert!(
                Method::ToolDebug
                    .requires_interrupt_gate_with_params(&serde_json::json!({"action":action}))
            );
        }
        for action in [
            "request",
            "rules",
            "export",
            "stop",
            "rule_disable",
            "rule_remove",
        ] {
            assert!(
                !Method::ToolDebug
                    .requires_interrupt_gate_with_params(&serde_json::json!({"action":action}))
            );
        }
    }

    #[test]
    fn is_mutating_classifies_read_only_tools_as_non_mutating() {
        assert!(!Method::ToolTabList.is_mutating());
        assert!(!Method::ToolSnapshot.is_mutating());
        assert!(!Method::ToolHover.is_mutating());
        assert!(!Method::ToolObserve.is_mutating());
        assert!(!Method::ToolGetHtml.is_mutating());
        assert!(!Method::ToolRead.is_mutating());
        assert_eq!(Method::ToolExtract.effect(), MethodEffect::PassiveRead);
        assert!(!Method::ToolExtract.is_mutating());
        assert!(!Method::ToolScreenshot.is_mutating());
        assert!(!Method::ToolConsole.is_mutating());
        assert!(!Method::ToolNetwork.is_mutating());
        assert!(!Method::ToolDialogStatus.is_mutating());
        assert!(!Method::ToolDialogDismiss.is_mutating());
        assert!(!Method::ToolOperationAwait.is_mutating());
        assert!(!Method::ToolOperationCancel.is_mutating());
        assert!(!Method::ToolWaitForNavigation.is_mutating());
        assert!(!Method::ToolWaitForElement.is_mutating());
        assert!(!Method::ToolWaitMs.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_mutating_tools_as_mutating() {
        assert!(Method::ToolTabCreate.is_mutating());
        assert!(Method::ToolTabClose.is_mutating());
        assert!(Method::ToolTabBorrow.is_mutating());
        assert!(Method::ToolTabReturn.is_mutating());
        assert!(Method::ToolTabSelect.is_mutating());
        assert!(Method::ToolNavigate.is_mutating());
        assert!(Method::ToolNavigateBack.is_mutating());
        assert!(Method::ToolNavigateForward.is_mutating());
        assert!(Method::ToolReload.is_mutating());
        assert!(Method::ToolClick.is_mutating());
        assert!(Method::ToolDrag.is_mutating());
        assert!(Method::ToolWheel.is_mutating());
        assert!(Method::ToolScrollTo.is_mutating());
        assert!(Method::ToolFocus.is_mutating());
        assert!(Method::ToolBlur.is_mutating());
        assert!(Method::ToolFill.is_mutating());
        assert!(Method::ToolPress.is_mutating());
        assert!(Method::ToolSelect.is_mutating());
        assert!(Method::ToolEvaluate.is_mutating());
        assert!(Method::ToolDialogAccept.is_mutating());
        assert!(Method::ToolRecordStart.is_mutating());
        assert!(Method::ToolWindowResize.is_mutating());
        assert!(Method::ToolEmulate.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_record_stop_await_as_non_mutating() {
        assert!(!Method::ToolRecordStop.is_mutating());
        assert!(!Method::ToolRecordAwait.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_session_lifecycle_as_non_mutating() {
        assert!(!Method::SessionStart.is_mutating());
        assert!(!Method::SessionStop.is_mutating());
        assert!(!Method::SessionStopAll.is_mutating());
        assert!(!Method::SessionList.is_mutating());
        assert!(!Method::SessionRunLog.is_mutating());
        assert!(!Method::ToolSessionStart.is_mutating());
        assert!(!Method::ToolSessionStop.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_system_methods_as_non_mutating() {
        assert!(!Method::SystemHandshake.is_mutating());
        assert!(!Method::SystemPing.is_mutating());
        assert!(!Method::SystemStatus.is_mutating());
        assert!(!Method::BrowserList.is_mutating());
        assert!(!Method::Cancel.is_mutating());
    }

    #[test]
    fn effect_classifies_observe_as_transient_input() {
        assert_eq!(Method::ToolSnapshot.effect(), MethodEffect::PassiveRead);
        assert_eq!(Method::ToolHover.effect(), MethodEffect::TransientInput);
        assert_eq!(Method::ToolObserve.effect(), MethodEffect::TransientInput);
        assert_eq!(Method::ToolClick.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolDrag.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolWheel.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolScrollTo.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolFocus.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolBlur.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::Cancel.effect(), MethodEffect::ControlPlane);
    }

    #[test]
    fn interrupt_gate_includes_transient_input() {
        assert!(!Method::ToolSnapshot.requires_interrupt_gate());
        assert!(Method::ToolHover.requires_interrupt_gate());
        assert!(Method::ToolObserve.requires_interrupt_gate());
        assert!(Method::ToolClick.requires_interrupt_gate());
        assert!(Method::ToolWheel.requires_interrupt_gate());
        assert!(Method::ToolScrollTo.requires_interrupt_gate());
        assert!(Method::ToolFocus.requires_interrupt_gate());
        assert!(Method::ToolBlur.requires_interrupt_gate());
        assert!(!Method::Cancel.requires_interrupt_gate());
    }

    #[test]
    fn every_method_uses_concrete_non_boolean_contracts() {
        let exported = crate::catalog::export();
        let input_defs = exported["schema"]["definitions"].as_object().unwrap();
        let output_defs = exported["output_schema"]["definitions"]
            .as_object()
            .unwrap();
        for method in exported["methods"].as_array().unwrap() {
            let wire = method["method"].as_str().unwrap();
            let params_name = method["params"].as_str().unwrap();
            let result_name = method["result"].as_str().unwrap();
            assert!(
                !input_defs[params_name].is_boolean(),
                "{wire} params ({params_name}) must not be an untyped boolean/Value schema"
            );
            assert!(
                !output_defs[result_name].is_boolean(),
                "{wire} result ({result_name}) must not be an untyped boolean/Value schema"
            );
        }

        fn collect_boolean_property_paths(
            node: &serde_json::Value,
            path: &str,
            out: &mut Vec<String>,
        ) {
            let Some(obj) = node.as_object() else {
                if let Some(arr) = node.as_array() {
                    for (idx, item) in arr.iter().enumerate() {
                        collect_boolean_property_paths(item, &format!("{path}[{idx}]"), out);
                    }
                }
                return;
            };
            if let Some(props) = obj.get("properties").and_then(|v| v.as_object()) {
                for (prop, sub) in props {
                    let next = format!("{path}.{prop}");
                    if sub.is_boolean() {
                        out.push(next);
                    } else {
                        collect_boolean_property_paths(sub, &next, out);
                    }
                }
            }
            for key in ["items", "anyOf", "oneOf", "allOf"] {
                if let Some(sub) = obj.get(key) {
                    collect_boolean_property_paths(sub, &format!("{path}.{key}"), out);
                }
            }
        }

        let expected_untyped = vec![
            "AuditEvent.data".to_string(),
            "DebugResult.capabilities".to_string(),
            "EvaluateResult.value".to_string(),
            "OperationAwaitResult.oneOf[0].result".to_string(),
            "RpcError.data".to_string(),
        ];

        let mut input_bool_props = Vec::new();
        for (name, def) in input_defs {
            collect_boolean_property_paths(def, name, &mut input_bool_props);
        }
        input_bool_props.sort();
        assert_eq!(
            input_bool_props, expected_untyped,
            "unexpected untyped boolean property schemas in input definitions"
        );

        let mut output_bool_props = Vec::new();
        for (name, def) in output_defs {
            collect_boolean_property_paths(def, name, &mut output_bool_props);
        }
        output_bool_props.sort();
        assert_eq!(
            output_bool_props, expected_untyped,
            "unexpected untyped boolean property schemas in output definitions"
        );
    }

    #[test]
    fn caller_action_metadata_policy_tracks_method_spec_and_dynamic_subactions() {
        assert_eq!(
            Method::ToolRead.caller_action_metadata_policy_with_params(None),
            ActionMetadataPolicy::ContextOnly
        );
        for passive in [
            Method::ToolSnapshot,
            Method::ToolGetHtml,
            Method::ToolExtract,
            Method::ToolScreenshot,
            Method::ToolConsole,
            Method::ToolNetwork,
            Method::ToolWaitForNavigation,
            Method::ToolWaitForElement,
        ] {
            assert_eq!(
                passive.caller_action_metadata_policy_with_params(None),
                ActionMetadataPolicy::None,
                "{} must reject caller-supplied action metadata",
                passive.wire_name()
            );
        }
        assert_eq!(
            Method::ToolObserve
                .caller_action_metadata_policy_with_params(Some(&json!({"probe_hover": false}))),
            ActionMetadataPolicy::None
        );
        assert_eq!(
            Method::ToolObserve
                .caller_action_metadata_policy_with_params(Some(&json!({"probe_hover": true}))),
            ActionMetadataPolicy::Full
        );
        assert_eq!(
            Method::ToolDebug
                .caller_action_metadata_policy_with_params(Some(&json!({"action": "request"}))),
            ActionMetadataPolicy::None
        );
        assert_eq!(
            Method::ToolDebug
                .caller_action_metadata_policy_with_params(Some(&json!({"action": "replay"}))),
            ActionMetadataPolicy::Full
        );
        assert_eq!(
            Method::ToolClick.caller_action_metadata_policy_with_params(None),
            ActionMetadataPolicy::Full
        );
        assert_eq!(
            Method::ToolUpload.caller_action_metadata_policy_with_params(None),
            ActionMetadataPolicy::Full
        );
        assert_eq!(
            Method::ToolDownload.caller_action_metadata_policy_with_params(None),
            ActionMetadataPolicy::Full
        );
    }
}
