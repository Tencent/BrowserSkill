//! Pairing state. Mutations publish one snapshot before changing memory.

use anyhow::{Result, bail, ensure};
use bsk_protocol::local_auth::{Bytes, Credential, CredentialRole, RejectionReason, Rotation};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub fn random<const N: usize>() -> Bytes<N> {
    let mut value = [0; N];
    OsRng.fill_bytes(&mut value);
    Bytes(value)
}
pub fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}
fn date(value: i64) -> String {
    OffsetDateTime::from_unix_timestamp(value)
        .unwrap()
        .format(&Rfc3339)
        .unwrap()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Unactivated,
    Active,
    Revoked,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub txn: Bytes<16>,
    pub r#gen: u32,
    pub key: Bytes<32>,
    #[serde(with = "timestamp")]
    pub created_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub status: DeviceStatus,
    pub browser_id: Option<String>,
    pub label: String,
    pub key: Bytes<32>,
    pub r#gen: u32,
    pub pending: Option<Pending>,
    pub replaces: Option<String>,
    #[serde(with = "optional_timestamp")]
    pub activated_at: Option<i64>,
    #[serde(with = "optional_timestamp")]
    pub expires_at: Option<i64>,
    pub rotate_requested: bool,
}
impl Device {
    pub fn valid(&self) -> bool {
        self.status != DeviceStatus::Revoked && self.expires_at.is_none_or(|expiry| expiry > now())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    daemon_id: Bytes<16>,
    devices: BTreeMap<String, Device>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            daemon_id: random(),
            devices: BTreeMap::new(),
        }
    }
}
pub struct PairingStore {
    path: Option<PathBuf>,
    state: Mutex<State>,
    changed: tokio::sync::watch::Sender<()>,
}
impl std::fmt::Debug for PairingStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingStore").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceSummary {
    pub kind: &'static str,
    pub device_id: String,
    pub browser_id: Option<String>,
    pub label: String,
    pub status: DeviceStatus,
    pub activated_at: Option<String>,
    pub expires_at: Option<String>,
    pub r#gen: u32,
}
#[derive(Debug, Clone)]
pub struct Selection {
    pub device_id: Bytes<16>,
    pub device: Device,
    pub key: Bytes<32>,
    pub r#gen: u32,
    pub commit: Option<Rotation>,
}
#[derive(Debug, thiserror::Error)]
#[error("pairing activation rejected")]
pub struct ActivationRejected {
    pub reason: RejectionReason,
    pub browser_id: String,
}

