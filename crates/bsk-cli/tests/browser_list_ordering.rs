//! Review I1: `browser.list` and `multiple_browsers_online.error.data
//! .browsers` must agree on order. Both surfaces now route through
//! `snapshot_status_entries(...)` which sorts by `connected_at_ms`
//! ascending with `instance_id` as a deterministic tiebreaker.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk::daemon::browsers::{
    BrowserClient, BrowserId, BrowserSink, Pending, next_browser_generation,
};
use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::BrowserStatusEntry;
use bsk_protocol::{ErrorCode, Method};
use rand::Rng;
use serde::Deserialize;
use tokio::sync::mpsc;

fn tempfile_path(prefix: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let mut rng = rand::thread_rng();
    let suffix: String = (0..8)
        .map(|_| char::from_digit(rng.gen_range(0..16), 16).unwrap())
        .collect();
    p.push(format!("{prefix}-{}-{suffix}.sock", std::process::id()));
    p
}

async fn spawn_daemon() -> (daemon::DaemonHandle, PathBuf) {
    let port = 0;

    let config = DaemonConfig::new(port);
    let sock = tempfile_path("bsk-test-browser-list");
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    (handle, sock)
}

fn fake_client(id: &str, label: &str, connected_at_ms: i64) -> Arc<BrowserClient> {
    let (tx, _rx) = mpsc::unbounded_channel::<bsk_protocol::Frame>();
    Arc::new(BrowserClient {
        id: BrowserId(id.into()),
        browser_name: "chrome".into(),
        browser_version: "131.0".into(),
        extension_version: "0.1.0-dev.0".into(),
        extension_protocol_version: "1.0".into(),
        label: label.into(),
        sink: BrowserSink { tx },
        pending: Mutex::new(Pending::default()),
        generation: next_browser_generation(),
        connected_at_ms,
        version_skew: false,
    })
}

#[derive(Debug, Deserialize)]
struct ListReply {
    browsers: Vec<BrowserStatusEntry>,
}

#[tokio::test]
async fn browser_list_and_multiple_browsers_error_share_stable_ordering() {
    // We inject three clients into the registry in *reverse* order of
    // their `connected_at_ms`. The `BrowserRegistry` itself is a
    // HashMap so insert order is not enough to guarantee anything;
    // before review I1, `browser.list` returned the HashMap snapshot
    // order (essentially random), while `multiple_browsers_online`
    // already sorted via `snapshot_status_entries`. The two surfaces
    // could (and did) diverge.
    let (handle, sock) = spawn_daemon().await;
    let state = handle.state();
    state.browsers.insert(fake_client("zeta", "Zeta", 3_000));
    state.browsers.insert(fake_client("alpha", "Alpha", 1_000));
    state.browsers.insert(fake_client("mu", "Mu", 2_000));

    let mut ipc = IpcClient::connect(&sock).await.unwrap();

    // 1. `browser.list` must come back sorted by `connected_at_ms`.
    let list: ListReply = ipc
        .call::<(), _>(
            "browser-list-1",
            Method::BrowserList,
            None,
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .expect("browser.list rpc succeeded");
    let list_ids: Vec<String> = list
        .browsers
        .iter()
        .map(|b| b.instance_id.clone())
        .collect();
    assert_eq!(
        list_ids,
        vec!["alpha".to_string(), "mu".to_string(), "zeta".to_string()],
        "browser.list must sort by connected_at_ms ascending (review I1)"
    );

    // 2. The `multiple_browsers_online` error data carries the same
    //    list in the same order.
    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    let outcome = ipc
        .call::<_, serde_json::Value>(
            "sess-start-multi",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    let err = outcome.expect_err("session.start must fail when many browsers are online");
    assert_eq!(err.code, ErrorCode::MultipleBrowsersOnline);
    let data = err.data.expect("multiple_browsers_online must carry data");
    let browsers = data
        .get("browsers")
        .and_then(|v| v.as_array())
        .expect("data.browsers is an array");
    let err_ids: Vec<String> = browsers
        .iter()
        .filter_map(|item| {
            item.get("instance_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        err_ids, list_ids,
        "multiple_browsers_online and browser.list must agree on order (review I1)"
    );

    handle.shutdown().await;
}
