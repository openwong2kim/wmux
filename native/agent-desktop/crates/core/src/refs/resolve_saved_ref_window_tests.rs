use std::sync::atomic::Ordering;

use super::observe_saved_ref;
use super::test_support::{RuleAdapter, entry, node, resolve, tree_with, window};
use crate::{AdapterError, Deadline, ErrorCode, WindowInfo, refs::refs_test_support::HomeGuard};

fn window_of(id: &str, pid: u32, instance: &str) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        pid: crate::ProcessId::new(pid),
        process_instance: Some(instance.into()),
        ..window()
    }
}

fn refused(adapter: &RuleAdapter, entry: &crate::RefEntry) -> AdapterError {
    match resolve(adapter, entry) {
        Ok(_) => panic!("a window the ref was not captured from must not answer for it"),
        Err(error) => error,
    }
}

#[test]
fn a_recorded_window_of_another_process_generation_is_refused() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.windows = vec![window_of("w-1", 1, "relaunched")];

    let error = refused(&adapter, &entry());

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(adapter.observations.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 0);
}

#[test]
fn a_recorded_window_owned_by_another_pid_is_refused() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.windows = vec![window_of("w-1", 2, "test-instance")];

    let error = refused(&adapter, &entry());

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(adapter.observations.load(Ordering::SeqCst), 0);
}

#[test]
fn a_closed_recorded_window_is_never_replaced_by_another() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.windows = vec![window_of("w-2", 1, "test-instance")];

    let error = refused(&adapter, &entry());

    assert!(
        matches!(error.code, ErrorCode::StaleRef | ErrorCode::WindowNotFound),
        "a closed window is gone, not substituted: {error:?}"
    );
    assert_eq!(adapter.observations.load(Ordering::SeqCst), 0);
}

#[test]
fn an_entry_without_a_window_id_finds_the_window_of_its_generation() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.windows = vec![
        window_of("w-0", 1, "relaunched"),
        window_of("w-1", 1, "test-instance"),
    ];
    let mut entry = entry();
    entry.source.source_window_id = None;

    resolve(&adapter, &entry).expect("the window of the captured generation answers");

    assert_eq!(adapter.anchors.load(Ordering::SeqCst), 1);
}

#[test]
fn an_entry_without_a_window_id_refuses_windows_of_other_generations() {
    let _guard = HomeGuard::new();
    let mut adapter = RuleAdapter::new(tree_with(vec![node("button", "Run")]));
    adapter.windows = vec![window_of("w-0", 1, "relaunched")];
    let mut entry = entry();
    entry.source.source_window_id = None;

    let error = refused(&adapter, &entry);

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(adapter.observations.load(Ordering::SeqCst), 0);
}

#[test]
fn a_token_missing_from_a_cut_short_read_is_not_proven_absent() {
    let _guard = HomeGuard::new();
    let mut unread = node("scrollarea", "Feed");
    unread.children_count = Some(4);
    let cut_short = RuleAdapter::new(tree_with(vec![node("button", "Cancel"), unread]));
    let whole = RuleAdapter::new(tree_with(vec![node("button", "Cancel")]));
    let mut entry = entry();
    entry.identity.retained_object = Some("axtok1:page-7:node-3".into());
    let deadline = Deadline::standard().expect("a standard deadline");

    let Err(unknown) = observe_saved_ref(&cut_short, &entry, deadline, None, false) else {
        panic!("the token may sit in the unread region");
    };
    assert_eq!(unknown.code, ErrorCode::Timeout);
    assert_eq!(
        unknown.details.expect("details")["kind"],
        "resolution_identity_unknown"
    );

    let Err(absent) = observe_saved_ref(&whole, &entry, deadline, None, false) else {
        panic!("a whole read without the token proves it gone");
    };
    assert_eq!(absent.code, ErrorCode::StaleRef);
    assert_eq!(absent.details.expect("details")["kind"], "saved_ref_absent");
}
