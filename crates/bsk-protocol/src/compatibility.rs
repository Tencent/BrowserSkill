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
    BorrowConfirmationTimeout,
    InteractionPolicy,
    IncognitoSessions,
    DialogControl,
    ClickMoveClick,
    TargetControl,
    ActionConditions,
    DomRead,
    UnverifiedScript,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FeatureWhen {
    Always,
    True {
        field: &'static str,
    },
    Present {
        field: &'static str,
    },
    Equals {
        field: &'static str,
        value: &'static str,
    },
    /// CLI permits `auto` to probe legacy daemons post-call, whereas the daemon
    /// never forwards `target` or `auto` to a pre-1.8 extension.
    ControlPolicy,
}

#[derive(Debug, Serialize)]
pub struct FeatureRequirement {
    pub feature: Feature,
    pub operation: &'static str,
    pub daemon: &'static str,
    pub extension: &'static str,
    pub when: FeatureWhen,
}

const TARGET_CONTROL_EXTENSION_RECOVERY: &str = "Please update the BrowserSkill extension in the affected browser profile and wait for it to reconnect. With a current CLI and an older extension, pass --policy strict on every sync/enable and step for legacy behavior. Strict policy does not make expect conditions available on old peers.";

impl Feature {
    pub const ALL: &'static [Self] = &[
        Self::BorrowConfirmationTimeout,
        Self::InteractionPolicy,
        Self::IncognitoSessions,
        Self::DialogControl,
        Self::ClickMoveClick,
        Self::TargetControl,
        Self::ActionConditions,
        Self::DomRead,
        Self::UnverifiedScript,
    ];

    pub const fn requirement(self) -> &'static FeatureRequirement {
        match self {
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
            Self::IncognitoSessions => &FeatureRequirement {
                feature: Self::IncognitoSessions,
                operation: "session start --incognito",
                daemon: "1.4",
                extension: "1.4",
                when: FeatureWhen::True { field: "incognito" },
            },
            Self::DialogControl => &FeatureRequirement {
                feature: Self::DialogControl,
                operation: "dialog and operation control",
                daemon: "1.5",
                extension: "1.5",
                when: FeatureWhen::Always,
            },
            Self::ClickMoveClick => &FeatureRequirement {
                feature: Self::ClickMoveClick,
                operation: "click-move-click",
                daemon: "1.7",
                extension: "1.7",
                when: FeatureWhen::Equals {
                    field: "mode",
                    value: "click-move-click",
                },
            },
            Self::TargetControl => &FeatureRequirement {
                feature: Self::TargetControl,
                operation: "target control",
                daemon: "1.8",
                extension: "1.8",
                when: FeatureWhen::ControlPolicy,
            },
            Self::ActionConditions => &FeatureRequirement {
                feature: Self::ActionConditions,
                operation: "action conditions (--expect)",
                daemon: "1.8",
                extension: "1.8",
                when: FeatureWhen::Present { field: "expect" },
            },
            Self::DomRead => &FeatureRequirement {
                feature: Self::DomRead,
                operation: "read",
                daemon: "1.9",
                extension: "1.9",
                when: FeatureWhen::Always,
            },
            Self::UnverifiedScript => &FeatureRequirement {
                feature: Self::UnverifiedScript,
                operation: "evaluate --unverified",
                daemon: "1.9",
                extension: "1.9",
                when: FeatureWhen::True {
                    field: "unverified",
                },
            },
        }
    }

    pub const fn required_protocol(self, peer: Peer) -> &'static str {
        match peer {
            Peer::Daemon => self.requirement().daemon,
            Peer::Extension => self.requirement().extension,
        }
    }

    pub const fn recovery_hint(self, peer: Peer) -> &'static str {
        match (self, peer) {
            (Self::TargetControl | Self::ActionConditions, Peer::Extension) => {
                TARGET_CONTROL_EXTENSION_RECOVERY
            }
            _ => peer.upgrade_hint(),
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

    pub fn requested(self, peer: Peer, params: &Value) -> bool {
        match self.requirement().when {
            FeatureWhen::Always => true,
            FeatureWhen::True { field } => params.get(field) == Some(&Value::Bool(true)),
            FeatureWhen::Present { field } => params.get(field).is_some_and(|v| !v.is_null()),
            FeatureWhen::Equals { field, value } => {
                params.get(field).and_then(Value::as_str) == Some(value)
            }
            FeatureWhen::ControlPolicy => match peer {
                Peer::Daemon => {
                    params.get("control_policy").and_then(Value::as_str) == Some("target")
                }
                Peer::Extension => matches!(
                    params.get("control_policy").and_then(Value::as_str),
                    Some("target" | "auto")
                ),
            },
        }
    }

    pub fn require(self, peer: Peer, protocol: &str) -> Result<(), RpcError> {
        if self.supports(peer, protocol) {
            return Ok(());
        }
        let requirement = self.requirement();
        let required = self.required_protocol(peer);
        let recovery = self.recovery_hint(peer);
        Err(RpcError {
            code: ErrorCode::Unsupported,
            message: format!(
                "{} requires {} protocol {} or a later compatible 1.x version (connected: {}). {} Other supported operations remain available",
                requirement.operation,
                peer.name(),
                required,
                if protocol.is_empty() {
                    "unknown"
                } else {
                    protocol
                },
                recovery,
            ),
            data: Some(json!({
                "reason": "unsupported_feature",
                "phase": "negotiate",
                "feature": self,
                "operation": requirement.operation,
                "component": peer,
                "required_protocol": required,
                "actual_protocol": protocol,
                "effect_state": "none",
                "recovery": recovery,
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
        if feature.requested(peer, params) {
            feature.require(peer, protocol)?;
        }
    }
    Ok(())
}
