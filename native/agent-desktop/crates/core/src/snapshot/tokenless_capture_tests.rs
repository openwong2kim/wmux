use std::sync::atomic::Ordering;

use super::tokenless_capture_support::*;
use crate::locator::live_locator::ObservationRequest;
use crate::refs::refs_test_support::HomeGuard;
use crate::{AccessibilityNode, AdapterError, Deadline, ErrorCode, RefMap};

fn entries(refmap: &RefMap) -> Vec<&crate::RefEntry> {
    (1..=64)
        .filter_map(|index| refmap.get(&format!("@e{index}")))
        .collect()
}

fn cut_short(
    _request: &ObservationRequest,
    mut tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    let mut unread = node("scrollarea", "Unread");
    unread.children_count = Some(3);
    unread.subtree_truncated = true;
    tree.children.push(unread);
    Ok(tree)
}

fn faulted(
    _request: &ObservationRequest,
    _tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "a node below the shallow depth faulted",
    ))
}

fn needs_forced_renderer(
    request: &ObservationRequest,
    tree: AccessibilityNode,
) -> Result<AccessibilityNode, AdapterError> {
    if request.observation_mode.force_renderer_accessibility {
        return Ok(tree);
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        "the renderer tree is thin until accessibility is forced",
    ))
}

#[test]
fn a_whole_window_read_cut_short_keeps_the_complete_shallow_tree() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(cut_short);

    let captured = snapshot(&adapter);
    assert_eq!(adapter.captures(), 2);
    assert!(captured.complete, "the shallow walk finished");
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("the whole-window read was cut short")
    );
    let tree = serde_json::to_string(&captured.tree).expect("the tree serializes");
    assert!(
        !tree.contains("Unread"),
        "the cut-short read is not presented"
    );
    assert!(
        entries(&captured.refmap).is_empty(),
        "a read that was cut short proves nothing, so no anchor is handed out"
    );
}

#[test]
fn a_failed_whole_window_read_keeps_the_shallow_tree() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(faulted);

    let captured = snapshot(&adapter);
    assert!(captured.complete, "the shallow walk finished");
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("a node below the shallow depth faulted")
    );
    assert!(entries(&captured.refmap).is_empty());
}

#[test]
fn the_whole_window_read_carries_the_forced_renderer_hint() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());
    adapter.fault_whole_read(needs_forced_renderer);
    let forced = crate::adapter::TreeOptions {
        force_renderer_accessibility: true,
        ..skeleton_opts()
    };

    let captured = crate::snapshot::build(
        &adapter,
        &forced,
        Some("Fixture"),
        None,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the window snapshots");
    assert!(captured.identity_unproven.is_none());
    let (anchor_ref, anchor) = named(&captured.refmap, "Sidebar");
    assert!(
        anchor.identity.unique_at_capture,
        "the forced read is adopted and proves the anchor"
    );
    assert!(anchor.source.renderer_accessibility_forced);
    resolve(&adapter, anchor).expect("resolution reads the window the way the capture did");

    let snapshot_id = save(&captured.refmap);
    let drilled = crate::snapshot::snapshot_ref::run_from_ref(
        &adapter,
        &drill_opts(),
        &anchor_ref,
        Some(&snapshot_id),
    )
    .expect("a drill reads the window the way the capture did");
    let (_, button) = named(&drilled.refmap, "Save");
    assert!(button.source.renderer_accessibility_forced);
    resolve(&adapter, button).expect("a drilled ref reads the window the way the capture did");
}

#[test]
fn an_incomplete_window_offers_no_drill_anchor() {
    let _guard = HomeGuard::new();
    let mut hidden = node("scrollarea", "Feed");
    hidden.children_count = Some(3);
    hidden.subtree_truncated = true;
    let mut sidebar = node("group", "Sidebar");
    sidebar.children = vec![group(vec![node("button", "Save")])];
    let adapter = CaptureAdapter::new(window(vec![group(vec![group(vec![sidebar, hidden])])]));

    let captured = snapshot(&adapter);
    assert!(!captured.complete, "the window was not read whole");
    assert_eq!(
        captured.refmap.len(),
        0,
        "an unread region proves nothing, so no anchor is handed out"
    );
}

#[test]
fn a_shallow_capture_of_tokened_refs_takes_one_walk() {
    let _guard = HomeGuard::new();
    let mut run = node("button", "Run");
    run.identity.retained_object = Some(TOKEN.into());
    let mut deep = node("group", "");
    deep.identity.retained_object = Some("axtok1:deep".into());
    deep.children = vec![node("button", "Deep")];
    let adapter = CaptureAdapter::new(window(vec![run, group(vec![group(vec![deep])])]));

    let captured = snapshot(&adapter);
    assert_eq!(
        adapter.captures(),
        1,
        "a ref that re-identifies itself by token needs no second walk"
    );
    let (_, ref_entry) = named(&captured.refmap, "Run");
    assert_eq!(ref_entry.identity.retained_object.as_deref(), Some(TOKEN));

    resolve(&adapter, ref_entry).expect("a token resolves through the adapter");
    assert_eq!(adapter.strict.load(Ordering::SeqCst), 1);
    assert!(adapter.anchored().is_empty());
}

#[test]
fn a_deep_capture_cut_short_is_flagged_as_unproven() {
    let _guard = HomeGuard::new();
    let mut unread = node("scrollarea", "Feed");
    unread.children_count = Some(3);
    unread.subtree_truncated = true;
    let adapter = CaptureAdapter::new(window(vec![node("button", "Run"), unread]));
    let deep = crate::adapter::TreeOptions {
        max_depth: crate::refs::resolve_saved_ref::WHOLE_WINDOW_DEPTH,
        ..Default::default()
    };

    let captured = crate::snapshot::build(
        &adapter,
        &deep,
        Some("Fixture"),
        None,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the window snapshots");

    assert_eq!(
        adapter.captures(),
        1,
        "a deep capture is its own whole read"
    );
    assert_eq!(
        captured.identity_unproven.as_deref(),
        Some("the window read was cut short")
    );
}
