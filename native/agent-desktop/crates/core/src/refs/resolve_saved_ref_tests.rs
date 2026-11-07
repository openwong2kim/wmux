use std::sync::atomic::Ordering;

use super::test_support::{RuleAdapter, capture, entry, node, resolve, tree_with, window};
use crate::{ErrorCode, refs::refs_test_support::HomeGuard};

#[test]
fn a_unique_live_match_resolves_through_a_positional_anchor() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![
        node("button", "Cancel"),
        node("button", "Run"),
    ]));

    let Ok(handle) = resolve(&adapter, &entry()) else {
        panic!("one live match must resolve");
    };

    assert_eq!(handle.downcast_ref::<&str>(), Some(&"anchor"));
    assert_eq!(adapter.counts(), (1, 2, 0, 1));
    let anchor = adapter
        .anchored
        .lock()
        .unwrap()
        .clone()
        .expect("anchor entry");
    assert_eq!(anchor.scope.path.as_slice(), [1]);
    assert_eq!(anchor.identity.name.as_deref(), Some("Run"));
}

#[test]
fn a_live_twin_refuses_as_ambiguous() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![
        node("button", "Run"),
        node("button", "Run"),
    ]));

    let Err(error) = resolve(&adapter, &entry()) else {
        panic!("a twin cannot be picked");
    };

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.unwrap()["kind"], "saved_ref_ambiguous");
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn a_landed_element_that_is_not_the_recorded_one_is_stale() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.landed = Some(node("button", "Cancel"));

    let Err(error) = resolve(&adapter, &entry()) else {
        panic!("the anchor landed a different element");
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.details.unwrap()["kind"], "saved_ref_absent");
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 1);
}

/// A shell container is not in the window inventory, so the recorded window id
/// finds it only through the adapter's shell-surface seam.
#[test]
fn a_shell_surface_ref_reaches_its_container_without_the_window_inventory() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.windows.clear();
    adapter.shell = Some(window());
    let mut entry = entry();
    entry.source.source_window_id = Some("w-1".into());
    entry.source.source_surface = crate::SnapshotSurface::SystemTray;

    let Ok(handle) = resolve(&adapter, &entry) else {
        panic!("the shell container answers for its recorded id");
    };

    assert_eq!(handle.downcast_ref::<&str>(), Some(&"anchor"));
    assert_eq!(adapter.windows_listed.load(Ordering::SeqCst), 0);
}

/// A windowless app's ref resolves from its live process even after the app
/// opens a window, and a relaunched process makes it stale.
#[test]
fn a_process_owned_ref_follows_its_process_not_a_window() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    let mut entry = entry();
    entry.source.source_window_id = None;
    entry.source.source_window_title = Some(String::new());
    entry.process.process_instance = Some("test-instance".into());

    assert!(resolve(&adapter, &entry).is_ok());
    assert_eq!(adapter.windows_listed.load(Ordering::SeqCst), 0);

    entry.process.process_instance = Some("relaunched".into());
    let Err(error) = resolve(&adapter, &entry) else {
        panic!("a replaced process cannot answer for the ref");
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_removed_target_is_stale() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![node("button", "Cancel")]));

    let Err(error) = resolve(&adapter, &entry()) else {
        panic!("a removed target is stale");
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    let details = error.details.unwrap();
    assert_eq!(details["kind"], "saved_ref_absent");
    assert_eq!(details["complete"], true);
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn an_entry_not_unique_at_capture_is_refused_before_any_live_search() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    let mut entry = entry();
    entry.identity.unique_at_capture = false;

    let Err(error) = resolve(&adapter, &entry) else {
        panic!("an unproven ref must be refused");
    };

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.unwrap()["kind"], "identity_not_unique");
    assert_eq!(adapter.counts(), (0, 0, 0, 0));
}

#[test]
fn an_element_token_goes_straight_to_the_adapter() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![]));
    let mut entry = entry();
    entry.identity.unique_at_capture = false;
    entry.identity.retained_object = Some("axtok1:page-7:node-3".into());

    let Ok(handle) = resolve(&adapter, &entry) else {
        panic!("a token is re-identified by the adapter");
    };

    assert_eq!(handle.downcast_ref::<&str>(), Some(&"strict"));
    assert_eq!(adapter.counts(), (0, 0, 1, 0));
}

#[test]
fn incomplete_evidence_never_resolves() {
    let _guard = HomeGuard::new();
    let mut truncated = node("scrollarea", "Feed");
    truncated.children_count = Some(2);
    let adapter = RuleAdapter::new(tree_with(vec![node("button", "Run"), truncated]));

    let Err(error) = resolve(&adapter, &entry()) else {
        panic!("an unread subtree hides a twin");
    };

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.details.unwrap()["kind"],
        "resolution_identity_unknown"
    );
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn capture_and_resolution_agree_on_the_same_element() {
    let _guard = HomeGuard::new();
    let alone = tree_with(vec![node("button", "Run"), node("button", "Cancel")]);
    let captured = capture(alone.clone(), "Run");
    assert!(captured.identity.unique_at_capture);
    assert!(resolve(&RuleAdapter::new(alone), &captured).is_ok());

    let twinned = tree_with(vec![node("button", "Run"), node("button", "Run")]);
    let twin_captured = capture(twinned.clone(), "Run");
    assert!(!twin_captured.identity.unique_at_capture);
    let refused = resolve(&RuleAdapter::new(twinned), &twin_captured);
    assert_eq!(
        refused.err().map(|error| error.code),
        Some(ErrorCode::AmbiguousTarget)
    );

    let renamed = tree_with(vec![node("button", "Cancel")]);
    let stale = resolve(&RuleAdapter::new(renamed), &captured);
    assert_eq!(
        stale.err().map(|error| error.code),
        Some(ErrorCode::StaleRef)
    );
}

fn land(
    adapter: &RuleAdapter,
    entry: &crate::RefEntry,
) -> Result<crate::NativeHandle, crate::AdapterError> {
    super::land_saved_ref(adapter, entry, crate::Deadline::standard().unwrap())
}

#[test]
fn a_confirmed_landing_skips_the_whole_window_count() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));

    land(&adapter, &entry()).expect("the recorded path lands the recorded element");

    assert_eq!(adapter.counts(), (0, 1, 0, 1));
}

#[test]
fn a_landing_that_does_not_confirm_falls_back_to_the_full_resolution() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.landed = Some(node("button", "Cancel"));

    let Err(error) = land(&adapter, &entry()) else {
        panic!("a different element sits at the recorded path");
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.details.unwrap()["kind"], "saved_ref_absent");
    assert_eq!(adapter.observations.load(Ordering::SeqCst), 3);
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 2);
}

#[test]
fn a_provisional_landing_leaves_the_twin_verdict_to_the_full_resolution() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![
        node("button", "Run"),
        node("button", "Run"),
    ]));

    assert!(land(&adapter, &entry()).is_ok());
    let Err(error) = resolve(&adapter, &entry()) else {
        panic!("the full resolution counts the twin");
    };
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn an_unproven_entry_is_never_landed_provisionally() {
    let _guard = HomeGuard::new();
    let adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    let mut entry = entry();
    entry.identity.unique_at_capture = false;

    let Err(error) = land(&adapter, &entry) else {
        panic!("an unproven ref is refused");
    };

    assert_eq!(error.details.unwrap()["kind"], "identity_not_unique");
    assert_eq!(adapter.counts(), (0, 0, 0, 0));
}
