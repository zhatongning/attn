use serde::{Deserialize, Serialize};

use super::confidence::Confidence;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapability {
    pub name: String,
    pub availability: Confidence,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceStatus {
    Available,
    Degraded,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub source_name: String,
    pub status: SourceStatus,
    pub capabilities: Vec<SourceCapability>,
}
