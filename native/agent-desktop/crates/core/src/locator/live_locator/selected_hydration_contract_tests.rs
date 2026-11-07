use super::test_support::window;
use super::{
    IdentifierEvidence, LocatorField, LocatorMaterialization, LocatorResolveRequest,
    LocatorSelection, ObservationRequest, ObservationRoot, ObservationSource, ObservedTree,
    resolve_query,
};
use crate::{
    AdapterError, AppError, LocatorQuery, NativeHandle, Rect,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    OptionalIdentityUnknown,
    MissingAnchor,
    UnprovenMissingAnchor,
    ProvenIdentity,
    RequiredNameUnknown,
    RequiredDescriptionUnknown,
    HydrationAddsName,
}

struct HydrationContractAdapter {
    mode: Mode,
    window_observations: AtomicUsize,
    strict_resolutions: AtomicUsize,
    hydration_observations: AtomicUsize,
}

impl ObservationOps for HydrationContractAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        match root {
            ObservationRoot::Application { .. } => panic!("expected a window or element root"),
            ObservationRoot::Window(_) => {
                self.window_observations.fetch_add(1, Ordering::SeqCst);
                Ok(initial_tree(self.mode))
            }
            ObservationRoot::Element { .. } => {
                self.hydration_observations.fetch_add(1, Ordering::SeqCst);
                let root_evidence = request.evidence_for_raw_depth(0);
                assert!(root_evidence.states);
                assert!(root_evidence.ref_evidence.bounds);
                assert!(root_evidence.ref_evidence.actions);
                Ok(hydrated_tree(root, self.mode))
            }
        }
    }

    fn resolve_locator_anchor(
        &self,
        entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.strict_resolutions.fetch_add(1, Ordering::SeqCst);
        assert!(
            entry.identity.unique_at_capture
                || crate::refs::ref_identity::has_meaningful_identity(entry)
                || entry.geometry.bounds_hash.is_some()
        );
        Ok(NativeHandle::null())
    }

    fn list_windows(
        &self,
        _filter: &crate::adapter::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        Ok(vec![window()])
    }
}

impl ActionOps for HydrationContractAdapter {}
impl InputOps for HydrationContractAdapter {}
impl SystemOps for HydrationContractAdapter {}

#[test]
fn role_only_geometry_anchor_accepts_unknown_optional_identity_once() {
    let adapter = adapter(Mode::OptionalIdentityUnknown);

    let resolution = resolve_query(
        &adapter,
        &role_query(),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .expect("optional identity gaps must not invalidate a verified geometry anchor");

    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);
    assert!(resolution.matches[0].data.name.is_empty());
    assert!(
        serde_json::to_value(&resolution.matches[0].data)
            .unwrap()
            .get("name")
            .is_none()
    );
    let entry = resolution.refmap.unwrap().get("@e1").unwrap().clone();
    assert_eq!(entry.identity.name, None);
    assert_eq!(entry.geometry.bounds, Some(bounds()));
}

/// An entry the whole-window read proved unique needs no text identity and no
/// geometry of its own: its full predicate is the anchor the landing read is
/// checked against, and the published ref carries that proof so it can resolve
/// again. The legacy prerequisites would have refused it before hydrating.
#[test]
fn a_capture_proven_path_only_anchor_is_admitted_and_published_proven() {
    let adapter = adapter(Mode::MissingAnchor);

    let resolution = resolve_query(
        &adapter,
        &role_query(),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .expect("a role-only element counted once by the whole-window read is addressable");

    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);
    let entry = resolution.refmap.unwrap().get("@e1").unwrap().clone();
    assert_eq!(entry.identity.name, None);
    assert_eq!(entry.geometry.bounds, Some(bounds()));
    assert!(entry.identity.unique_at_capture);
}

/// Hydration re-materializes the entry from a second read, so it must carry the
/// proof the whole-window read already gave the match: an entry whose identity
/// the window answered is published unique, and the published ref resolves
/// again. Losing that proof would hand the caller a ref that fails on its next
/// use, even though the element never left the window.
#[test]
fn a_hydrated_entry_keeps_the_capture_proof_and_its_ref_resolves() {
    let adapter = adapter(Mode::ProvenIdentity);

    let resolution = resolve_query(
        &adapter,
        &role_query(),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .expect("the identity the window read answered survives hydration");
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);

    let entry = resolution.refmap.unwrap().get("@e1").unwrap().clone();
    assert_eq!(entry.identity.name.as_deref(), Some("Save"));
    assert!(
        entry.identity.unique_at_capture,
        "hydration must keep the proof the whole-window read gave the match"
    );

    let anchored = adapter.strict_resolutions.load(Ordering::SeqCst);
    crate::refs::resolve_saved_ref::resolve_saved_ref(
        &adapter,
        &entry,
        crate::Deadline::standard().unwrap(),
        None,
    )
    .expect("the published ref re-identifies the element it was proven from");
    assert_eq!(
        adapter.strict_resolutions.load(Ordering::SeqCst),
        anchored + 1,
        "the ref lands through one positional anchor"
    );
}

/// Hydration can read a name the window read did not. The match shows it, but
/// the saved ref keeps the predicate the whole-window read proved unique, so
/// the published ref resolves instead of failing as an unproven enriched one.
#[test]
fn a_name_hydration_adds_is_shown_while_the_saved_ref_keeps_its_proof() {
    let adapter = adapter(Mode::HydrationAddsName);

    let resolution = resolve_query(
        &adapter,
        &role_query(),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .expect("a name only hydration read must not invalidate the match");
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);
    assert_eq!(resolution.matches[0].data.name, "Save");

    let entry = resolution.refmap.unwrap().get("@e1").unwrap().clone();
    assert_eq!(entry.identity.name, None);
    assert!(entry.identity.unique_at_capture);
    crate::refs::resolve_saved_ref::resolve_saved_ref(
        &adapter,
        &entry,
        crate::Deadline::standard().unwrap(),
        None,
    )
    .expect("the published ref resolves under the predicate it was proven with");
}

