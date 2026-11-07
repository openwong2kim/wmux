use agent_desktop_core::{AdapterError, NativeHandle, RefEntry};

#[cfg(target_os = "macos")]
use super::resolve_classify::identity_summary_for_message;
#[cfg(target_os = "macos")]
use super::retained::{TokenLookup, resolve_token};
#[cfg(target_os = "macos")]
use crate::tree::AXElement;

/// Why a saved retained object no longer designates the element it was captured from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::tree) enum RetainedMismatch {
    Dead,
    Pid,
    Role,
    NativeId,
}

impl RetainedMismatch {
    pub(in crate::tree) fn reason(self) -> &'static str {
        match self {
            Self::Dead => "dead",
            Self::Pid => "pid",
            Self::Role => "role",
            Self::NativeId => "native_identifier",
        }
    }
}

/// The attributes a token's element reports, read once so the accept decision
/// can be checked without a live accessibility connection.
pub(in crate::tree) struct RetainedFacts<'a> {
    pub(in crate::tree) pid: i32,
    pub(in crate::tree) role: Option<&'a str>,
    pub(in crate::tree) subrole: Option<&'a str>,
    pub(in crate::tree) native_id: Option<&'a str>,
}

/// Resolves a saved token to its element without a tree search, or reports why
/// the token can no longer stand for that element.
#[cfg(target_os = "macos")]
pub(in crate::tree) fn resolve_saved_token(
    entry: &RefEntry,
    deadline: std::time::Instant,
) -> Result<Option<NativeHandle>, AdapterError> {
    let Some(token) = entry.identity.retained_object.as_deref() else {
        return Ok(None);
    };
    match resolve_token(token)? {
        TokenLookup::NotAToken => Ok(None),
        TokenLookup::Unavailable => Err(stale_token_error(entry, RetainedMismatch::Dead)),
        TokenLookup::Dead => Err(stale_token_error(entry, RetainedMismatch::Dead)),
        TokenLookup::Live(element) => {
            verify_token_element(entry, &element, deadline)?;
            Ok(Some(element.into_native_handle()))
        }
    }
}

#[cfg(target_os = "macos")]
fn verify_token_element(
    entry: &RefEntry,
    element: &AXElement,
    deadline: std::time::Instant,
) -> Result<(), AdapterError> {
    let pid = crate::tree::properties::ax_ipc::pid(element, deadline)
        .map_err(|error| token_read_error(entry, error))?;
    let read = |attribute| {
        super::resolve_ax_read::read_string(element, attribute, deadline)
            .map_err(|error| destroyed_as_stale(entry, error))
    };
    let role = read("AXRole")?;
    let subrole = read("AXSubrole")?;
    let native_id = match entry
        .identity
        .native_id
        .as_ref()
        .and_then(|identifier| native_identifier_attribute(identifier.kind))
    {
        Some(attribute) => read(attribute)?,
        None => None,
    };
    let facts = RetainedFacts {
        pid,
        role: role.as_deref(),
        subrole: subrole.as_deref(),
        native_id: native_id.as_deref(),
    };
    if let Some(mismatch) = token_mismatch(entry, &facts) {
        return Err(stale_token_error(entry, mismatch));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn token_read_error(entry: &RefEntry, ax_error: i32) -> AdapterError {
    if ax_error == accessibility_sys::kAXErrorInvalidUIElement {
        stale_token_error(entry, RetainedMismatch::Dead)
    } else {
        crate::tree::surface_read::map_error("AXPid", ax_error)
    }
}

#[cfg(target_os = "macos")]
fn destroyed_as_stale(entry: &RefEntry, error: AdapterError) -> AdapterError {
    if error.code == agent_desktop_core::ErrorCode::ElementNotFound {
        stale_token_error(entry, RetainedMismatch::Dead)
    } else {
        error
    }
}

/// Accepts a token's element only when its pid, snapshot role and recorded
/// native identifier all still agree with the saved ref.
pub(in crate::tree) fn token_mismatch(
    entry: &RefEntry,
    facts: &RetainedFacts<'_>,
) -> Option<RetainedMismatch> {
    let expected_pid = crate::system::process::process_identity::to_pid_t(entry.process.pid).ok();
    if expected_pid != Some(facts.pid) {
        return Some(RetainedMismatch::Pid);
    }
    let actual_role = facts
        .role
        .map(|role| crate::tree::roles::ax_role_and_subrole_to_str(role, facts.subrole));
    if actual_role != Some(entry.identity.role.as_str()) {
        return Some(RetainedMismatch::Role);
    }
    if let Some(recorded) = recorded_native_id(entry) {
        if facts.native_id != Some(recorded) {
            return Some(RetainedMismatch::NativeId);
        }
    }
    None
}

fn recorded_native_id(entry: &RefEntry) -> Option<&str> {
    let identifier = entry.identity.native_id.as_ref()?;
    native_identifier_attribute(identifier.kind)?;
    (!identifier.value.trim().is_empty()).then_some(identifier.value.as_str())
}

/// The accessibility attribute that reports one recorded identifier kind, or
/// `None` for a kind macOS cannot read back for comparison.
pub(in crate::tree) fn native_identifier_attribute(
    kind: agent_desktop_core::IdentifierKind,
) -> Option<&'static str> {
    match kind {
        agent_desktop_core::IdentifierKind::AxIdentifier => Some("AXIdentifier"),
        agent_desktop_core::IdentifierKind::AxDomIdentifier => Some("AXDOMIdentifier"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn stale_token_error(entry: &RefEntry, mismatch: RetainedMismatch) -> AdapterError {
    AdapterError::stale_ref_because(format!(
        "The saved element no longer exists or no longer matches: {}",
        identity_summary_for_message(entry)
    ))
    .with_details(serde_json::json!({
        "kind": "retained_object_stale",
        "reason": mismatch.reason(),
        "pid": entry.process.pid,
    }))
}

#[cfg(all(test, target_os = "macos"))]
#[path = "retained_resolve_tests.rs"]
mod tests;
