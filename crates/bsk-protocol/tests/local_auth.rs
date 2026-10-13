use bsk_protocol::local_auth::*;
use serde_json::{Value, json};

fn vector() -> Value {
    serde_json::from_str(include_str!("fixtures/local-auth-v1.json")).unwrap()
}
fn bytes<const N: usize>(v: &Value, name: &str) -> Bytes<N> {
    Bytes::decode(v[name].as_str().unwrap()).unwrap()
}
fn transcript(v: &Value, recovery: bool) -> Vec<u8> {
    Transcript {
        daemon_id: &bytes(v, "daemon_id"),
        device_id: &bytes(v, "device_id"),
        r#gen: u32::from(recovery),
        instance_id: v["instance_id"].as_str().unwrap(),
        origin: v["origin"].as_str().unwrap(),
        client_nonce: &bytes(
            v,
            if recovery {
                "recovery_client_nonce"
            } else {
                "client_nonce"
            },
        ),
        server_nonce: &bytes(
            v,
            if recovery {
                "recovery_server_nonce"
            } else {
                "server_nonce"
            },
        ),
    }
    .encode()
}

#[test]
fn l22_shared_vectors_and_l08b_saved_candidate_recovery() {
    let v = vector();
    let t = transcript(&v, false);
    let key = bytes(&v, "key");
    let txn = bytes(&v, "txn");
    for (purpose, name) in [(Purpose::Server, "server"), (Purpose::Client, "client")] {
        assert_eq!(prove(&key, purpose, &t, None), bytes(&v, name));
    }
    let candidate = prove(&key, Purpose::Rotate, &t, Some(&txn));
    assert_eq!(candidate, bytes(&v, "candidate"));
    for (purpose, name) in [
        (Purpose::Confirm, "confirm"),
        (Purpose::Committed, "committed"),
    ] {
        assert_eq!(prove(&candidate, purpose, &t, Some(&txn)), bytes(&v, name));
    }
    let recovery = transcript(&v, true);
    assert_eq!(
        prove(&candidate, Purpose::Committed, &recovery, Some(&txn)),
        bytes(&v, "commit_proof")
    );
    let rederived = prove(&key, Purpose::Rotate, &recovery, Some(&txn));
    assert!(!verify(
        &rederived,
        Purpose::Committed,
        &recovery,
        Some(&txn),
        &bytes(&v, "commit_proof")
    ));
}

#[test]
fn l06_proofs_cannot_be_reflected_or_replayed() {
    let v = vector();
    let t = transcript(&v, false);
    let key = bytes(&v, "key");
    let txn = bytes(&v, "txn");
    let purposes = [
        Purpose::Server,
        Purpose::Client,
        Purpose::Confirm,
        Purpose::Committed,
    ];
    for (i, purpose) in purposes.iter().enumerate() {
        let transaction = (i > 1).then_some(&txn);
        let proof = prove(&key, *purpose, &t, transaction);
        assert!(verify(&key, *purpose, &t, transaction, &proof));
        for (j, other) in purposes.iter().enumerate() {
            if i != j {
                assert!(!verify(&key, *other, &t, (j > 1).then_some(&txn), &proof));
            }
        }
        assert!(!verify(
            &key,
            *purpose,
            &transcript(&v, true),
            transaction,
            &proof
        ));
    }
}

#[test]
fn l15_rejects_duplicate_unknown_oversized_and_invalid_fields() {
    let v = vector();
    let valid = json!({"type":"local.auth.prove", "v":1, "client_proof": v["client"]}).to_string();
    assert!(AuthMessage::parse(&valid).is_ok());
    for text in [
        valid.replace("\"v\":1", "\"v\":1,\"v\":1"),
        valid.replace("\"v\":1", "\"v\":1,\"extra\":true"),
        valid.replace("\"v\":1", "\"v\":2"),
        format!("{valid}{}", " ".repeat(MAX_MESSAGE_BYTES)),
    ] {
        assert!(AuthMessage::parse(&text).is_err());
    }
    let pending = json!({"gen":1,"txn":v["txn"]});
    let ready = json!({"type":"local.auth.ready","v":1,"rotation":pending,"commit":{"gen":1,"txn":v["txn"],"proof":v["committed"]}});
    assert!(AuthMessage::parse(&ready.to_string()).is_err());
    for bad in [
        format!("{}=", v["key"].as_str().unwrap()),
        "a".repeat(43),
        "!".repeat(43),
    ] {
        assert!(Bytes::<32>::decode(&bad).is_err());
    }
    assert_eq!(format!("{:?}", bytes::<32>(&v, "key")), "[redacted]");
}

#[test]
fn l15_probe_limits_apply_before_any_business_handshake() {
    let v = vector();
    let mut probe = json!({"id":"probe", "method":"system.ping", "params":{"local_auth":{"v":1,"client_nonce":v["client_nonce"],"instance_id":"a1b2c3d4","credentials":[]}}});
    assert!(Probe::parse(&probe.to_string()).is_ok());
    let credential = json!({"role":"active","device_id":v["device_id"],"gen":0,"pending":null});
    probe["params"]["local_auth"]["credentials"] = json!([credential.clone(), credential]);
    assert!(Probe::parse(&probe.to_string()).is_err());
    probe["params"]["local_auth"]["credentials"] = json!([]);
    probe["params"]["local_auth"]["extra"] = json!(true);
    assert!(Probe::parse(&probe.to_string()).is_err());
}
