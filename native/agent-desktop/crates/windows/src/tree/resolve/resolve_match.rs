use agent_desktop_core::{AdapterError, RefEntry};
use serde_json::json;

pub(crate) fn stale_ref_error(_entry: &RefEntry) -> AdapterError {
    let error = AdapterError::stale_ref_because("Stored ref does not match any live element");
    let default_retryable = error.permits_retry_by_default();
    error.with_details(json!({
        "kind": "resolve_no_candidate",
        "complete": true,
        "retryable": default_retryable,
    }))
}

/// The terminal twin of [`stale_ref_error`]: the ref's owning process has
/// itself exited, so no re-attempt within this deadline can ever find a live
/// candidate. Stamped `retryable: false` so core's poll loop settles on the
/// first attempt instead of re-running resolution to the outer deadline and
/// reporting a bare `TIMEOUT` that discards the diagnosis (A14-4 measured
/// ~5s at the default budget for a defect this stamp settles in one pass).
/// `ErrorCode::StaleRef` on a `not_delivered` disposition already carries the
/// `refresh_snapshot_then_retry_original` recovery hint (`output.rs`'s
/// `recovery_for_code`), so nothing further needs attaching here.
#[cfg(target_os = "windows")]
pub(crate) fn owning_process_exited_error(_entry: &RefEntry) -> AdapterError {
    AdapterError::stale_ref_because("Stored ref's owning process has exited").with_details(json!({
        "kind": "resolve_owning_process_exited",
        "complete": true,
        "retryable": false,
    }))
}

#[cfg(test)]
#[path = "resolve_match_tests.rs"]
mod tests;
