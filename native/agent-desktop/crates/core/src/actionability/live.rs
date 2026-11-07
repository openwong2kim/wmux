use super::{
    evaluate::{check_with_stability, check_with_stability_or_gap},
    evidence::ActionabilityEvidence,
    report::ActionabilityReport,
    stability::StabilityExpectation,
};
use crate::{
    AdapterError, DeliverySemantics, ErrorCode, IdentityMatch, LocatorEvidence, LocatorField,
    actions::action_request::ActionRequest,
    adapter::{LiveElement, NativeHandle, PlatformAdapter},
    locator::live_locator::LocatorRefEvidence,
    refs::RefEntry,
    refs::ref_full_predicate::FullPredicate,
    refs::ref_identity::{element_token, identity_match},
    refs::ref_live_predicate::LivePredicate,
};

/// Groups the read-only coordinates of a live element check: which element,
/// which handle to read it through, which adapter to read with, and the
/// deadline that bounds the read. Kept separate from the `request` (what
/// action to check against) and `stability` (how settled the element must
/// be) parameters, which vary independently per call.
pub(crate) struct LiveCheckTarget<'a> {
    pub(crate) entry: &'a RefEntry,
    pub(crate) handle: &'a NativeHandle,
    pub(crate) adapter: &'a dyn PlatformAdapter,
    pub(crate) deadline: crate::Deadline,
}

#[cfg(test)]
pub(crate) fn check_live(
    entry: &RefEntry,
    handle: &NativeHandle,
    adapter: &dyn PlatformAdapter,
    request: &ActionRequest,
) -> Result<ActionabilityReport, AdapterError> {
    let deadline = crate::Deadline::standard()?;
    check_live_with_stability(
        &LiveCheckTarget {
            entry,
            handle,
            adapter,
            deadline,
        },
        request,
        StabilityExpectation::permissive(entry.geometry.bounds_hash),
    )
}

pub(crate) fn check_live_with_stability(
    target: &LiveCheckTarget<'_>,
    request: &ActionRequest,
    stability: StabilityExpectation,
) -> Result<ActionabilityReport, AdapterError> {
    let evidence =
        observe(target).map_err(crate::ref_action::mark_pre_dispatch_resolution_failure)?;
    check_with_stability(
        stability,
        &evidence,
        request,
        Some((target.handle, target.adapter)),
        target.deadline,
    )
    .map_err(crate::ref_action::mark_pre_dispatch_resolution_failure)
}

/// [`check_live_with_stability`]'s report-preserving counterpart - see
/// [`check_with_stability_or_gap`] for why `stable_preflight` needs it.
pub(crate) fn check_live_with_stability_or_gap(
    target: &LiveCheckTarget<'_>,
    request: &ActionRequest,
    stability: StabilityExpectation,
) -> Result<ActionabilityReport, AdapterError> {
    let evidence = observe(target)?;
    check_with_stability_or_gap(
        stability,
        &evidence,
        request,
        Some((target.handle, target.adapter)),
        target.deadline,
    )
}

pub(crate) fn check_live_before_focus(
    target: &LiveCheckTarget<'_>,
    request: &ActionRequest,
    stability: StabilityExpectation,
) -> Result<ActionabilityReport, AdapterError> {
    let evidence =
        observe(target).map_err(crate::ref_action::mark_pre_dispatch_resolution_failure)?;
    super::evaluate::check_before_focus(
        stability,
        &evidence,
        request,
        Some((target.handle, target.adapter)),
        target.deadline,
    )
    .map_err(crate::ref_action::mark_pre_dispatch_resolution_failure)
}

fn observe(target: &LiveCheckTarget<'_>) -> Result<ActionabilityEvidence, AdapterError> {
    let live = match target
        .adapter
        .get_live_element(target.handle, target.deadline)
    {
        Ok(live) => live,
        Err(err)
            if matches!(
                err.code,
                ErrorCode::PlatformNotSupported | ErrorCode::ActionNotSupported
            ) =>
        {
            return Err(AdapterError::new(
                ErrorCode::ActionNotSupported,
                "Live element evidence is required for actionability checks",
            )
            .with_details(serde_json::json!({ "source_code": err.code.as_str() }))
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        Err(err) => return Err(err),
    };
    validate_live_identity(target.entry, &live)?;
    Ok(ActionabilityEvidence {
        nonspatial: live.bounds.is_none()
            && target
                .adapter
                .is_nonspatial_target_with_deadline(target.handle, target.deadline)?,
        state: live.state,
        states_complete: live.states_complete,
        bounds: live.bounds,
        available_actions: live.available_actions,
    })
}

fn validate_live_identity(entry: &RefEntry, live: &LiveElement) -> Result<(), AdapterError> {
    if live.state.role == "unknown" || live.state.role != entry.identity.role {
        return Err(stale_live_element(
            "Resolved element changed role before dispatch",
        ));
    }
    match recorded_identity_match(entry, &live_evidence(live)) {
        IdentityMatch::Match => Ok(()),
        IdentityMatch::NoMatch => Err(stale_live_element(
            "Resolved element changed identity before dispatch",
        )),
        IdentityMatch::Unknown => Err(AdapterError::app_unresponsive(
            entry
                .source
                .source_app
                .as_deref()
                .unwrap_or("target application"),
        )
        .with_details(serde_json::json!({
            "kind": "live_identity_evidence",
            "complete": false,
            "retryable": true,
        }))),
    }
}

/// The identity rule the capture recorded. An entry carrying an element token
/// re-identifies itself through that token; every other entry is held to the
/// whole predicate - role, identifier and stable text - that resolution
/// compares, because an identifier alone still matches after the element it
/// named was replaced by one that kept the identifier and changed its text.
fn recorded_identity_match(entry: &RefEntry, live: &LocatorEvidence) -> IdentityMatch {
    if element_token(entry).is_some() {
        return identity_match(
            entry,
            &live.name,
            &live.value,
            &live.description,
            &live.identifiers,
        );
    }
    FullPredicate::of_entry(entry).compare(&LivePredicate::observed(live))
}

/// The live read as the evidence a predicate compares: the identity slots it
/// holds, with the geometry and state slots of a snapshot observation left
/// unread because no identity rule reads them.
fn live_evidence(live: &LiveElement) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(live.state.role.clone()),
        name: live.identity.name.clone(),
        description: live.identity.description.clone(),
        value: live
            .state
            .value
            .clone()
            .map(LocatorField::Known)
            .unwrap_or(LocatorField::Absent),
        identifiers: live.identity.identifiers.clone(),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            bounds: LocatorField::Absent,
            window_bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(live.available_actions.clone()),
            descriptors: Default::default(),
        },
    }
}

fn stale_live_element(message: &'static str) -> AdapterError {
    AdapterError::new(ErrorCode::StaleRef, message)
        .with_suggestion(
            "Re-run a snapshot to obtain fresh refs, then retry with the new ref (CLI: snapshot; FFI: ad_snapshot then ad_execute_by_ref with the returned qualified @<snapshot_id>:eN ref)",
        )
        .with_details(serde_json::json!({ "retryable": true }))
        .with_disposition(DeliverySemantics::not_delivered())
}