#[test]
fn selected_path_without_identity_or_geometry_rejects_without_retrying() {
    let adapter = adapter(Mode::UnprovenMissingAnchor);

    let error = resolve_query(
        &adapter,
        &role_query(),
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .err()
    .expect("an anchor the whole-window read could not prove must fail closed");
    let error = adapter_error(error);

    assert_eq!(error.code.as_str(), "STALE_REF");
    assert_eq!(error.details.as_ref().unwrap()["retryable"], false);
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "locator_selected_anchor_missing"
    );
    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 0);
}

#[test]
fn name_query_rejects_unknown_hydrated_name() {
    let query = LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("button".into()),
            name: Some("Save".into()),
            ..Default::default()
        },
        ..Default::default()
    };

    assert_required_field_rejected(Mode::RequiredNameUnknown, query, "name");
}

#[test]
fn description_query_rejects_unknown_hydrated_description() {
    let query = LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("button".into()),
            description: Some("Primary".into()),
            ..Default::default()
        },
        ..Default::default()
    };

    assert_required_field_rejected(Mode::RequiredDescriptionUnknown, query, "description");
}

fn assert_required_field_rejected(mode: Mode, query: LocatorQuery, field: &str) {
    let adapter = adapter(mode);
    let error = resolve_query(
        &adapter,
        &query,
        ObservationRoot::Window(&window()),
        &selected_request(),
    )
    .err()
    .expect("query-requested identity evidence must remain authoritative");
    let error = adapter_error(error);
    let details = error.details.as_ref().unwrap();

    assert_eq!(error.code.as_str(), "TIMEOUT");
    assert_eq!(details["kind"], "locator_selected_evidence_incomplete");
    assert_eq!(details["required"][field], true);
    assert_eq!(details["unknown"][field], true);
    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 2);
}

fn adapter(mode: Mode) -> HydrationContractAdapter {
    HydrationContractAdapter {
        mode,
        window_observations: AtomicUsize::new(0),
        strict_resolutions: AtomicUsize::new(0),
        hydration_observations: AtomicUsize::new(0),
    }
}

fn initial_tree(mode: Mode) -> ObservedTree {
    let mut evidence = evidence(mode, false);
    evidence.ref_evidence.bounds = match mode {
        Mode::MissingAnchor | Mode::UnprovenMissingAnchor => LocatorField::Absent,
        _ => LocatorField::Known(bounds()),
    };
    if mode == Mode::UnprovenMissingAnchor {
        return super::test_support::tree(
            vec![
                super::test_support::node(0, evidence.clone(), vec![1], &[]),
                super::test_support::node(1, evidence, Vec::new(), &[0]),
            ],
            vec![0],
            true,
        );
    }
    super::test_support::tree(
        vec![super::test_support::node(0, evidence, Vec::new(), &[])],
        vec![0],
        true,
    )
}

fn hydrated_tree(root: ObservationRoot<'_>, mode: Mode) -> ObservedTree {
    let mut evidence = evidence(mode, true);
    evidence.states = LocatorField::Known(Vec::new());
    evidence.ref_evidence.bounds = LocatorField::Known(bounds());
    evidence.ref_evidence.available_actions =
        LocatorField::Known(vec![crate::actions::capability::CLICK.into()]);
    let mut tree = super::test_support::tree(
        vec![super::test_support::node(0, evidence, Vec::new(), &[])],
        vec![0],
        true,
    );
    tree.source = ObservationSource::from_root(&root, crate::SnapshotSurface::Window);
    tree
}

fn evidence(mode: Mode, hydrating: bool) -> super::LocatorEvidence {
    let mut evidence = super::test_support::evidence("button", None);
    evidence.name = match mode {
        Mode::RequiredNameUnknown if !hydrating => LocatorField::Known("Save".into()),
        Mode::HydrationAddsName if hydrating => LocatorField::Known("Save".into()),
        Mode::RequiredNameUnknown
        | Mode::HydrationAddsName
        | Mode::OptionalIdentityUnknown
        | Mode::MissingAnchor
        | Mode::UnprovenMissingAnchor => LocatorField::Unknown,
        Mode::ProvenIdentity | Mode::RequiredDescriptionUnknown => {
            LocatorField::Known("Save".into())
        }
    };
    evidence.description = match mode {
        Mode::RequiredDescriptionUnknown if !hydrating => LocatorField::Known("Primary".into()),
        Mode::RequiredDescriptionUnknown
        | Mode::HydrationAddsName
        | Mode::OptionalIdentityUnknown
        | Mode::MissingAnchor
        | Mode::UnprovenMissingAnchor => LocatorField::Unknown,
        Mode::RequiredNameUnknown => LocatorField::Known("Primary".into()),
        Mode::ProvenIdentity => LocatorField::Absent,
    };
    evidence.identifiers = IdentifierEvidence::absent();
    evidence.states = LocatorField::Unknown;
    evidence.ref_evidence.available_actions = LocatorField::Unknown;
    evidence
}

fn role_query() -> LocatorQuery {
    LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("button".into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn selected_request() -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::First,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    }
}

fn adapter_error(error: AppError) -> AdapterError {
    match error {
        AppError::Adapter(error) => error,
        other => panic!("expected adapter error, got {other}"),
    }
}

fn bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 30.0,
    }
}
