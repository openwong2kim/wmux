use super::{LocatorResolution, ObservationRequest, ObservationRoot, ObservedNode, ObservedTree};
use crate::{
    AdapterError, AppError, ErrorCode, IdentityMatch, adapter::PlatformAdapter,
    locator::LocatorQuery, refs::RefEntry, refs::RefMap,
};
use serde_json::json;

pub(super) fn retryable_error(error: &AdapterError) -> bool {
    if !error.permits_retry_by_default() {
        return false;
    }
    matches!(
        error.code,
        ErrorCode::StaleRef
            | ErrorCode::AmbiguousTarget
            | ErrorCode::ElementNotFound
            | ErrorCode::Timeout
            | ErrorCode::AppUnresponsive
    )
}

/// Resolves each selected match to the entry it is published under.
///
/// The saved entry keeps the identity the whole-window read recorded and proved
/// unique, and the landing is checked against it. Fields hydration read beyond
/// that identity describe the match in the response only: a proof is never
/// carried onto a predicate wider than the one it was measured for.
pub(super) fn selected_matches(
    adapter: &dyn PlatformAdapter,
    query: &LocatorQuery,
    request: &super::LocatorResolveRequest,
    resolution: &mut LocatorResolution,
    observed: &ObservedTree,
) -> Result<(), AppError> {
    let deadline = request.deadline;
    let proof = crate::refs::ref_capture_proof::CaptureProof::new(observed);
    let mut refmap = RefMap::new();
    for matched in &mut resolution.matches {
        ensure_remaining(deadline)?;
        let preliminary = matched.entry.clone();
        let bounds_space = preliminary.geometry.bounds_space.unwrap_or_default();
        let has_identity = crate::refs::ref_identity::has_meaningful_identity(&preliminary);
        let has_bounds = preliminary.geometry.bounds_hash.is_some();
        let index = matched.document_order as usize;
        let proven = proof.proves_node(&preliminary, index);
        tracing::debug!(
            role = preliminary.identity.role,
            path_len = preliminary.scope.path.len(),
            has_identity,
            has_bounds,
            "hydrating selected locator anchor"
        );
        if !proven && !has_identity && !has_bounds {
            return Err(anchor_missing(&preliminary).into());
        }
        if matched.fully_observed {
            let name = preliminary.identity.name.clone().unwrap_or_default();
            let value = preliminary.identity.value.clone();
            record_match(matched, preliminary, name, value, &mut refmap)?;
            continue;
        }
        let handle = adapter.resolve_locator_anchor(&preliminary, deadline)?;
        ensure_remaining(deadline)?;
        let hydration_root = ObservationRoot::Element {
            handle: &handle,
            entry: &preliminary,
            root_ref: None,
        };
        let mut hydrated = crate::tree::renderer_accessibility::observe_tree(
            adapter,
            hydration_root,
            &ObservationRequest::selected_hydration(query, request, hydration_root, deadline)
                .validate()?,
            None,
        )?;
        hydrated.stats.reads.counts.observation_attempts =
            hydrated.stats.reads.counts.observation_attempts.max(1);
        resolution.stats.merge_observation(&hydrated.stats);
        if hydrated.roots.len() != 1 {
            return Err(evidence_incomplete(&hydrated, None, query, bounds_space).into());
        }
        let root_index = hydrated.roots[0] as usize;
        let (entry, name, value, root_order, screen_bounds) = {
            let node = hydrated
                .nodes
                .get(root_index)
                .ok_or_else(|| AdapterError::internal("hydrated locator root is missing"))?;
            if !evidence_complete(query, node, bounds_space) {
                return Err(evidence_incomplete(&hydrated, Some(node), query, bounds_space).into());
            }
            if node.evidence.role.known().map(String::as_str)
                != Some(preliminary.identity.role.as_str())
                || !anchor_matches(&preliminary, node, proven)
            {
                return Err(changed_during_hydration().into());
            }
            let entry = RefEntry {
                identity: preliminary.identity.clone(),
                ..super::materialize::ref_entry(node, &hydrated.source, query)
            };
            let name = node.evidence.name.meaningful_string().unwrap_or_default();
            let value = node.evidence.value.meaningful_string();
            let screen_bounds = super::materialize::screen_bounds(&node.evidence);
            (entry, name, value, node.document_order, screen_bounds)
        };
        let validation = super::evaluate_locator_tree(
            hydrated,
            query,
            &super::LocatorResolveRequest {
                selection: super::LocatorSelection::First,
                surface: None,
                materialization: super::LocatorMaterialization::None,
                ..*request
            },
        )?;
        resolution.stats.merge_evaluation(&validation.stats);
        let root_is_authoritative = validation.meta.selection_complete
            && validation
                .matches
                .first()
                .is_some_and(|candidate| candidate.document_order == root_order);
        if !root_is_authoritative {
            if validation.meta.complete {
                return Err(changed_during_hydration().into());
            }
            return Err(query_incomplete(&validation).into());
        }
        matched.screen_bounds = screen_bounds.or(matched.screen_bounds);
        record_match(matched, entry, name, value, &mut refmap)?;
    }
    resolution.refmap = Some(refmap);
    Ok(())
}

