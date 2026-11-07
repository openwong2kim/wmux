use super::*;
use crate::AccessibilityNode;

fn boundary(role: &str, name: Option<&str>) -> AccessibilityNode {
    let mut node = node(role, name);
    node.children_count = Some(1);
    node
}

/// The whole-window observation a snapshot counts before it presents a cut.
fn uncut(mut tree: AccessibilityNode) -> AccessibilityNode {
    tree.children_count = None;
    tree.children = tree.children.into_iter().map(uncut).collect();
    tree
}

fn fixture_window() -> crate::WindowInfo {
    crate::WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "Fixture".into(),
        pid: crate::ProcessId::new(7),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

fn capture_config<'a>(capture: &'a CaptureProof<'a>) -> RefAllocConfig<'a> {
    RefAllocConfig {
        capture: Some(capture),
        options: crate::refs::ref_alloc_options::RefAllocOptions {
            include_bounds: true,
            interactive_only: false,
            compact: false,
            force_renderer_accessibility: false,
        },
        source: source(7),
        scope: crate::refs::ref_alloc_scope::RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    }
}

fn allocation(tree: AccessibilityNode) -> RefMap {
    let observed = crate::adapter::observed_tree(
        &crate::locator::live_locator::ObservationRoot::Window(&fixture_window()),
        uncut(tree.clone()),
    )
    .expect("the fixture observes");
    let proof = CaptureProof::new(&observed);
    let mut refmap = RefMap::new();
    allocate_refs(tree, &mut refmap, &capture_config(&proof)).expect("the tree allocates");
    refmap
}

/// A boundary container is a drill target only when a later resolve can prove
/// it is the element it names, so an unproven twin is never handed out while a
/// boundary the capture found once still is.
#[test]
fn a_skeleton_anchor_is_offered_only_when_the_capture_proves_it() {
    let mut root = node("window", Some("w"));
    root.children = vec![boundary("group", Some("Sidebar"))];
    assert_eq!(allocation(root).len(), 1, "a boundary found once is a ref");

    let mut twinned = node("window", Some("w"));
    twinned.children = vec![
        boundary("group", Some("Sidebar")),
        boundary("group", Some("Sidebar")),
    ];
    assert_eq!(
        allocation(twinned).len(),
        0,
        "a boundary the capture cannot tell from its twin is not offered"
    );
}

/// Geometry is not identity: a boundary whose only evidence is its bounds is
/// offered only when the census proves its role and text are its own.
#[test]
fn a_bounds_only_boundary_is_a_drill_target_only_when_proven() {
    let mut only = node("window", Some("w"));
    only.children = vec![boundary("group", None)];
    assert_eq!(allocation(only).len(), 1, "the only group is proven unique");

    let mut shared = node("window", Some("w"));
    shared.children = vec![boundary("group", None), boundary("group", None)];
    assert_eq!(
        allocation(shared).len(),
        0,
        "two identical boundaries cannot be told apart"
    );
}

/// A twin the capture cannot tell apart is never offered, so the boundary it
/// would have covered falls to the nearest ancestor the capture does prove.
#[test]
fn a_unique_ancestor_anchors_a_boundary_whose_twin_is_not_offered() {
    let mut panel = node("group", Some("Panel"));
    panel.children = vec![
        boundary("group", Some("Sidebar")),
        boundary("group", Some("Sidebar")),
    ];
    let mut root = node("window", Some("w"));
    root.children = vec![panel];

    let refmap = allocation(root);
    assert_eq!(refmap.len(), 1, "only the ancestor is a drill target");
    let anchor = refmap.get("@e1").expect("the ancestor holds the first ref");
    assert_eq!(anchor.identity.name.as_deref(), Some("Panel"));
    assert!(anchor.identity.unique_at_capture);
}

/// A ref-able twin at a boundary is refused when drilled, so it covers nothing:
/// the boundary falls to the nearest ancestor the capture proves.
#[test]
fn a_twin_ref_able_boundary_leaves_its_anchor_to_a_proven_ancestor() {
    let mut panel = node("group", Some("Panel"));
    panel.children = vec![
        boundary("button", Some("More")),
        boundary("button", Some("More")),
    ];
    let mut root = node("window", Some("w"));
    root.children = vec![panel];

    let refmap = allocation(root);
    let anchor = (1..=refmap.len())
        .filter_map(|index| refmap.get(&format!("@e{index}")))
        .find(|entry| entry.identity.name.as_deref() == Some("Panel"))
        .expect("the proven ancestor anchors the boundary");
    assert!(anchor.identity.unique_at_capture);
}
