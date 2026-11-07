use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct RefEntryIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_object: Option<String>,
    pub role: String,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<crate::ElementIdentifier>,
    /// Set when the capture read complete evidence and exactly one observed
    /// element matched this entry's full identity predicate.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unique_at_capture: bool,
}