impl PairingStore {
    /// Production callers must already own daemon.lock, including maintenance.
    pub fn open(home: &Path) -> Result<Self> {
        let path = home.join("local-pairings.json");
        let state = super::super::json_store::transaction(&path, true, |state: &mut State| {
            ensure!(
                state.version == 1,
                "unsupported local pairing store version"
            );
            Ok(state.clone())
        })?;
        Ok(Self {
            path: Some(path),
            state: Mutex::new(state),
            changed: tokio::sync::watch::channel(()).0,
        })
    }
    pub fn memory() -> Self {
        Self {
            path: None,
            state: Mutex::new(State::default()),
            changed: tokio::sync::watch::channel(()).0,
        }
    }
    fn update<T>(&self, work: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let mut current = self.state.lock().expect("local pairing store poisoned");
        let mut next = current.clone();
        let result = work(&mut next)?;
        if let Some(path) = &self.path {
            super::super::json_store::transaction(path, true, |disk: &mut State| {
                ensure!(
                    disk.version == 1 && disk.daemon_id == next.daemon_id,
                    "local pairing store changed"
                );
                *disk = next.clone();
                Ok(())
            })?;
        }
        *current = next;
        drop(current);
        self.changed.send_replace(());
        Ok(result)
    }
    pub(crate) fn changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.changed.subscribe()
    }
    pub fn daemon_id(&self) -> Bytes<16> {
        self.state.lock().unwrap().daemon_id
    }
    pub fn device(&self, id: &str) -> Option<Device> {
        self.state.lock().unwrap().devices.get(id).cloned()
    }
    pub fn pair(&self, port: u16, replaces: Option<&str>) -> Result<String> {
        self.update(|state| {
            let replaced = replaces.map(|id| resolve(state, id)).transpose()?;
            if let Some(id) = &replaced {
                ensure!(
                    state.devices[id].status == DeviceStatus::Active,
                    "replacement target is not active"
                );
            }
            state
                .devices
                .retain(|_, device| device.status != DeviceStatus::Unactivated || device.valid());
            ensure!(
                state
                    .devices
                    .values()
                    .filter(|d| d.status == DeviceStatus::Unactivated)
                    .count()
                    < 16,
                "too many outstanding pairing links; wait five minutes"
            );
            let id = random::<16>();
            let key = random::<32>();
            state.devices.insert(
                id.encode(),
                Device {
                    status: DeviceStatus::Unactivated,
                    browser_id: None,
                    label: String::new(),
                    key,
                    r#gen: 0,
                    pending: None,
                    replaces: replaced,
                    activated_at: None,
                    expires_at: Some(now() + 300),
                    rotate_requested: false,
                },
            );
            Ok(format!(
                "ws://127.0.0.1:{port}/#bsk-local.v1.{}.{}.{}",
                state.daemon_id.encode(),
                id.encode(),
                key.encode()
            ))
        })
    }
    pub fn devices(&self) -> Vec<DeviceSummary> {
        self.state
            .lock()
            .unwrap()
            .devices
            .iter()
            .map(|(id, d)| DeviceSummary {
                kind: "local",
                device_id: id.clone(),
                browser_id: d.browser_id.clone(),
                label: d.label.clone(),
                status: d.status,
                activated_at: d.activated_at.map(date),
                expires_at: d.expires_at.map(date),
                r#gen: d.r#gen,
            })
            .collect()
    }
    pub fn resolve(&self, id: &str) -> Result<String> {
        resolve(&self.state.lock().unwrap(), id)
    }
    pub fn revoke(&self, id: Option<&str>) -> Result<Vec<String>> {
        self.update(|state| {
            let ids = match id {
                Some(id) => vec![resolve(state, id)?],
                None => state.devices.keys().cloned().collect(),
            };
            for id in &ids {
                let d = state.devices.get_mut(id).unwrap();
                d.status = DeviceStatus::Revoked;
                d.pending = None;
                d.key = Bytes([0; 32]);
            }
            Ok(ids)
        })
    }
    pub fn request_rotation(&self, id: &str) -> Result<()> {
        self.update(|state| {
            let id = resolve(state, id)?;
            let d = state.devices.get_mut(&id).unwrap();
            ensure!(d.status == DeviceStatus::Active, "device is not active");
            d.rotate_requested = true;
            Ok(())
        })
    }
    pub fn select(&self, offers: &[Credential]) -> Option<Selection> {
        let state = self.state.lock().unwrap();
        for (role, status) in [
            (CredentialRole::Staged, DeviceStatus::Active),
            (CredentialRole::Active, DeviceStatus::Active),
            (CredentialRole::Staged, DeviceStatus::Unactivated),
        ] {
            for offer in offers.iter().filter(|offer| offer.role == role) {
                let Some(d) = state
                    .devices
                    .get(&offer.device_id.encode())
                    .filter(|d| d.valid() && d.status == status)
                else {
                    continue;
                };
                let (key, r#gen, commit) = if let Some(p) = &offer.pending {
                    if let Some(saved) = d
                        .pending
                        .as_ref()
                        .filter(|saved| saved.txn == p.txn && saved.r#gen == p.r#gen)
                    {
                        (saved.key, saved.r#gen, Some(p.clone()))
                    } else if d.r#gen == p.r#gen {
                        (d.key, d.r#gen, Some(p.clone()))
                    } else if d.r#gen == offer.r#gen {
                        (d.key, d.r#gen, None)
                    } else {
                        continue;
                    }
                } else if d.r#gen == offer.r#gen {
                    (d.key, d.r#gen, None)
                } else {
                    continue;
                };
                return Some(Selection {
                    device_id: offer.device_id,
                    device: d.clone(),
                    key,
                    r#gen,
                    commit,
                });
            }
        }
        None
    }
    /// Call only after the client proof authenticates instance_id.
    pub fn check_activation(&self, id: &str, instance: &str) -> Result<()> {
        check_activation(&self.state.lock().unwrap(), id, instance)
    }
    pub fn stage_rotation(
        &self,
        id: &str,
        expected_gen: u32,
        expected_txn: Option<Bytes<16>>,
        pending: Pending,
        instance: &str,
    ) -> Result<()> {
        self.update(|state| {
            check_activation(state, id, instance)?;
            let d = state.devices.get_mut(id).unwrap();
            ensure!(
                d.r#gen == expected_gen
                    && d.pending.as_ref().map(|p| p.txn) == expected_txn
                    && d.r#gen.checked_add(1) == Some(pending.r#gen),
                "stale rotation"
            );
            d.pending = Some(pending);
            Ok(())
        })
    }
    /// Activation and replacement are one durable transaction. Returns the old
    /// device ID so the lifecycle layer can close its connection before replying.
    pub fn commit(&self, id: &str, txn: Bytes<16>, instance: &str) -> Result<Option<String>> {
        self.update(|state| {
            check_activation(state, id, instance)?;
            let device = state.devices.get_mut(id).unwrap();
            let pending = device
                .pending
                .take()
                .filter(|p| p.txn == txn)
                .ok_or_else(|| anyhow::anyhow!("stale rotation"))?;
            device.key = pending.key;
            device.r#gen = pending.r#gen;
            device.rotate_requested = false;
            device.status = DeviceStatus::Active;
            device.expires_at = None;
            device.activated_at.get_or_insert(now());
            device.browser_id = Some(instance.into());
            let replaced = device.replaces.take();
            if let Some(old) = &replaced {
                let old = state.devices.get_mut(old).unwrap();
                old.status = DeviceStatus::Revoked;
                old.key = Bytes([0; 32]);
                old.pending = None;
            }
            Ok(replaced)
        })
    }
}
fn resolve(state: &State, id: &str) -> Result<String> {
    if state.devices.contains_key(id) {
        return Ok(id.into());
    }
    state
        .devices
        .iter()
        .find(|(_, d)| d.status == DeviceStatus::Active && d.browser_id.as_deref() == Some(id))
        .map(|(id, _)| id.clone())
        .ok_or_else(|| anyhow::anyhow!("local device not found"))
}
fn check_activation(state: &State, id: &str, instance: &str) -> Result<()> {
    let d = state
        .devices
        .get(id)
        .filter(|d| d.valid())
        .ok_or_else(|| anyhow::anyhow!("local authorization ended"))?;
    if d.status == DeviceStatus::Active {
        ensure!(
            d.browser_id.as_deref() == Some(instance),
            "browser identity mismatch"
        );
        return Ok(());
    }
    if let Some(target) = &d.replaces {
        let old = state
            .devices
            .get(target)
            .filter(|d| d.status == DeviceStatus::Active)
            .ok_or_else(|| anyhow::anyhow!("replacement target is no longer active"))?;
        if old.browser_id.as_deref() != Some(instance) {
            bail!(ActivationRejected {
                reason: RejectionReason::ReplaceMismatch,
                browser_id: old.browser_id.clone().unwrap_or_default()
            });
        }
    } else if state
        .devices
        .values()
        .any(|d| d.status == DeviceStatus::Active && d.browser_id.as_deref() == Some(instance))
    {
        bail!(ActivationRejected {
            reason: RejectionReason::AlreadyPaired,
            browser_id: instance.into()
        });
    }
    Ok(())
}

mod timestamp {
    use super::*;
    pub fn serialize<S: serde::Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        date(*value).serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let value = String::deserialize(deserializer)?;
        OffsetDateTime::parse(&value, &Rfc3339)
            .map(|v| v.unix_timestamp())
            .map_err(serde::de::Error::custom)
    }
}
mod optional_timestamp {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Option<i64>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value.map(date).serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<i64>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|value| {
                OffsetDateTime::parse(&value, &Rfc3339)
                    .map(|v| v.unix_timestamp())
                    .map_err(serde::de::Error::custom)
            })
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pairing(store: &PairingStore, replace: Option<&str>) -> (String, Bytes<32>) {
        let link = store.pair(52800, replace).unwrap();
        let parts: Vec<_> = link.split('.').collect();
        (
            parts[parts.len() - 2].into(),
            Bytes::decode(parts[parts.len() - 1]).unwrap(),
        )
    }
    fn activate(store: &PairingStore, id: &str, instance: &str) -> Bytes<32> {
        let pending = Pending {
            txn: random(),
            r#gen: 1,
            key: random(),
            created_at: now(),
        };
        store
            .stage_rotation(id, 0, None, pending.clone(), instance)
            .unwrap();
        store.commit(id, pending.txn, instance).unwrap();
        pending.key
    }
    #[test]
    fn pending_limits_expiry_and_redaction() {
        let home = tempfile::tempdir().unwrap();
        let store = PairingStore::open(home.path()).unwrap();
        let (id, key) = pairing(&store, None);
        for _ in 1..16 {
            pairing(&store, None);
        }
        assert!(store.pair(52800, None).is_err());
        store
            .update(|s| {
                s.devices.get_mut(&id).unwrap().expires_at = Some(now() - 1);
                Ok(())
            })
            .unwrap();
        pairing(&store, None);
        assert!(store.device(&id).is_none());
        let summaries = serde_json::to_string(&store.devices()).unwrap();
        assert!(!summaries.contains(&key.encode()));
        assert!(!format!("{store:?}").contains(&key.encode()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(home.path().join("local-pairings.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn l14_atomic_replacement_and_rejected_attempts_preserve_the_original() {
        let home = tempfile::tempdir().unwrap();
        let store = PairingStore::open(home.path()).unwrap();
        let (original, _) = pairing(&store, None);
        activate(&store, &original, "a1b2c3d4");
        let (duplicate, _) = pairing(&store, None);
        let before = std::fs::read(home.path().join("local-pairings.json")).unwrap();
        let error = store.check_activation(&duplicate, "a1b2c3d4").unwrap_err();
        assert_eq!(
            error.downcast_ref::<ActivationRejected>().unwrap().reason,
            RejectionReason::AlreadyPaired
        );
        assert_eq!(
            before,
            std::fs::read(home.path().join("local-pairings.json")).unwrap()
        );
        let (replacement, _) = pairing(&store, Some("a1b2c3d4"));
        let error = store
            .check_activation(&replacement, "12345678")
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<ActivationRejected>().unwrap().reason,
            RejectionReason::ReplaceMismatch
        );
        assert_eq!(
            store.device(&original).unwrap().status,
            DeviceStatus::Active
        );
        activate(&store, &replacement, "a1b2c3d4");
        let reopened = PairingStore::open(home.path()).unwrap();
        assert_eq!(
            reopened.device(&original).unwrap().status,
            DeviceStatus::Revoked
        );
        assert_eq!(reopened.resolve("a1b2c3d4").unwrap(), replacement);
        assert!(reopened.device(&replacement).unwrap().expires_at.is_none());
    }
    #[test]
    fn l08_l09_recovery_selection_and_stale_transactions() {
        let store = PairingStore::memory();
        let (id, _) = pairing(&store, None);
        let pending = Pending {
            txn: random(),
            r#gen: 1,
            key: random(),
            created_at: now(),
        };
        let mut offer = Credential {
            role: CredentialRole::Staged,
            device_id: Bytes::decode(&id).unwrap(),
            r#gen: 0,
            pending: None,
        };
        store
            .stage_rotation(&id, 0, None, pending.clone(), "a1b2c3d4")
            .unwrap();
        assert_eq!(store.select(&[offer.clone()]).unwrap().r#gen, 0);
        offer.pending = Some(Rotation {
            txn: pending.txn,
            r#gen: 1,
        });
        let selection = store.select(&[offer.clone()]).unwrap();
        assert_eq!(selection.key, pending.key);
        assert!(store.commit(&id, random(), "a1b2c3d4").is_err());
        assert!(
            store
                .stage_rotation(&id, 0, None, pending.clone(), "a1b2c3d4")
                .is_err()
        );
        store.commit(&id, pending.txn, "a1b2c3d4").unwrap();
        let recovered = store.select(&[offer]).unwrap();
        assert_eq!(recovered.key, pending.key);
        assert_eq!(recovered.commit.unwrap().txn, pending.txn);
        store.revoke(Some(&id)).unwrap();
        assert!(store.commit(&id, pending.txn, "a1b2c3d4").is_err());
    }
    #[test]
    fn l14b_l14c_staged_selection_does_not_interrupt_active_until_commit() {
        let store = PairingStore::memory();
        let (old, _) = pairing(&store, None);
        activate(&store, &old, "a1b2c3d4");
        let (new, _) = pairing(&store, Some(&old));
        let active = Credential {
            role: CredentialRole::Active,
            device_id: Bytes::decode(&old).unwrap(),
            r#gen: 1,
            pending: None,
        };
        let pending = Pending {
            txn: random(),
            r#gen: 1,
            key: random(),
            created_at: now(),
        };
        store
            .stage_rotation(&new, 0, None, pending.clone(), "a1b2c3d4")
            .unwrap();
        let staged = Credential {
            role: CredentialRole::Staged,
            device_id: Bytes::decode(&new).unwrap(),
            r#gen: 0,
            pending: Some(Rotation {
                txn: pending.txn,
                r#gen: 1,
            }),
        };
        let offers = [active, staged];
        assert_eq!(store.select(&offers).unwrap().device_id.encode(), old);
        store.commit(&new, pending.txn, "a1b2c3d4").unwrap();
        assert_eq!(store.select(&offers).unwrap().device_id.encode(), new);
    }
    #[test]
    fn failed_durable_write_does_not_publish_a_memory_commit() {
        let home = tempfile::tempdir().unwrap();
        let store = PairingStore::open(home.path()).unwrap();
        let (id, key) = pairing(&store, None);
        let pending = Pending {
            txn: random(),
            r#gen: 1,
            key: random(),
            created_at: now(),
        };
        store
            .stage_rotation(&id, 0, None, pending.clone(), "a1b2c3d4")
            .unwrap();
        std::fs::remove_file(home.path().join("local-pairings.json")).unwrap();
        std::fs::create_dir(home.path().join("local-pairings.json")).unwrap();
        assert!(store.commit(&id, pending.txn, "a1b2c3d4").is_err());
        let d = store.device(&id).unwrap();
        assert_eq!(d.key, key);
        assert_eq!(d.status, DeviceStatus::Unactivated);
        assert!(d.pending.is_some());
    }
}
