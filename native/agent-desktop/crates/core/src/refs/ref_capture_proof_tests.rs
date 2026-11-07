use crate::locator::live_locator::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
    ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
};
use crate::refs::ref_alloc::allocate_refs;
use crate::refs::ref_alloc_config::RefAllocConfig;
use crate::refs::ref_alloc_options::RefAllocOptions;
use crate::refs::ref_alloc_scope::RefAllocScope;
use crate::refs::ref_alloc_source::RefAllocSource;
use crate::refs::ref_capture_proof::CaptureProof;
use crate::{AccessibilityNode, ElementIdentifier, IdentifierKind, RefMap, WindowInfo};

fn named(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

fn window(children: Vec<AccessibilityNode>) -> AccessibilityNode {
    let mut root = named("window", "Fixture");
    root.children = children;
    root
}

fn fixture_window() -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "Fixture".into(),
        pid: crate::ProcessId::new(1),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

fn config<'a>(capture: &'a CaptureProof<'a>) -> RefAllocConfig<'a> {
    RefAllocConfig {
        options: RefAllocOptions {
            include_bounds: false,
            interactive_only: false,
            compact: false,
            force_renderer_accessibility: false,
        },
        source: RefAllocSource {
            pid: crate::ProcessId::new(1),
            app: Some("Test"),
            window_id: None,
            window_title: Some("Test Window"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::SnapshotSurface::Window,
        },
        scope: RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
        capture: Some(capture),
    }
}

fn flags(root: AccessibilityNode, observed: &ObservedTree) -> Vec<bool> {
    let proof = CaptureProof::new(observed);
    let mut refmap = RefMap::new();
    allocate_refs(root, &mut refmap, &config(&proof)).unwrap();
    (1..=refmap.len())
        .filter_map(|index| refmap.get(&format!("@e{index}")))
        .map(|entry| entry.identity.unique_at_capture)
        .collect()
}

fn observed_from(root: AccessibilityNode) -> ObservedTree {
    let window = fixture_window();
    crate::adapter::observed_tree(&ObservationRoot::Window(&window), root)
        .expect("the fixture observes")
}

fn evidence(
    role: &str,
    name: &str,
    ids: Vec<ElementIdentifier>,
    preferred: usize,
) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.into()),
        name: LocatorField::Known(name.into()),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::typed(ids, Some(preferred), true),
        states: LocatorField::Known(Vec::new()),
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(Vec::new()),
            descriptors: Default::default(),
        },
    }
}

fn identifier(kind: IdentifierKind, value: &str) -> ElementIdentifier {
    ElementIdentifier {
        kind,
        value: value.into(),
    }
}

fn twin_carrying_the_identifier_secondhand() -> (AccessibilityNode, ObservedTree) {
    let mut captured = named("button", "Send");
    captured.identity.native_id = Some(identifier(IdentifierKind::AxIdentifier, "x-1"));
    let mut twin = named("button", "Send");
    twin.identity.native_id = Some(identifier(IdentifierKind::AxDomIdentifier, "dom-2"));

    let observed = ObservedTree::from_roots(
        vec![ObservedSubtree::new(
            evidence("window", "Fixture", Vec::new(), 0),
            vec![
                ObservedSubtree::new(
                    evidence(
                        "button",
                        "Send",
                        vec![identifier(IdentifierKind::AxIdentifier, "x-1")],
                        0,
                    ),
                    Vec::new(),
                    true,
                    None,
                ),
                ObservedSubtree::new(
                    evidence(
                        "button",
                        "Send",
                        vec![
                            identifier(IdentifierKind::AxDomIdentifier, "dom-2"),
                            identifier(IdentifierKind::AxIdentifier, "x-1"),
                        ],
                        0,
                    ),
                    Vec::new(),
                    true,
                    None,
                ),
            ],
            true,
            None,
        )],
        ObservationSource::Window {
            window: fixture_window(),
            surface: crate::SnapshotSurface::Window,
            renderer_accessibility_forced: false,
        },
        LocatorStats::default(),
        true,
    )
    .expect("the fixture observes");

    (window(vec![captured, twin]), observed)
}

#[test]
fn a_complete_observation_marks_the_entry_it_found_once() {
    let root = window(vec![
        named("button", "Send"),
        named("button", "Send"),
        named("button", "Cancel"),
    ]);
    let observed = observed_from(root.clone());

    assert_eq!(flags(root, &observed), [false, false, true]);
}

#[test]
fn an_identifier_a_twin_carries_secondhand_is_not_unique() {
    let (root, observed) = twin_carrying_the_identifier_secondhand();

    assert_eq!(flags(root, &observed), [false, true]);
}