fn record_match(
    matched: &mut super::LocatorMatch,
    entry: RefEntry,
    name: String,
    value: Option<String>,
    refmap: &mut RefMap,
) -> Result<(), AppError> {
    matched.data.role = entry.identity.role.clone();
    matched.data.name = name;
    matched.data.value = value;
    matched.data.states = entry.capabilities.states.clone();
    matched.data.interactive = crate::refs::ref_alloc::is_ref_able_role_actions(
        &entry.identity.role,
        &entry.capabilities.available_actions,
    );
    if matched.data.interactive {
        matched.data.ref_id = Some(refmap.try_allocate(entry.clone())?);
    }
    matched.entry = entry;
    Ok(())
}

fn ensure_remaining(deadline: crate::Deadline) -> Result<(), AppError> {
    if deadline.remaining().is_zero() {
        return Err(
            AdapterError::timeout("Selected locator hydration exceeded its deadline").into(),
        );
    }
    Ok(())
}

fn evidence_complete(query: &LocatorQuery, node: &ObservedNode, space: crate::BoundsSpace) -> bool {
    !node.evidence.role.is_unknown()
        && (query.identity.name.is_none() || !node.evidence.name.is_unknown())
        && (query.identity.description.is_none() || !node.evidence.description.is_unknown())
        && (query.identity.value.is_none() || !node.evidence.value.is_unknown())
        && (query.identity.native_id.is_none() || node.evidence.identifiers.is_complete())
        && !node.evidence.states.is_unknown()
        && geometry_complete(&node.evidence.ref_evidence, space)
        && super::materialize::addressability(&node.evidence).1
}

pub(super) fn geometry_complete(
    evidence: &super::LocatorRefEvidence,
    space: crate::BoundsSpace,
) -> bool {
    match space {
        crate::BoundsSpace::Screen => !evidence.bounds.is_unknown(),
        crate::BoundsSpace::Window => {
            evidence.window_bounds.known().is_some()
                || (!evidence.window_bounds.is_unknown() && !evidence.bounds.is_unknown())
        }
    }
}

/// Whether the landed element is the one the anchored entry names.
///
/// An entry the whole-window read proved unique must match the full predicate
/// it was proven with, the same comparison a saved ref resolves under. A proof
/// that records no text identity and no geometry anchors on that predicate
/// alone. Every other entry, and a proven one that also records identity or
/// geometry, keeps those comparisons too.
fn anchor_matches(preliminary: &RefEntry, node: &ObservedNode, proven: bool) -> bool {
    let geometry = &node.evidence.ref_evidence;
    let actual_bounds_hash = match preliminary.geometry.bounds_space.unwrap_or_default() {
        crate::BoundsSpace::Window => &geometry.window_bounds,
        crate::BoundsSpace::Screen => &geometry.bounds,
    }
    .known()
    .and_then(crate::Rect::bounds_hash);
    let has_identity = crate::refs::ref_identity::has_meaningful_identity(preliminary);
    if proven {
        let landed = crate::refs::ref_full_predicate::FullPredicate::of_entry(preliminary).compare(
            &crate::refs::ref_live_predicate::LivePredicate::observed(&node.evidence),
        );
        if landed != IdentityMatch::Match {
            return false;
        }
        if !has_identity && preliminary.geometry.bounds_hash.is_none() {
            return true;
        }
    }
    if has_identity {
        return match crate::refs::ref_identity::identity_match(
            preliminary,
            &node.evidence.name,
            &node.evidence.value,
            &node.evidence.description,
            &node.evidence.identifiers,
        ) {
            IdentityMatch::Match => true,
            IdentityMatch::NoMatch => false,
            IdentityMatch::Unknown if preliminary.identity.retained_object.is_some() => false,
            IdentityMatch::Unknown => preliminary
                .geometry
                .bounds_hash
                .is_none_or(|expected| actual_bounds_hash == Some(expected)),
        };
    }
    preliminary.geometry.bounds_hash.is_some()
        && preliminary.geometry.bounds_hash == actual_bounds_hash
}

