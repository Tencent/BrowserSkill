//! Pins the local WS server to the single browser-extension origin that
//! first connects to it, closing the gap documented in `ws.rs::origin_allowed`:
//! that check only validates that an `Origin` header is *shaped* like a
//! Chrome extension origin (`chrome-extension://<32 a-p chars>`), not that it
//! is *the* BrowserSkill extension. Any other extension installed in the same
//! browser (malicious, compromised, or side-loaded) is shaped identically and
//! would otherwise be accepted, giving it full control of the daemon and, in
//! turn, of the user's already-logged-in browser sessions.
//!
//! Pinning is deliberately simple: the first origin to complete a WS upgrade
//! after the store is empty is trusted and persisted; every later connection
//! must match it exactly. `bsk daemon reset-pin` clears the file so the user
//! can re-pair after reinstalling or switching extensions.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
struct State {
    pinned_origin: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExtensionPinStore {
    /// `None` when the daemon home directory couldn't be resolved (mirrors
    /// `AuditStore`'s degrade-gracefully convention). No pin can be persisted
    /// in that case, so every connection is treated as unpinned for that
    /// process's lifetime — a narrower window than the pre-fix behavior
    /// (which never pinned at all), not a regression.
    path: Option<PathBuf>,
}

impl ExtensionPinStore {
    pub fn new(home: Option<PathBuf>) -> Self {
        Self {
            path: home.map(|home| home.join("extension-pin.json")),
        }
    }

    fn read_state(&self) -> Result<State> {
        let Some(path) = self.path.as_deref() else {
            return Ok(State::default());
        };
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("invalid extension pin store"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(err) => Err(err.into()),
        }
    }

    fn write_state(&self, state: &State) -> Result<()> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        let parent = path.parent().context("extension pin directory missing")?;
        fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(file.as_file_mut(), state)?;
        file.as_file_mut().flush()?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|err| err.error)?;
        Ok(())
    }

    /// The currently pinned origin, if any.
    pub fn get(&self) -> Result<Option<String>> {
        Ok(self.read_state()?.pinned_origin)
    }

    /// Pin `origin` if nothing is pinned yet. Returns `true` if this call did
    /// the pinning, `false` if an origin was already pinned (regardless of
    /// whether it matches `origin` — the caller is expected to have already
    /// rejected a mismatch before calling this).
    pub fn pin_if_empty(&self, origin: &str) -> Result<bool> {
        let mut state = self.read_state()?;
        if state.pinned_origin.is_some() {
            return Ok(false);
        }
        state.pinned_origin = Some(origin.to_string());
        self.write_state(&state)?;
        Ok(true)
    }

    /// Clear the pin so the next connecting extension is trusted anew.
    pub fn reset(&self) -> Result<()> {
        self.write_state(&State::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_connection_pins_and_later_ones_read_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = ExtensionPinStore::new(Some(dir.path().to_path_buf()));
        assert_eq!(store.get().unwrap(), None);

        assert!(store.pin_if_empty("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap());
        assert_eq!(
            store.get().unwrap().as_deref(),
            Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );

        // A second extension trying to claim the pin is a no-op.
        assert!(!store.pin_if_empty("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap());
        assert_eq!(
            store.get().unwrap().as_deref(),
            Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    #[test]
    fn reset_clears_the_pin() {
        let dir = tempfile::tempdir().unwrap();
        let store = ExtensionPinStore::new(Some(dir.path().to_path_buf()));
        store.pin_if_empty("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        store.reset().unwrap();
        assert_eq!(store.get().unwrap(), None);
        assert!(store.pin_if_empty("chrome-extension://cccccccccccccccccccccccccccccccc").unwrap());
    }
}