#[test]
fn find_marks_only_a_whole_window_match_found_once() {
    let observed = observed_from(window(vec![
        named("button", "Send"),
        named("button", "Send"),
        named("button", "Cancel"),
    ]));
    let proof = CaptureProof::new(&observed);
    let proven: Vec<_> = observed
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.evidence.role.known().map(String::as_str) == Some("button"))
        .filter(|(index, node)| {
            let entry = crate::locator::live_locator::materialize_ref_entry(
                node,
                &observed.source,
                &crate::locator::LocatorQuery::default(),
            );
            proof.proves_node(&entry, *index)
        })
        .filter_map(|(_, node)| node.evidence.name.meaningful_string())
        .collect();
    assert_eq!(proven, ["Cancel"]);
}

fn twin_buttons_sharing_a_secondary_identifier() -> ObservedTree {
    let shared = || {
        vec![
            identifier(IdentifierKind::AxIdentifier, "shared"),
            identifier(IdentifierKind::AxDomIdentifier, "dom-a"),
        ]
    };
    let mut second = shared();
    second[1] = identifier(IdentifierKind::AxDomIdentifier, "dom-b");
    ObservedTree::from_roots(
        vec![ObservedSubtree::new(
            evidence("window", "Fixture", Vec::new(), 0),
            vec![
                ObservedSubtree::new(
                    evidence("button", "Send", shared(), 1),
                    Vec::new(),
                    true,
                    None,
                ),
                ObservedSubtree::new(
                    evidence("button", "Send", second, 1),
                    Vec::new(),
                    true,
                    None,
                ),
            ],
            true,
            None,
        )],
        ObservationSource::Window {
            window: fixture_window(),
            surface: crate::SnapshotSurface::Window,
            renderer_accessibility_forced: false,
        },
        LocatorStats::default(),
        true,
    )
    .expect("the fixture observes")
}

fn send_query(native_id: &str) -> crate::locator::LocatorQuery {
    crate::locator::LocatorQuery {
        identity: crate::locator::IdentityPredicate {
            role: Some("button".into()),
            name: Some("Send".into()),
            native_id: Some(native_id.into()),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn all_matches() -> crate::locator::live_locator::LocatorResolveRequest {
    crate::locator::live_locator::LocatorResolveRequest {
        selection: crate::locator::live_locator::LocatorSelection::All { limit: Some(64) },
        deadline: crate::Deadline::standard().expect("a standard deadline"),
        max_raw_depth: 50,
        surface: None,
        materialization: crate::locator::live_locator::LocatorMaterialization::None,
    }
}

/// The proof a published entry carries is the predicate it was built with, not
/// the identifier the tree happens to prefer. Two twins that share a secondary
/// identifier both record it when the query names it, so neither may claim to
/// have been found once; the twin the query names by its preferred identifier is
/// the only one the read can prove.
#[test]
fn a_published_entry_is_proven_by_its_own_predicate_not_the_preferred_identifier() {
    let observed = twin_buttons_sharing_a_secondary_identifier();

    let shared = crate::locator::live_locator::evaluate_locator_tree(
        observed.clone(),
        &send_query("shared"),
        &all_matches(),
    )
    .expect("the observation evaluates");
    assert_eq!(shared.matches.len(), 2);
    for matched in &shared.matches {
        assert_eq!(
            matched
                .entry
                .identity
                .native_id
                .as_ref()
                .map(|id| id.value.as_str()),
            Some("shared")
        );
        assert!(
            !matched.entry.identity.unique_at_capture,
            "a predicate both twins carry was not found once"
        );
    }

    let named = crate::locator::live_locator::evaluate_locator_tree(
        observed,
        &send_query("dom-b"),
        &all_matches(),
    )
    .expect("the observation evaluates");
    assert_eq!(named.matches.len(), 1);
    assert!(named.matches[0].entry.identity.unique_at_capture);
}

#[test]
fn a_skipped_native_sibling_does_not_unprove_the_refs_after_it() {
    let observed = ObservedTree::from_roots(
        vec![ObservedSubtree::new(
            evidence("window", "Fixture", Vec::new(), 0),
            vec![
                ObservedSubtree::new(
                    evidence("button", "Cancel", Vec::new(), 1),
                    Vec::new(),
                    true,
                    None,
                )
                .with_source_child_index(0),
                ObservedSubtree::new(
                    evidence("button", "Save", Vec::new(), 1),
                    Vec::new(),
                    true,
                    None,
                )
                .with_source_child_index(2),
            ],
            true,
            None,
        )],
        ObservationSource::Window {
            window: fixture_window(),
            surface: crate::SnapshotSurface::Window,
            renderer_accessibility_forced: false,
        },
        LocatorStats::default(),
        true,
    )
    .expect("the fixture observes");
    let root = window(vec![named("button", "Cancel"), named("button", "Save")]);

    assert_eq!(flags(root, &observed), [true, true]);
}
