use agent_desktop_core::{AdapterError, Deadline, ErrorCode, NativeHandle, RefEntry};

#[cfg(target_os = "windows")]
use super::resolve::resolve_pacing::{FIRST_RETRY_PAUSE, next_retry_pause, sleep_before_retry};

#[cfg(target_os = "windows")]
use super::element::UIAElement;
#[cfg(target_os = "windows")]
use super::resolve::resolve_match::owning_process_exited_error;
#[cfg(target_os = "windows")]
use super::resolve::resolve_match::stale_ref_error;

/// Wraps the resolved element with the ref's verified process identity, so the
/// live-read path can corroborate that the provider is still the one
/// resolution verified. The token-less case cannot reach here:
/// `resolve_window_root` fails closed on it first.
#[cfg(target_os = "windows")]
pub(crate) fn into_verified_handle(
    element: super::element::UIAElement,
    entry: &RefEntry,
) -> NativeHandle {
    element
        .with_verified_process(
            entry.process.pid.get(),
            entry.process.process_instance.clone().unwrap_or_default(),
        )
        .into_native_handle()
}

#[cfg(target_os = "windows")]
pub(crate) fn retry_incomplete_until(
    deadline: Deadline,
    mut operation: impl FnMut() -> Result<NativeHandle, AdapterError>,
) -> Result<NativeHandle, AdapterError> {
    let mut last_incomplete: Option<AdapterError> = None;
    let mut pause = FIRST_RETRY_PAUSE;
    loop {
        if deadline.is_expired() {
            return Err(last_incomplete
                .map(mark_deadline_elapsed)
                .unwrap_or_else(|| deadline.timeout_error()));
        }
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_retryable_resolution_error(&error) => {
                last_incomplete = Some(error);
                sleep_before_retry(deadline, pause);
                pause = next_retry_pause(pause);
            }
            Err(error) if error.code == ErrorCode::Timeout => {
                return Err(match last_incomplete {
                    Some(incomplete) => mark_deadline_elapsed(incomplete),
                    None => error,
                });
            }
            Err(error) => return Err(error),
        }
    }
}

/// Whether the adapter's own loop should retry an error: only an explicitly
/// retryable, incomplete read. A provider's own `UIA_E_TIMEOUT` classifies
/// `Timeout` and is one of those - it is a per-call transport timeout inside
/// the operation's budget, not the budget running out. Deadline exhaustion
/// carries no retryable stamp, so it still falls through to the caller. Mirrors macOS
/// (`is_retryable_resolution_error` in `crates/macos/src/tree/resolve/mod.rs`); the granularity split between adapter-loop-settled
/// and incomplete lives in the `complete`/`retryable` details every resolver
/// error carries.
#[cfg(target_os = "windows")]
pub(crate) fn is_retryable_resolution_error(error: &AdapterError) -> bool {
    error.is_transient_incomplete_read()
}

/// Stamps the final incomplete diagnosis with `deadline_elapsed` so the
/// caller sees why the retries ran out, preserving the incomplete's own
/// details rather than discarding them for a bare `TIMEOUT`. Core owns the
/// payload (`agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed`)
/// so every platform stamps the same shape.
#[cfg(target_os = "windows")]
pub(crate) use agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed;

/// Reaches the stored window's root element from the ref's source window id.
///
/// The fail-closed window gate (the A7-3 wrong-target shape exists to
/// prevent): a stored ref must not search the tree of a different process that
/// has since taken over the HWND. The stored window the ref names is
/// reconstructed and put through the same stored-evidence rule
/// (`WindowIdentityEvidence::verify_stored`) the listing path uses, so the
/// live owner of the handle, not merely the liveness of the stored pid,
/// decides whether the window is still the ref's window. The macOS resolver
/// verifies its window record before searching in the same position. A
/// token-less ref (elevated process whose token could not be read) yields no
/// evidence and fails closed here rather than searching an unverified window.
///
/// The rule's own error is `WINDOW_NOT_FOUND`; the resolver reports its
/// failures as `STALE_REF`, so the verdict is adopted and the error contract
/// of this path is unchanged.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_window_root(
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<UIAElement, AdapterError> {
    let window_id = entry
        .source
        .source_window_id
        .as_deref()
        .ok_or_else(|| stale_ref_error(entry))?;
    let window = agent_desktop_core::WindowInfo {
        id: window_id.to_string(),
        title: entry.source.source_window_title.clone().unwrap_or_default(),
        app: entry.source.source_app.clone().unwrap_or_default(),
        pid: entry.process.pid,
        process_instance: entry.process.process_instance.clone(),
        bounds: None,
        state: Default::default(),
    };
    crate::system::window::window_identity::WindowIdentityEvidence::from_info(
        crate::system::window::window_ops::parse_handle(&window.id),
        &window,
    )
    .ok_or_else(|| stale_ref_error(entry))?
    .verify_stored()
    .map_err(|_| verify_stored_failure_error(entry, deadline))?;

    crate::tree::surfaces::surface_root(
        agent_desktop_core::ObservationRoot::Window(&window),
        entry.source.source_surface,
        deadline,
    )
}

/// Classifies a `verify_stored()` failure by the owning process's own
/// liveness, not merely the handle's: a window recreated mid-redraw by a
/// still-running process is retryable, an exited owner is terminal. Without
/// this split a dead owner's every re-attempt re-fails identically and the
/// retry loop burns the whole deadline before reporting a bare `TIMEOUT`
/// with no diagnosis. Answers only when the ref carries a real
/// process-instance token; a token-less ref keeps today's retryable
/// behaviour, since liveness cannot be checked without one.
#[cfg(target_os = "windows")]
fn verify_stored_failure_error(entry: &RefEntry, deadline: Deadline) -> AdapterError {
    let Some(instance) = entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
    else {
        return stale_ref_error(entry);
    };
    let identity = agent_desktop_core::ProcessIdentity::new(entry.process.pid, instance);
    match crate::system::process_state::process_state_impl(identity, deadline) {
        Ok(
            agent_desktop_core::system::process_state::ProcessState::Exited { .. }
            | agent_desktop_core::system::process_state::ProcessState::Crashed { .. },
        ) => owning_process_exited_error(entry),
        _ => stale_ref_error(entry),
    }
}

pub(crate) mod resolve_anchor;
pub(crate) mod resolve_match;
pub(crate) mod resolve_pacing;
pub(crate) mod resolve_search;

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_tests.rs"]
mod windows_only;
