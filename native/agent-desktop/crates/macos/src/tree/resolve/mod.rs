#[cfg(target_os = "macos")]
use agent_desktop_core::refs::ref_identity::element_token;
use agent_desktop_core::{AdapterError, ErrorCode, NativeHandle, RefEntry, SnapshotSurface};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use super::resolve::resolve_classify::identity_summary_for_message;
#[cfg(target_os = "macos")]
use super::resolve::resolve_errors::element_token_required;
#[cfg(target_os = "macos")]
use super::resolve::resolve_read_context::ResolveReadContext;
#[cfg(target_os = "macos")]
use super::resolve::resolve_roots::{candidate_roots, source_window_scope_required};
#[cfg(target_os = "macos")]
use super::resolve::resolve_search::find_entry_by_path;

/// Re-identifies a saved ref by the element token captured with it, and refuses
/// any ref that carries none: a token names the exact element, so no path or
/// search can stand in for it.
#[cfg(target_os = "macos")]
pub(crate) fn resolve_element_with_deadline(
    entry: &RefEntry,
    operation_deadline: agent_desktop_core::Deadline,
) -> Result<NativeHandle, AdapterError> {
    let identity = verify_process_instance(entry)?;
    if element_token(entry).is_none() {
        return Err(element_token_required(entry));
    }
    let deadline = crate::tree::locator_deadline::from_operation(operation_deadline)?;
    let result = resolve_with_recovery(entry, identity, deadline, || {
        resolve_token_once(entry, deadline)
    });
    match result {
        Err(error) if error.code == ErrorCode::ElementNotFound => {
            Err(stale_ref_error(entry, &error))
        }
        other => other,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_locator_anchor_with_deadline(
    entry: &RefEntry,
    operation_deadline: agent_desktop_core::Deadline,
) -> Result<NativeHandle, AdapterError> {
    let identity = verify_process_instance(entry)?;
    let deadline = crate::tree::locator_deadline::from_operation(operation_deadline)?;
    let result = resolve_with_recovery(entry, identity, deadline, || {
        resolve_locator_anchor_once(entry, deadline)
    });
    match result {
        Err(error) if error.code == ErrorCode::ElementNotFound => {
            Err(stale_ref_error(entry, &error))
        }
        other => other,
    }
}

#[cfg(target_os = "macos")]
fn verify_process_instance(
    entry: &RefEntry,
) -> Result<crate::system::process::process_identity::ProcessIdentity, AdapterError> {
    let Some(instance) = entry.process.process_instance.as_deref() else {
        return Err(AdapterError::stale_ref_because(
            "Saved target has no process instance identity",
        ));
    };
    let pid = crate::system::process::process_identity::to_pid_t(entry.process.pid)?;
    match crate::system::process::process_identity::matches_instance(pid, instance) {
        Ok(true) => crate::system::process::process_identity::ProcessIdentity::capture(pid)?
            .filter(|identity| identity.token() == instance)
            .ok_or_else(|| {
                AdapterError::stale_ref_because(
                    "Saved target process instance changed during resolution",
                )
            }),
        Ok(false) => Err(AdapterError::stale_ref_because(
            "Saved target belongs to a process instance that is no longer running",
        )),
        Err(error) if error.code == ErrorCode::InvalidArgs => Err(AdapterError::stale_ref_because(
            "Saved target carries a malformed process instance identity",
        )),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn resolve_with_recovery<T>(
    entry: &RefEntry,
    identity: crate::system::process::process_identity::ProcessIdentity,
    deadline: Instant,
    mut operation: impl FnMut() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    if matches!(
        entry.source.source_surface,
        SnapshotSurface::Menu | SnapshotSurface::Menubar
    ) {
        crate::tree::app_menu::observe(identity, deadline, operation)
    } else {
        retry_incomplete_until(deadline, || {
            if !identity.still_matches()? {
                return Err(AdapterError::stale_ref_because(
                    "Saved target process instance changed during resolution",
                ));
            }
            let result = operation();
            if !identity.still_matches()? {
                return Err(AdapterError::stale_ref_because(
                    "Saved target process instance changed during resolution",
                ));
            }
            result
        })
    }
}

#[cfg(target_os = "macos")]
fn resolve_token_once(entry: &RefEntry, deadline: Instant) -> Result<NativeHandle, AdapterError> {
    let started = Instant::now();
    crate::tree::locator_deadline::remaining(deadline)?;
    let mut read_context = ResolveReadContext::new(deadline);
    match token_resolution(entry, deadline, &mut read_context, started) {
        Some(result) => result,
        None => Err(element_token_required(entry)),
    }
}

#[cfg(target_os = "macos")]
fn resolve_locator_anchor_once(
    entry: &RefEntry,
    deadline: Instant,
) -> Result<NativeHandle, AdapterError> {
    let started = Instant::now();
    crate::tree::locator_deadline::remaining(deadline)?;
    let mut read_context = ResolveReadContext::new(deadline);
    if let Some(result) = token_resolution(entry, deadline, &mut read_context, started) {
        return result;
    }
    if !can_use_locator_anchor_path(entry) {
        return finish_resolution(
            Err(AdapterError::element_not_found("locator anchor")),
            &mut read_context,
            started,
            "locator_anchor_insufficient",
            true,
        );
    }
    let roots = match candidate_roots(entry, &mut read_context) {
        Ok(roots) => roots,
        Err(error) => {
            return finish_resolution(
                Err(error),
                &mut read_context,
                started,
                "locator_anchor_roots",
                true,
            );
        }
    };
    let result = find_entry_by_path(&roots, entry, &mut read_context);
    finish_resolution(
        result,
        &mut read_context,
        started,
        "locator_anchor_path",
        true,
    )
}

/// The token answer a resolution pass shares: `Some` when the saved ref carries
/// a retained object, whether it resolved or was refused, and `None` when the
/// entry has no token, which only the locator-anchor pass answers with a path.
#[cfg(target_os = "macos")]
fn token_resolution(
    entry: &RefEntry,
    deadline: Instant,
    context: &mut ResolveReadContext,
    started: Instant,
) -> Option<Result<NativeHandle, AdapterError>> {
    match super::resolve::retained_resolve::resolve_saved_token(entry, deadline) {
        Ok(Some(handle)) => Some(finish_resolution(
            Ok(handle),
            context,
            started,
            "remote_token",
            true,
        )),
        Ok(None) => None,
        Err(error) => Some(finish_resolution(
            Err(error),
            context,
            started,
            "remote_token",
            true,
        )),
    }
}

#[cfg(target_os = "macos")]
fn finish_resolution<T>(
    result: Result<T, AdapterError>,
    context: &mut ResolveReadContext,
    started: Instant,
    phase: &str,
    path_fast: bool,
) -> Result<T, AdapterError> {
    context.stats.elapsed_us = started.elapsed().as_micros() as u64;
    match result {
        Ok(value) => {
            tracing::debug!(phase, path_fast, stats = ?context.stats, "strict resolution completed");
            Ok(value)
        }
        Err(mut error) => {
            let mut details = error
                .details
                .take()
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(object) = details.as_object_mut() {
                object.insert("resolution_phase".into(), serde_json::json!(phase));
                object.insert("path_fast".into(), serde_json::json!(path_fast));
                object.insert("query_stats".into(), serde_json::json!(&context.stats));
            }
            tracing::debug!(phase, path_fast, code = error.code.as_str(), stats = ?context.stats, "strict resolution failed");
            Err(error.with_details(details))
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn retry_incomplete_until<T>(
    deadline: Instant,
    mut operation: impl FnMut() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    let mut last_incomplete = None;
    loop {
        if let Err(timeout) = crate::tree::locator_deadline::remaining(deadline) {
            return Err(last_incomplete
                .map(mark_deadline_elapsed)
                .unwrap_or(timeout));
        }
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_retryable_resolution_error(&error) => {
                last_incomplete = Some(error);
                sleep_before_retry(deadline);
            }
            Err(error) if error.code == ErrorCode::Timeout => match last_incomplete {
                Some(incomplete) => return Err(mark_deadline_elapsed(incomplete)),
                None => return Err(error),
            },
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "macos")]
fn sleep_before_retry(deadline: Instant) {
    if let Ok(remaining) = crate::tree::locator_deadline::remaining(deadline) {
        std::thread::sleep(remaining.min(Duration::from_millis(25)));
    }
}

/// Core owns the payload (`agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed`)
/// so both adapters share one definition.
#[cfg(target_os = "macos")]
use agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed;

#[cfg(target_os = "macos")]
fn stale_ref_error(entry: &RefEntry, cause: &AdapterError) -> AdapterError {
    let retryable = cause.permits_retry_by_default();
    AdapterError::new(
        ErrorCode::StaleRef,
        format!("Element not found: {}", identity_summary_for_message(entry)),
    )
    .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
    .with_details(serde_json::json!({
        "kind": "resolution_complete_absence",
        "complete": true,
        "retryable": retryable,
        "pid": entry.process.pid,
        "source_window_id": entry.source.source_window_id,
        "cause": cause.details,
    }))
}

#[cfg(target_os = "macos")]
fn is_retryable_resolution_error(error: &AdapterError) -> bool {
    error.is_transient_incomplete_read()
}

/// A tokenless anchor lands by position, so the gate asks only that its path be
/// anchored to a recorded window or surface; core confirms identity after landing.
#[cfg(target_os = "macos")]
fn can_use_locator_anchor_path(entry: &RefEntry) -> bool {
    let source_scoped = if entry.source.source_surface == SnapshotSurface::Window {
        source_window_scope_required(entry) || entry.source.is_process_rooted()
    } else {
        true
    };
    source_scoped && (entry.scope.root_ref.is_none() || entry.scope.path_is_absolute)
}

pub(crate) mod resolve_ax_read;
pub(super) mod resolve_classify;
pub(super) mod resolve_errors;
pub(super) mod resolve_read_context;
pub(super) mod resolve_roots;
pub(super) mod resolve_search;
pub(super) mod resolve_source_app;
pub(crate) mod retained;
pub(super) mod retained_resolve;
#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "resolve_tests_more.rs"]
mod tests_more;

#[cfg(not(target_os = "macos"))]
pub(crate) fn resolve_element_with_deadline(
    _entry: &RefEntry,
    _deadline: agent_desktop_core::Deadline,
) -> Result<NativeHandle, AdapterError> {
    Err(AdapterError::not_supported(
        "resolve_element_strict_with_timeout",
    ))
}
