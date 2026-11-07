use agent_desktop_core::{AdapterError, NativeHandle, RefEntry};

use crate::tree::AXElement;

/// Turns the role-matching landings into a handle: one is the element core
/// then confirms by its full predicate, none is not found, more is ambiguous.
#[cfg(target_os = "macos")]
pub(in crate::tree) fn classify_candidates(
    mut matches: Vec<AXElement>,
    entry: &RefEntry,
) -> Result<NativeHandle, AdapterError> {
    match matches.len() {
        0 => Err(AdapterError::element_not_found("element")),
        1 => retained_handle(matches.remove(0)),
        _ => Err(ambiguous_target_error(&matches, entry)),
    }
}

#[cfg(target_os = "macos")]
fn ambiguous_target_error(matches: &[AXElement], entry: &RefEntry) -> AdapterError {
    let count = matches.len();
    AdapterError::ambiguous_target(format!(
        "Ambiguous target: {count} candidates matched {}",
        identity_summary_for_message(entry)
    ))
    .with_details(serde_json::json!({
        "candidate_count": count,
        "candidate_summaries_truncated": count > 10,
        "role": entry.identity.role,
        "name": entry.identity.name,
        "description": entry.identity.description,
        "source_app": entry.source.source_app,
        "source_window_id": entry.source.source_window_id,
        "source_window_title": entry.source.source_window_title,
        "candidates": candidate_summaries(matches, entry)
    }))
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn identity_summary_for_message(entry: &RefEntry) -> String {
    format!(
        "role={}, name_chars={}, description_chars={}",
        entry.identity.role,
        text_len(entry.identity.name.as_deref()),
        text_len(entry.identity.description.as_deref())
    )
}

#[cfg(target_os = "macos")]
fn text_len(value: Option<&str>) -> usize {
    value.unwrap_or("").chars().count()
}

#[cfg(target_os = "macos")]
fn retained_handle(candidate: AXElement) -> Result<NativeHandle, AdapterError> {
    if candidate.0.is_null() {
        #[cfg(test)]
        return Ok(NativeHandle::null());
        #[cfg(not(test))]
        return Err(AdapterError::element_not_found("element"));
    }
    Ok(candidate.into_native_handle())
}

#[cfg(target_os = "macos")]
fn candidate_summaries(matches: &[AXElement], entry: &RefEntry) -> Vec<serde_json::Value> {
    matches
        .iter()
        .take(10)
        .enumerate()
        .map(|(index, _)| {
            serde_json::json!({
                "index": index,
                "role": entry.identity.role,
                "identity": "matched",
            })
        })
        .collect()
}
