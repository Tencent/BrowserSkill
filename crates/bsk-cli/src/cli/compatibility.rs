//! Explain feature availability from the live status snapshot. No update or
//! restart is performed, and every browser profile is evaluated separately.
use bsk_protocol::{
    StatusResult,
    compatibility::{Feature, Peer},
};
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct Blocker {
    pub component: Peer,
    pub required_protocol: &'static str,
    pub actual_protocol: String,
    pub recovery: &'static str,
}

#[derive(Serialize)]
pub(crate) struct FeatureAvailability {
    pub feature: Feature,
    pub available: bool,
    pub blocked_by: Vec<Blocker>,
}

#[derive(Serialize)]
pub(crate) struct BrowserCompatibility {
    pub instance_id: String,
    pub label: String,
    pub features: Vec<FeatureAvailability>,
}

#[derive(Serialize)]
pub(crate) struct CompatibilityReport {
    pub cli_version: &'static str,
    pub cli_protocol_version: &'static str,
    pub daemon: Vec<FeatureAvailability>,
    pub browsers: Vec<BrowserCompatibility>,
}

fn features(daemon: &str, extension: Option<&str>) -> Vec<FeatureAvailability> {
    Feature::ALL
        .iter()
        .map(|&feature| {
            let mut blocked_by = Vec::new();
            for (component, protocol) in
                [(Peer::Daemon, Some(daemon)), (Peer::Extension, extension)]
            {
                if let Some(protocol) = protocol
                    && !feature.supports(component, protocol)
                {
                    blocked_by.push(Blocker {
                        component,
                        required_protocol: feature.required_protocol(component),
                        actual_protocol: protocol.into(),
                        recovery: component.upgrade_hint(),
                    });
                }
            }
            FeatureAvailability {
                feature,
                available: blocked_by.is_empty(),
                blocked_by,
            }
        })
        .collect()
}

pub(crate) fn report(status: &StatusResult) -> CompatibilityReport {
    CompatibilityReport {
        cli_version: env!("CARGO_PKG_VERSION"),
        cli_protocol_version: bsk_protocol::catalog::PROTOCOL_VERSION,
        daemon: features(&status.protocol_version, None),
        browsers: status
            .browsers
            .iter()
            .map(|browser| BrowserCompatibility {
                instance_id: browser.instance_id.clone(),
                label: browser.label.clone(),
                features: features(
                    &status.protocol_version,
                    Some(&browser.extension_protocol_version),
                ),
            })
            .collect(),
    }
}

pub(crate) fn limitations(report: &CompatibilityReport) -> Vec<String> {
    let mut details = Vec::new();
    for feature in &report.daemon {
        if !feature.available {
            details.push(format!(
                "daemon: {}",
                feature.feature.requirement().operation
            ));
        }
    }
    for browser in &report.browsers {
        for feature in &browser.features {
            if feature
                .blocked_by
                .iter()
                .any(|blocker| blocker.component == Peer::Extension)
            {
                details.push(format!(
                    "extension {} ({}): {}",
                    browser.instance_id,
                    browser.label,
                    feature.feature.requirement().operation
                ));
            }
        }
    }
    details
}