fn anchor_missing(entry: &RefEntry) -> AdapterError {
    AdapterError::new(
        ErrorCode::StaleRef,
        "Selected locator lacks a verifiable identity or geometry anchor",
    )
    .with_suggestion("Use a locator that resolves to an element with stable identity or bounds")
    .with_details(json!({
        "kind": "locator_selected_anchor_missing",
        "retryable": false,
        "role": entry.identity.role,
        "path_len": entry.scope.path.len(),
        "has_identity": crate::refs::ref_identity::has_meaningful_identity(entry),
        "has_bounds": entry.geometry.bounds_hash.is_some(),
    }))
    .with_disposition(crate::DeliverySemantics::not_delivered())
}

fn changed_during_hydration() -> AdapterError {
    AdapterError::new(
        ErrorCode::StaleRef,
        "Selected locator changed during hydration",
    )
    .with_suggestion("Retry the locator against the current accessibility tree")
    .with_disposition(crate::DeliverySemantics::not_delivered())
}

fn query_incomplete(validation: &LocatorResolution) -> AdapterError {
    let deterministic = super::resolve::has_deterministic_limit(&validation.stats);
    AdapterError::timeout("Selected locator query could not be revalidated")
        .with_suggestion("Retry against a stable subtree or use a narrower locator")
        .with_details(json!({
            "kind": if deterministic {
                "locator_selected_query_budget_limit"
            } else {
                "locator_selected_query_incomplete"
            },
            "retryable": !deterministic,
            "selection_complete": validation.meta.selection_complete,
            "observed_matches": validation.meta.total_matches,
            "query_stats": &validation.stats,
        }))
        .with_disposition(crate::DeliverySemantics::not_delivered())
}

fn evidence_incomplete(
    tree: &ObservedTree,
    node: Option<&ObservedNode>,
    query: &LocatorQuery,
    space: crate::BoundsSpace,
) -> AdapterError {
    AdapterError::timeout("Selected locator evidence was incomplete")
        .with_details(json!({
            "kind": "locator_selected_evidence_incomplete",
            "retryable": true,
            "structurally_complete": tree.structurally_complete,
            "root_count": tree.roots.len(),
            "required": {
                "name": query.identity.name.is_some(),
                "description": query.identity.description.is_some(),
                "value": query.identity.value.is_some(),
                "identifiers": query.identity.native_id.is_some(),
                "states": true,
                "bounds": true,
                "actions": true,
            },
            "unknown": node.map(|node| json!({
                "role": node.evidence.role.is_unknown(),
                "name": node.evidence.name.is_unknown(),
                "description": node.evidence.description.is_unknown(),
                "value": node.evidence.value.is_unknown(),
                "identifiers": !node.evidence.identifiers.is_complete(),
                "states": node.evidence.states.is_unknown(),
                "bounds": !geometry_complete(&node.evidence.ref_evidence, space),
                "actions": node.evidence.ref_evidence.available_actions.is_unknown(),
            })),
            "query_stats": &tree.stats,
        }))
        .with_disposition(crate::DeliverySemantics::not_delivered())
}

#[cfg(test)]
#[path = "hydrate_tests.rs"]
mod tests;
