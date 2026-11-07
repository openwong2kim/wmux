//! The locator-anchor resolver: the path-only resolver core's selected-match
//! hydration and stored-ref resolution both land on.
//!
//! Core's `live_locator::hydrate` re-observes the matched subtree from the
//! return handle and enforces evidence completeness itself; Windows only has to
//! land the anchor. The anchor's path is exact from the just-walked tree, so
//! there is **no broad-search fallback**: every step is descent along a stored
//! path that churn makes permanently wrong, so a path step that lands nowhere, a
//! role-refuted candidate, or a vanished node **settles the attempt
//! immediately** (a completed-search `STALE_REF`, one attempt, the deadline
//! intact for core's fresh re-observation). Only the unresponsive/transport
//! class runs through the bounded retry loop, which re-walks the same cheap
//! O(depth) path rather than replaying an expensive search.
//!
//! The landing is not re-identified here: the recorded identity and geometry are
//! core's to compare against, on the same handle this returns.
//!
//! An expired deadline is the one failure that must not settle. There was no
//! attempt left to settle: a path walk cut short by the deadline lands short
//! of the stored index, and reporting that as a miss would tell core the
//! element is genuinely gone when the truth is only that time ran out. It
//! surfaces as `TIMEOUT` instead.

use agent_desktop_core::{AdapterError, Deadline, NativeHandle, RefEntry};

use super::resolve_match::stale_ref_error;
use super::resolve_search::descent::{DescentPolicy, DescentVerdict};
#[cfg(target_os = "windows")]
use super::resolve_search::{identity_unknown_error, resolve_walk_budget, window_rooted};
use crate::system::runtime::hresult::ReadDisposition;
use crate::tree::automation::{UiaFailure, uia_failure_disposition};
#[cfg(target_os = "windows")]
use crate::tree::walk::walker::TreeSource;
#[cfg(target_os = "windows")]
use crate::tree::walk::walker_source::UiaTreeSource;

/// Resolves a locator anchor, settled-on-churn and bounded on transport.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_locator_anchor(
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<NativeHandle, AdapterError> {
    crate::tree::resolve::retry_incomplete_until(deadline, || {
        resolve_locator_anchor_once(entry, deadline)
    })
}

/// The non-Windows twin. No UI Automation elements exist there, so every
/// anchor fails closed as stale instead of faking a landing.
#[cfg(not(target_os = "windows"))]
pub(crate) fn resolve_locator_anchor(
    entry: &RefEntry,
    _deadline: Deadline,
) -> Result<NativeHandle, AdapterError> {
    Err(stale_ref_error(entry))
}

/// The one pure gate runs first, before any of `resolve_window_root`,
/// `UiaTreeSource::for_root` or `prepare_root` - three cross-process calls a
/// verdict the stored ref alone can settle should never pay for.
///
/// That gate is the path's scope: a path recorded relative to a drill-down root
/// is not one the window's own root can descend, and an empty path is a valid
/// anchor because the root element itself can be the stored target. Everything
/// about the element itself - name, identifier, bounds - belongs to core's
/// full-predicate check on the landing, so an element that carries none of them
/// still lands.
#[cfg(target_os = "windows")]
fn resolve_locator_anchor_once(
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<NativeHandle, AdapterError> {
    if !window_rooted(entry) {
        return Err(stale_ref_error(entry));
    }

    let root = crate::tree::resolve::resolve_window_root(entry, deadline)?;
    let source = UiaTreeSource::for_root(&root)?;
    let prepared = source.prepare_root(&root)?;
    let budget = resolve_walk_budget(deadline);

    let landing = super::resolve_search::descent::descend_path(
        &source,
        &prepared,
        &entry.scope.path,
        &budget,
        &ANCHOR_DESCENT,
    )?;
    let Some(candidate) = landing else {
        return Err(stale_ref_error(entry));
    };
    let (_, evidence, _) = source.evidence(&candidate);
    anchor_role_verdict(entry, &evidence)?;
    Ok(crate::tree::resolve::into_verified_handle(candidate, entry))
}

/// The anchor's role guard: an [`agent_desktop_core::LocatorField::Unknown`]
/// role is a failed read, not evidence the element is some other role, so it
/// stays retryable; anything else is a settled verdict, either a role match
/// (the walk continues) or a role-refuted landing (the path is a locator,
/// never an identity by itself).
#[cfg(target_os = "windows")]
fn anchor_role_verdict(
    entry: &RefEntry,
    evidence: &agent_desktop_core::LocatorEvidence,
) -> Result<(), AdapterError> {
    if evidence.role.is_unknown() {
        return Err(identity_unknown_error(entry));
    }
    let role_matches = evidence
        .role
        .known()
        .is_some_and(|role| role == &entry.identity.role);
    if role_matches {
        Ok(())
    } else {
        Err(stale_ref_error(entry))
    }
}

/// The shape-only phrase both anchor enumeration axes report under. The
/// anchor descends one exact path, so descent and sibling walk are the same
/// act to a reader of the error.
const ANCHOR_CONTEXT: &str = "walk a locator anchor's path";

/// The anchor's descent policy.
///
/// An expired deadline surfaces the timeout rather than yielding a partial
/// list. This resolver settles in one attempt, so a partial list would land
/// short of the stored index and report a settled `STALE_REF` - telling the
/// caller the element is genuinely gone when the truth is only that time ran
/// out, and consuming the fresh re-observation the settled answer is supposed
/// to trigger.
pub(crate) const ANCHOR_DESCENT: DescentPolicy = DescentPolicy {
    classify: anchor_descent_verdict,
    descend_context: ANCHOR_CONTEXT,
    sibling_context: ANCHOR_CONTEXT,
};

/// Anchor descent classification: a settled absence or a vanished node means
/// the subtree enumerates nothing (a real settled miss, never retried); a
/// transport failure propagates retryable; a terminal failure propagates as
/// the attempt's error. The stale-produced-by-completion shape (`STALE_REF`
/// with `complete: true`, retryability derived) is what satisfies core's
/// hydration retry predicate so the fresh re-observation fires.
fn anchor_descent_verdict(failure: UiaFailure) -> DescentVerdict {
    match uia_failure_disposition(failure) {
        ReadDisposition::SettledAbsence | ReadDisposition::Unavailable => DescentVerdict::Settled,
        ReadDisposition::Retryable | ReadDisposition::Terminal => DescentVerdict::Surfaced,
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_anchor_selector_wait_tests.rs"]
mod selector_wait_tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_anchor_count_agreement_tests.rs"]
mod count_agreement_tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_anchor_tests.rs"]
mod windows_only;
