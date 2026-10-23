//! Feature compatibility is separate from the base handshake. Missing optional
//! parameters retain the old behavior; explicitly requested features must be
//! understood by every peer on their execution path.

use serde::Serialize;
use serde_json::{Value, json};

use crate::{ErrorCode, Method, RpcError, system::compare_protocol};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Peer {
    Daemon,
    Extension,
}

impl Peer {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Daemon => "daemon",
            Self::Extension => "extension",
        }
    }

    pub const fn upgrade_hint(self) -> &'static str {
        match self {
            Self::Daemon => {
                "Please update bsk and restart its daemon after active tasks finish; restart host-managed daemons in their terminal or supervisor. Run `bsk doctor` to check the running version."
            }
            Self::Extension => {
                "Please update the BrowserSkill extension in the affected browser profile and wait for it to reconnect. If the store update is not available yet, continue using supported features; updating the CLI alone does not update the extension."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    IncognitoSessions,
    BorrowConfirmationTimeout,
    InteractionPolicy,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeatureWhen {
    Always,
    True { field: &'static str },
    Present { field: &'static str },
}

#[derive(Debug, Serialize)]
pub struct FeatureRequirement {
    pub feature: Feature,
    pub operation: &'static str,
    pub daemon: &'static str,
    pub extension: &'static str,
    pub when: FeatureWhen,
}

impl Feature {
    pub const ALL: &'static [Self] = &[
        Self::IncognitoSessions,
        Self::BorrowConfirmationTimeout,
        Self::InteractionPolicy,
    ];

    pub const fn requirement(self) -> &'static FeatureRequirement {
        match self {
            Self::IncognitoSessions => &FeatureRequirement {
                feature: Self::IncognitoSessions,
                operation: "session start --incognito",
                daemon: "1.4",
                extension: "1.4",
                when: FeatureWhen::True { field: "incognito" },
            },
            Self::BorrowConfirmationTimeout => &FeatureRequirement {
                feature: Self::BorrowConfirmationTimeout,
                operation: "tab borrow --timeout",
                daemon: "1.2",
                extension: "1.2",
                when: FeatureWhen::Present {
                    field: "confirmation_timeout_ms",
                },
            },
            Self::InteractionPolicy => &FeatureRequirement {
                feature: Self::InteractionPolicy,
                operation: "request-help",
                daemon: "1.3",
                // Older extensions already implement request-help. The new
                // daemon must forward it and honor their response rather than
                // allow its legacy environment override to disable help.
                extension: "1.0",
                when: FeatureWhen::Always,
            },
        }
    }

    pub const fn required_protocol(self, peer: Peer) -> &'static str {
        match peer {
            Peer::Daemon => self.requirement().daemon,
            Peer::Extension => self.requirement().extension,
        }
    }

    pub fn supports(self, peer: Peer, protocol: &str) -> bool {
        let required = self.required_protocol(peer);
        // A future major must explicitly establish support rather than inherit it.
        crate::system::parse_major(protocol) == crate::system::parse_major(required)
            && matches!(
                compare_protocol(protocol, required),
                Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
            )
    }

    pub fn requested(self, params: &Value) -> bool {
        match self.requirement().when {
            FeatureWhen::Always => true,
            FeatureWhen::True { field } => params.get(field) == Some(&Value::Bool(true)),
            FeatureWhen::Present { field } => params.get(field).is_some_and(|v| !v.is_null()),
        }
    }

    pub fn require(self, peer: Peer, protocol: &str) -> Result<(), RpcError> {
        if self.supports(peer, protocol) {
            return Ok(());
        }
        let requirement = self.requirement();
        let required = self.required_protocol(peer);
        Err(RpcError {
            code: ErrorCode::Unsupported,
            message: format!(
                "{} requires {} protocol {} (connected: {}). {} Other supported operations remain available",
                requirement.operation,
                peer.name(),
                required,
                if protocol.is_empty() {
                    "unknown"
                } else {
                    protocol
                },
                peer.upgrade_hint(),
            ),
            data: Some(json!({
                "reason": "unsupported_feature", "feature": self,
                "operation": requirement.operation, "component": peer,
                "required_protocol": required, "actual_protocol": protocol,
                "effect_state": "none", "recovery": peer.upgrade_hint(),
            })),
        })
    }
}

pub fn check_request(
    method: &Method,
    params: &Value,
    peer: Peer,
    protocol: &str,
) -> Result<(), RpcError> {
    for feature in method.features() {
        if feature.requested(params) {
            feature.require(peer, protocol)?;
        }
    }
    Ok(())
}
