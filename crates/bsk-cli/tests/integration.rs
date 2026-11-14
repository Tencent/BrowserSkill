//! Consolidated `bsk` CLI and daemon integration test harness.

#[path = "support/mod.rs"]
mod support;

#[cfg(unix)]
#[path = "integration/auto_spawn.rs"]
mod auto_spawn;
#[cfg(unix)]
#[path = "integration/daemon_discovery.rs"]
mod daemon_discovery;
#[cfg(unix)]
#[path = "integration/daemon_paths.rs"]
mod daemon_paths;
#[cfg(unix)]
#[path = "integration/detach_smoke.rs"]
mod detach_smoke;
#[cfg(unix)]
#[path = "integration/drag_protocol.rs"]
mod drag_protocol;
#[cfg(unix)]
#[path = "integration/foreground_smoke.rs"]
mod foreground_smoke;
#[cfg(unix)]
#[path = "integration/idle_exit.rs"]
mod idle_exit;
#[cfg(unix)]
#[path = "integration/ipc_client.rs"]
mod ipc_client;
#[cfg(unix)]
#[path = "integration/logs_cmd.rs"]
mod logs_cmd;
#[cfg(unix)]
#[path = "integration/plan_cli.rs"]
mod plan_cli;
#[cfg(unix)]
#[path = "integration/recipe_cli.rs"]
mod recipe_cli;
#[cfg(unix)]
#[path = "integration/status_cmd.rs"]
mod status_cmd;
#[cfg(unix)]
#[path = "integration/step_cancel.rs"]
mod step_cancel;
#[cfg(unix)]
#[path = "integration/target_control_cli.rs"]
mod target_control_cli;
#[cfg(unix)]
#[path = "integration/wave2_ssot_mcp_e2e.rs"]
mod wave2_ssot_mcp_e2e;
#[cfg(unix)]
#[path = "integration/wave2_zero_ceremony_lifecycle.rs"]
mod wave2_zero_ceremony_lifecycle;

#[path = "integration/audit_ws.rs"]
mod audit_ws;
#[path = "integration/auto_update_policy.rs"]
mod auto_update_policy;
#[path = "integration/browser_list_ordering.rs"]
mod browser_list_ordering;
#[path = "integration/browser_liveness.rs"]
mod browser_liveness;
#[path = "integration/cancel_forwarding.rs"]
mod cancel_forwarding;
#[path = "integration/cli_parse.rs"]
mod cli_parse;
#[path = "integration/cli_usage_errors.rs"]
mod cli_usage_errors;
#[path = "integration/dialog_control.rs"]
mod dialog_control;
#[path = "integration/handshake_compat.rs"]
mod handshake_compat;
#[path = "integration/install_skill.rs"]
mod install_skill;
#[path = "integration/interaction_preferences.rs"]
mod interaction_preferences;
#[path = "integration/local_auth_ws.rs"]
mod local_auth_ws;
#[path = "integration/local_pairing_maintenance.rs"]
mod local_pairing_maintenance;
#[path = "integration/per_session_queue.rs"]
mod per_session_queue;
#[path = "integration/record_export_recovery.rs"]
mod record_export_recovery;
#[path = "integration/record_stop_retry.rs"]
mod record_stop_retry;
#[path = "integration/remote_server.rs"]
mod remote_server;
#[path = "integration/session_user_interrupt.rs"]
mod session_user_interrupt;
#[path = "integration/sessions_ipc.rs"]
mod sessions_ipc;
#[path = "integration/skill_install_legacy.rs"]
mod skill_install_legacy;
#[path = "integration/step_view.rs"]
mod step_view;
#[path = "integration/tools_ipc.rs"]
mod tools_ipc;
#[path = "integration/tools_m7_ipc.rs"]
mod tools_m7_ipc;
#[path = "integration/tools_m8_ipc.rs"]
mod tools_m8_ipc;
#[path = "integration/tools_m9_ipc.rs"]
mod tools_m9_ipc;
#[path = "integration/ws_handshake.rs"]
mod ws_handshake;
