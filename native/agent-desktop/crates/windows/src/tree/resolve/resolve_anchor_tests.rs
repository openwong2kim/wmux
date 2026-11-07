use super::*;
use crate::tree::element::UIAElement;
use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::resolve::resolve_search::descent::descend_path;
use crate::tree::walk::walker_fake::{deadline, ref_entry, scan_subtree};
use agent_desktop_core::{
    ErrorCode, IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence,
    NodeDescriptor, ProcessId, RefEntry,
};
use std::ops::ControlFlow;

fn blank_entry_with_path(fixture: &HostedFixture, path: Vec<usize>) -> RefEntry {
    let deadline = deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("a fixture root");
    let source =
        crate::tree::walk::walker_source::UiaTreeSource::for_root(&root).expect("a source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let budget = crate::tree::walk::walker::WalkBudget::new(10, deadline);
    let found = walk_first_secure(&source, &prepared, &budget)
        .expect("the fixture walk succeeds")
        .expect("a secure element exists");
    let stored_path = found.path;
    let evidence = found.evidence;
    let rect = evidence
        .ref_evidence
        .bounds
        .known()
        .expect("positive-area bounds");
    let hash = rect.bounds_hash().expect("a positive-area hash");
    let token =
        crate::system::process_identity::token_for_pid(ProcessId::new(fixture.process_id()))
            .unwrap()
            .expect("a live fixture token");
    let chosen_path = if path.is_empty() { stored_path } else { path };
    let mut entry = ref_entry(&evidence.role.known().cloned().unwrap_or_default());
    entry.process = agent_desktop_core::RefProcess {
        pid: ProcessId::new(fixture.process_id()),
        process_instance: Some(token),
    };
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: Some(*rect),
        bounds_hash: Some(hash),
    };
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(format!("w-{}", fixture.handle()));
    entry.scope.path_is_absolute = true;
    entry.scope.path = chosen_path.into();
    entry
}

struct FoundSecure {
    path: Vec<usize>,
    _properties: crate::tree::properties::ElementProperties,
    evidence: agent_desktop_core::LocatorEvidence,
    _failed: u64,
}

fn walk_first_secure(
    source: &crate::tree::walk::walker_source::UiaTreeSource,
    element: &UIAElement,
    budget: &crate::tree::walk::walker::WalkBudget,
) -> Result<Option<FoundSecure>, AdapterError> {
    scan_subtree(
        source,
        element,
        budget,
        10,
        &mut |prefix, properties, evidence, failed| {
            if properties.is_secure() {
                ControlFlow::Break(FoundSecure {
                    path: prefix.to_vec(),
                    _properties: properties,
                    evidence,
                    _failed: failed,
                })
            } else {
                ControlFlow::Continue(())
            }
        },
    )
}

/// A stored anchor path that is exact on the unchanged fixture resolves -
/// the hydration happy path.
#[test]
fn an_exact_anchor_path_resolves_on_the_unchanged_fixture() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let entry = blank_entry_with_path(&fixture, Vec::new());
    let handle = resolve_locator_anchor(&entry, deadline())
        .expect("the exact anchor path resolves the secure element");
    assert_verified_stamp(&handle, entry.process.pid.get(), &verified_token(&entry));
}

/// The anchor re-identifies nothing: the path and the landing's role are all it
/// checks, and core compares the recorded predicate against the handle the
/// anchor returns. An element that reports no name, no identifier and no usable
/// bounds - the one unnamed textfield a complete observation can still prove
/// unique - therefore has to land instead of being refused before the walk.
#[test]
fn an_entry_with_no_identity_and_no_usable_geometry_still_lands() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let mut entry = blank_entry_with_path(&fixture, Vec::new());
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds: None,
        bounds_hash: None,
    };

    let handle = resolve_locator_anchor(&entry, deadline())
        .expect("the anchor lands the stored path and leaves identity to core");
    assert_verified_stamp(&handle, entry.process.pid.get(), &verified_token(&entry));
}

