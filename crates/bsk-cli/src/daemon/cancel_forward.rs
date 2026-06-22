//! Push a per-RPC `cancel` request frame to the WS sink owned by a
//! browser. Shared between the IPC `cancel` handler (`daemon::ipc`)
//! and the WS `session.user_interrupt` event handler (`daemon::ws`),
//! which both need to translate a daemon-side cancel decision into
//! the line-protocol frame the extension's dispatcher listens for.

use std::sync::Arc;

use bsk_protocol::{Frame, Method, RequestFrame, RpcId};

use super::browsers::BrowserId;
use super::state::DaemonState;

/// Send `cancel { rpc_id }` to the browser identified by `browser_id`.
/// Returns an error when the matching browser has disconnected or its
/// sink is already closed; the caller decides how to surface that to
/// its own peer (IPC side maps to a warning + `Ok(false)` for the
/// outer `cancel` RPC; WS side just logs).
pub(super) fn forward_cancel_to_browser(
    state: &Arc<DaemonState>,
    browser_id: &BrowserId,
    ws_rpc_id: &RpcId,
) -> anyhow::Result<()> {
    let Some(client) = state.browsers.get(browser_id) else {
        anyhow::bail!("owning browser is no longer connected");
    };
    let cancel_id = format!("cancel-{ws_rpc_id}");
    let request = RequestFrame {
        id: cancel_id,
        method: Method::Cancel,
        params: Some(serde_json::json!({ "rpc_id": ws_rpc_id })),
    };
    client
        .sink
        .send(Frame::Request(request))
        .map_err(|err| anyhow::anyhow!("browser sink closed: {err:?}"))?;
    Ok(())
}
