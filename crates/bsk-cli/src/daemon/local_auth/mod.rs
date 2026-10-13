//! Local pairing credentials and policy. Remote grants use a separate store.
pub mod maintenance;
pub mod store;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalAuthMode {
    #[default]
    Warn,
    Required,
    TrustLocal,
}
impl LocalAuthMode {
    pub fn accepts_legacy(self) -> bool {
        self != Self::Required
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    local_auth: Option<LocalAuthMode>,
    #[serde(flatten)]
    other: std::collections::BTreeMap<String, serde_json::Value>,
}
pub fn read_mode(home: &Path) -> Result<LocalAuthMode> {
    let settings: Settings = super::json_store::read(&home.join("settings.json"))?;
    Ok(settings.local_auth.unwrap_or_default())
}
pub fn write_mode(home: &Path, mode: LocalAuthMode) -> Result<()> {
    super::json_store::transaction(
        &home.join("settings.json"),
        true,
        |settings: &mut Settings| {
            settings.local_auth = Some(mode);
            Ok(())
        },
    )
}

#[derive(Debug)]
pub struct LocalAuth {
    pub store: store::PairingStore,
    mode: Mutex<LocalAuthMode>,
}
impl LocalAuth {
    pub fn open(home: &Path) -> Result<Self> {
        Ok(Self {
            store: store::PairingStore::open(home)?,
            mode: Mutex::new(read_mode(home)?),
        })
    }
    pub fn memory(mode: LocalAuthMode) -> Self {
        Self {
            store: store::PairingStore::memory(),
            mode: Mutex::new(mode),
        }
    }
    pub fn mode(&self) -> LocalAuthMode {
        *self.mode.lock().expect("local auth mode poisoned")
    }
    pub fn set_mode(&self, home: &Path, mode: LocalAuthMode) -> Result<()> {
        let mut current = self.mode.lock().expect("local auth mode poisoned");
        write_mode(home, mode)?;
        *current = mode;
        Ok(())
    }
}