/// Every handle the anchor hands back carries the ref's verified process
/// identity, so the shared live read can corroborate that the provider
/// answering is still the generation resolution verified.
///
/// Without the stamp the corroboration is skipped for every resolved handle,
/// and A14-9's finding - a dead provider's reads succeeding empty on some
/// builds - lands as an answer rather than a `STALE_REF`. The live-read tests
/// build their own stamp, so nothing there notices a resolver that stops
/// producing one; this is the assertion that sees it.
fn assert_verified_stamp(handle: &NativeHandle, pid: u32, token: &str) {
    let resolved = handle
        .downcast_ref::<UIAElement>()
        .expect("the resolved handle carries a UI Automation element");
    assert_eq!(
        resolved.verified_process(),
        Some((pid, token)),
        "the anchor must stamp the ref's verified process identity onto the handle it returns"
    );
}

fn verified_token(entry: &RefEntry) -> String {
    entry.process.process_instance.clone().unwrap_or_default()
}

/// A path that points at a sibling beyond the target settles stale in a
/// single attempt - the anchor never resolves a neighbour, and never
/// replays a landing that was never eligible to resolve.
#[test]
fn a_wrong_child_index_settles_stale_never_a_neighbour() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let entry = blank_entry_with_path(&fixture, vec![999]);
    let deadline = deadline();
    let attempts = std::cell::Cell::new(0);
    let result = crate::tree::resolve::retry_incomplete_until(deadline, || {
        attempts.set(attempts.get() + 1);
        resolve_locator_anchor_once(&entry, deadline)
    });
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("a path that lands nowhere settles, it does not resolve"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        attempts.get(),
        1,
        "a path that lands nowhere must settle on the first attempt, never retried"
    );
}

/// A role-refuted landing settles stale: the stored ref records the secure
/// element's role, the path lands on the fixture's button, and the anchor
/// refuses - the path is a locator, never an identity by itself.
#[test]
fn a_role_refuted_landing_settles_stale() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let entry = blank_entry_with_path(&fixture, vec![0]);
    let deadline = deadline();
    let root = crate::tree::automation::root_from_hwnd(fixture.handle(), deadline)
        .expect("a fixture root");
    let source =
        crate::tree::walk::walker_source::UiaTreeSource::for_root(&root).expect("a source");
    let prepared = source.prepare_root(&root).expect("a prepared root");
    let landed = descend_path(
        &source,
        &prepared,
        &entry.scope.path,
        &crate::tree::walk::walker::WalkBudget::new(10, deadline),
        &ANCHOR_DESCENT,
    )
    .expect("the stored path descends")
    .expect("the stored path must land on a live element for the role guard to be what refuses it");
    let (_, evidence, _) = source.evidence(&landed);
    assert!(
        evidence
            .role
            .known()
            .is_some_and(|role| role != &entry.identity.role),
        "the landing must carry a known role different from the stored ref's"
    );

    let error = match resolve_locator_anchor(&entry, deadline) {
        Err(error) => error,
        Ok(_) => panic!("a role-refuted landing settles stale, it does not resolve"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
}

fn locator_entry(role: &str) -> RefEntry {
    let mut entry = ref_entry(role);
    entry.scope.path_is_absolute = true;
    entry
}

fn locator_evidence(role: &str) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.to_string()),
        name: LocatorField::Absent,
        value: LocatorField::Absent,
        description: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Absent,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Absent,
            descriptors: NodeDescriptor::default(),
        },
    }
}

/// Pins the fix for a tri-state defect where a failed role read was treated
/// the same as a settled role mismatch. A role read that comes back
/// `Unknown` must stay retryable, never a settled `STALE_REF`.
#[test]
fn a_role_read_that_comes_back_unknown_is_retryable_not_settled() {
    let entry = locator_entry("button");
    let mut unknown_role_evidence = locator_evidence("button");
    unknown_role_evidence.role = LocatorField::Unknown;

    let error = match anchor_role_verdict(&entry, &unknown_role_evidence) {
        Err(error) => error,
        Ok(()) => panic!("an unknown role must never verify as a match"),
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(error.is_transient_incomplete_read());
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("retryable"))
            .and_then(serde_json::Value::as_bool),
        Some(true),
        "a role read that failed must be stamped explicitly retryable"
    );
}

/// The role guard's other settled branch, for contrast: a role that was
/// read successfully but disagrees with the stored ref settles stale.
#[test]
fn a_known_but_mismatched_role_settles_stale() {
    let entry = locator_entry("button");
    let evidence = locator_evidence("checkbox");

    let error = match anchor_role_verdict(&entry, &evidence) {
        Err(error) => error,
        Ok(()) => panic!("a mismatched role must never verify as a match"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
}
