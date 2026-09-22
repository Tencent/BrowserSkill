//! Device grants stored as hashes, with atomic writes shared by CLI and server.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use fs2::FileExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::ServerConfig;

#[derive(Debug, Clone)]
pub struct AuthorizationStore {
    path: PathBuf,
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    version: u32,
    public_url: String,
    pairing_ttl: u64,
    device_ttl: u64,
    renew_after: u64,
    pairings: BTreeMap<String, i64>,
    devices: BTreeMap<String, Device>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    browser_id: String,
    token_hash: String,
    previous_hash: Option<String>,
    label: String,
    expires_at: i64,
    renew_after: i64,
}

#[derive(Debug, Serialize)]
pub struct DeviceSummary {
    pub device_id: String,
    pub browser_id: String,
    pub label: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthorizationResponse {
    pub device_id: String,
    pub expires_at: String,
    pub renew_after: String,
    pub service_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationRequest {
    pub action: String,
    pub next_token: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct AuthorizedDevice {
    pub device_id: String,
    pub browser_id: String,
}

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}
fn date(timestamp: i64) -> String {
    OffsetDateTime::from_unix_timestamp(timestamp)
        .expect("bounded device expiry")
        .format(&Rfc3339)
        .expect("RFC3339 timestamp")
}
fn hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}
pub fn valid_token(token: &str) -> bool {
    (32..=256).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

impl AuthorizationStore {
    pub fn at_home(home: &Path) -> Self {
        Self {
            path: home.join("remote-authorization.json"),
        }
    }

    fn transaction<T>(&self, write: bool, work: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        // Writers publish complete snapshots using atomic replacement. Readers
        // can safely open either snapshot without contending with durable writes.
        if !write {
            return work(&mut self.read_state()?);
        }
        let parent = self
            .path
            .parent()
            .context("authorization directory missing")?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.path.with_extension("lock"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            lock.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        // All callers, including blocking tasks cancelled by a disconnected
        // client, must eventually release their thread rather than wait forever.
        let deadline = Instant::now() + Duration::from_millis(500);
        loop {
            match FileExt::try_lock_exclusive(&lock) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(error).context("authorization store is busy");
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        }
        let mut state = self.read_state()?;
        let result = work(&mut state)?;
        state.version = 1;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(file.as_file_mut(), &state)?;
        file.as_file_mut().flush()?;
        file.as_file().sync_all()?;
        file.persist(&self.path).map_err(|err| err.error)?;
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(result)
    }

    fn read_state(&self) -> Result<State> {
        let state: State = match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("invalid authorization store")?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(err) => return Err(err.into()),
        };
        ensure!(
            state.version <= 1,
            "unsupported authorization store version"
        );
        Ok(state)
    }

    pub fn configure(&self, config: &ServerConfig) -> Result<()> {
        config.validate()?;
        self.transaction(true, |state| {
            ensure!(
                state.public_url.is_empty()
                    || state.public_url == config.public_url
                    || (state.devices.is_empty() && state.pairings.is_empty()),
                "revoke existing grants before changing --public-url"
            );
            state.public_url = config.public_url.clone();
            state.pairing_ttl = config.pairing_ttl.as_secs();
            state.device_ttl = config.device_ttl.as_secs();
            state.renew_after = config.renew_after.as_secs();
            Ok(())
        })
    }

    pub fn pair(&self) -> Result<String> {
        self.transaction(true, |state| {
            ensure!(
                !state.public_url.is_empty(),
                "start `bsk daemon start --mode server` before generating a pairing link"
            );
            state.pairings.retain(|_, expiry| *expiry > now());
            ensure!(
                state.pairings.len() < 100,
                "too many outstanding pairing links"
            );
            let credential = token();
            state
                .pairings
                .insert(hash(&credential), now() + state.pairing_ttl as i64);
            Ok(format!("{}#{credential}", state.public_url))
        })
    }

    pub fn devices(&self) -> Result<Vec<DeviceSummary>> {
        self.transaction(false, |state| {
            Ok(state
                .devices
                .iter()
                .map(|(id, device)| DeviceSummary {
                    device_id: id.clone(),
                    browser_id: device.browser_id.clone(),
                    label: device.label.clone(),
                    expires_at: date(device.expires_at),
                })
                .collect())
        })
    }

    pub fn revoke(&self, device_id: &str) -> Result<bool> {
        self.transaction(true, |state| Ok(state.devices.remove(device_id).is_some()))
    }

    pub fn revoke_all(&self) -> Result<()> {
        self.transaction(true, |state| {
            state.devices.clear();
            state.pairings.clear();
            Ok(())
        })
    }

    pub fn exchange(
        &self,
        credential: &str,
        request: AuthorizationRequest,
    ) -> Result<AuthorizationResponse> {
        ensure!(
            valid_token(credential)
                && request.next_token.len() == 43
                && valid_token(&request.next_token),
            "invalid authorization"
        );
        let credential_hash = hash(credential);
        let next_hash = hash(&request.next_token);
        ensure!(
            credential_hash != next_hash,
            "replacement credential must be new"
        );
        self.transaction(true, |state| {
            let timestamp = now();
            let id = match request.action.as_str() {
                "pair" => {
                    ensure!(
                        state
                            .pairings
                            .get(&credential_hash)
                            .is_some_and(|expiry| *expiry > timestamp),
                        "invalid authorization"
                    );
                    ensure!(
                        state.devices.len() < 1000,
                        "device limit reached; revoke unused grants"
                    );
                    let id = uuid::Uuid::new_v4().simple().to_string();
                    let browser_id = loop {
                        let candidate = format!("{:08x}", rand::random::<u32>());
                        if !state
                            .devices
                            .values()
                            .any(|device| device.browser_id == candidate)
                        {
                            break candidate;
                        }
                    };
                    state.devices.insert(
                        id.clone(),
                        Device {
                            browser_id,
                            token_hash: next_hash,
                            previous_hash: None,
                            label: request
                                .label
                                .chars()
                                .filter(|c| !c.is_control())
                                .take(100)
                                .collect(),
                            expires_at: timestamp + state.device_ttl as i64,
                            renew_after: timestamp + state.renew_after as i64,
                        },
                    );
                    state.pairings.remove(&credential_hash);
                    id
                }
                "renew" => {
                    let (id, device) = state
                        .devices
                        .iter_mut()
                        .find(|(_, device)| {
                            device.expires_at > timestamp
                                && (device.token_hash == credential_hash
                                    || (device.previous_hash.as_ref() == Some(&credential_hash)
                                        && device.token_hash == next_hash))
                        })
                        .context("invalid authorization")?;
                    // A repeated old/new pair returns the original rotation response.
                    if device.token_hash == credential_hash {
                        device.previous_hash = Some(credential_hash);
                        device.token_hash = next_hash;
                        device.expires_at = timestamp + state.device_ttl as i64;
                        device.renew_after = timestamp + state.renew_after as i64;
                    }
                    id.clone()
                }
                _ => bail!("invalid authorization action"),
            };
            let device = &state.devices[&id];
            Ok(AuthorizationResponse {
                device_id: id,
                expires_at: date(device.expires_at),
                renew_after: date(device.renew_after),
                service_name: "BrowserSkill".into(),
            })
        })
    }

    pub fn authenticate(&self, credential: &str) -> Result<AuthorizedDevice> {
        ensure!(valid_token(credential), "invalid authorization");
        let credential_hash = hash(credential);
        self.transaction(false, |state| {
            let (id, device) = state
                .devices
                .iter()
                .find(|(_, device)| {
                    device.token_hash == credential_hash && device.expires_at > now()
                })
                .context("invalid authorization")?;
            Ok(AuthorizedDevice {
                device_id: id.clone(),
                browser_id: device.browser_id.clone(),
            })
        })
    }

    pub fn is_authorized(&self, device_id: &str) -> bool {
        self.transaction(false, |state| {
            Ok(state
                .devices
                .get(device_id)
                .is_some_and(|device| device.expires_at > now()))
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not check persisted browser authorization");
            false
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn setup() -> (tempfile::TempDir, AuthorizationStore) {
        let home = tempfile::tempdir().unwrap();
        let store = AuthorizationStore::at_home(home.path());
        store
            .configure(&ServerConfig {
                listen: "127.0.0.1".parse().unwrap(),
                public_url: "wss://browser.example/extension".into(),
                tls_cert: None,
                tls_key: None,
                pairing_ttl: Duration::from_secs(300),
                device_ttl: Duration::from_secs(90 * 86400),
                renew_after: Duration::from_secs(30 * 86400),
                max_connections: 64,
                authorize_rate_limit: 60,
            })
            .unwrap();
        (home, store)
    }
    fn request(action: &str, next: &str) -> AuthorizationRequest {
        AuthorizationRequest {
            action: action.into(),
            next_token: next.into(),
            label: "Browser\nlabel".into(),
        }
    }
    fn pairing(store: &AuthorizationStore) -> String {
        store.pair().unwrap().rsplit_once('#').unwrap().1.to_owned()
    }

    #[test]
    fn pairing_is_one_use_durable_private_and_stores_only_hashes() {
        let (home, store) = setup();
        let link = pairing(&store);
        let credential = token();
        assert!(store.authenticate(&link).is_err());
        let grant = store.exchange(&link, request("pair", &credential)).unwrap();
        assert!(store.exchange(&link, request("pair", &token())).is_err());
        let restarted = AuthorizationStore::at_home(home.path());
        let device = restarted.authenticate(&credential).unwrap();
        assert_eq!(device.device_id, grant.device_id);
        assert_eq!(device.browser_id.len(), 8);
        assert_eq!(restarted.devices().unwrap()[0].label, "Browserlabel");
        let contents = fs::read_to_string(&store.path).unwrap();
        assert!(!contents.contains(&link));
        assert!(!contents.contains(&credential));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        restarted.revoke(&grant.device_id).unwrap();
        assert!(store.authenticate(&credential).is_err());
        assert!(!store.is_authorized(&grant.device_id));
    }

    #[test]
    fn only_one_concurrent_pairing_exchange_succeeds() {
        let (_home, store) = setup();
        let link = pairing(&store);
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let link = link.clone();
                std::thread::spawn(move || store.exchange(&link, request("pair", &token())).is_ok())
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .filter_map(|worker| worker.join().ok())
                .filter(|ok| *ok)
                .count(),
            1
        );
        assert_eq!(store.devices().unwrap().len(), 1);
    }

    #[test]
    fn rotation_retry_survives_restart_without_restoring_old_credentials() {
        let (home, store) = setup();
        let old = token();
        let next = token();
        let grant = store
            .exchange(&pairing(&store), request("pair", &old))
            .unwrap();
        let browser = store.authenticate(&old).unwrap().browser_id;
        let first = store.exchange(&old, request("renew", &next)).unwrap();
        let restarted = AuthorizationStore::at_home(home.path());
        let retry = restarted.exchange(&old, request("renew", &next)).unwrap();
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(retry).unwrap()
        );
        assert_eq!(restarted.authenticate(&next).unwrap().browser_id, browser);
        assert!(restarted.authenticate(&old).is_err());
        assert!(
            restarted
                .exchange(&old, request("renew", &token()))
                .is_err()
        );
        restarted.revoke(&grant.device_id).unwrap();
        assert!(store.exchange(&old, request("renew", &next)).is_err());
        assert!(store.exchange(&next, request("renew", &token())).is_err());
    }

    #[test]
    fn expired_and_revoked_pairings_and_grants_fail_closed() {
        let (_home, store) = setup();
        let expired_link = pairing(&store);
        store
            .transaction(true, |state| {
                state.pairings.insert(hash(&expired_link), now() - 1);
                Ok(())
            })
            .unwrap();
        assert!(
            store
                .exchange(&expired_link, request("pair", &token()))
                .is_err()
        );
        let credential = token();
        let grant = store
            .exchange(&pairing(&store), request("pair", &credential))
            .unwrap();
        store
            .transaction(true, |state| {
                state.devices.get_mut(&grant.device_id).unwrap().expires_at = now() - 1;
                Ok(())
            })
            .unwrap();
        assert!(!store.is_authorized(&grant.device_id));
        assert!(store.authenticate(&credential).is_err());
        assert!(
            store
                .exchange(&credential, request("renew", &token()))
                .is_err()
        );
        let link = pairing(&store);
        store.revoke_all().unwrap();
        assert!(store.exchange(&link, request("pair", &token())).is_err());
        fs::write(&store.path, b"not json").unwrap();
        assert!(!store.is_authorized(&grant.device_id));
        assert!(store.authenticate(&credential).is_err());
    }
}
