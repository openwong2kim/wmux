use super::needs_whole_window;
use crate::locator::live_locator::{ObservationRoot, ObservedTree};
use crate::{AccessibilityNode, WindowInfo};

fn window() -> WindowInfo {
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

fn node(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

fn tokened(role: &str, name: &str, token: &str) -> AccessibilityNode {
    let mut node = node(role, name);
    node.identity.retained_object = Some(format!("axtok1:{token}"));
    node
}

fn observed(root: AccessibilityNode) -> ObservedTree {
    let window = window();
    crate::adapter::observed_tree(&ObservationRoot::Window(&window), root)
        .expect("the fixture observes")
}

/// A window whose walk stopped at a container: the container keeps the count of
/// what it hid, so a shallow presentation can still offer it as a drill target.
fn cut_window(anchor: AccessibilityNode, ref_able: AccessibilityNode) -> AccessibilityNode {
    let mut hidden = node("group", "Hidden");
    hidden.children = vec![ref_able];
    let mut anchor = anchor;
    anchor.children_count = Some(1);
    anchor.children = Vec::new();
    let mut root = node("window", "Fixture");
    root.children = vec![anchor, hidden];
    root
}

#[test]
fn a_cut_capture_of_tokenless_refs_needs_the_whole_window() {
    let observed = observed(cut_window(node("group", "Sidebar"), node("button", "Save")));

    assert!(needs_whole_window(&observed));
}

#[test]
fn a_cut_capture_whose_refs_carry_tokens_needs_no_second_walk() {
    let observed = observed(cut_window(
        tokened("group", "Sidebar", "sidebar"),
        tokened("button", "Save", "save"),
    ));

    assert!(!needs_whole_window(&observed));
}

/// A cut boundary with nothing a later resolve could re-identify it by is not a
/// drill target, so it is not an entry the census would prove: the capture keeps
/// its single walk even though that boundary omits descendants.
#[test]
fn a_cut_boundary_that_cannot_anchor_a_drill_needs_no_second_walk() {
    let observed = observed(cut_window(
        node("group", ""),
        tokened("button", "Save", "save"),
    ));

    assert!(!needs_whole_window(&observed));
}

#[test]
fn a_capture_that_reached_the_whole_window_needs_no_second_walk() {
    let mut save = node("button", "Save");
    save.children = vec![node("group", "Icon")];
    let mut root = node("window", "Fixture");
    root.children = vec![save];

    assert!(!needs_whole_window(&observed(root)));
}
