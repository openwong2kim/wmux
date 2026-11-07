use super::test_support::LiveFindAdapter;
use super::*;
use crate::{refs::RefMap, refs::refs_store::RefStore, refs::refs_test_support::HomeGuard};

/// find publishes a ref only when the read that produced it counted the element
/// once, and a tokenless root has to be part of that same read: an element-rooted
/// observation of the root carries no census, so the refs a rooted find returned
/// could never be used. Rooting also stops the match set at the root's subtree,
/// so the window above it is not a candidate.
#[test]
fn find_refs_are_proven_by_the_observation_that_produced_them() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();

    let unrooted = execute(
        find_args(None, Some("OnlyInWindowTwo"), None),
        &adapter,
        &CommandContext::default(),
    )
    .expect("live find should succeed");
    assert_proven_match(&unrooted);

    let mut stored = RefMap::new();
    stored.allocate(stored_button_root());
    let root_snapshot = RefStore::new().unwrap().save_new_snapshot(&stored).unwrap();
    let root_ref = format!("@{root_snapshot}:e1");

    let found = execute(
        find_args(Some(root_ref.clone()), Some("OnlyInWindowTwo"), None),
        &adapter,
        &CommandContext::default(),
    )
    .expect("a rooted find answers from the read that re-identified its root");
    assert_eq!(found["matches"].as_array().map(Vec::len), Some(1));
    assert_proven_match(&found);

    let outside = execute(
        find_args(Some(root_ref), None, Some("window")),
        &adapter,
        &CommandContext::default(),
    )
    .expect("a rooted find that matches nothing inside its root still answers");
    assert_eq!(
        outside["matches"].as_array().map(Vec::len),
        Some(0),
        "the window holding the root is outside the subtree the root scopes"
    );
}

fn find_args(root: Option<String>, name: Option<&str>, role: Option<&str>) -> FindArgs {
    FindArgs {
        app: None,
        window_id: root.is_none().then(|| "w-2".into()),
        root,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            role: role.map(Into::into),
            name: name.map(Into::into),
            description: None,
            native_id: None,
            value: None,
            text: None,
            exact: false,
        },
        states: Vec::new(),
        timeout_ms: None,
        selection: FindSelectionArgs {
            count: false,
            first: false,
            last: false,
            nth: None,
            limit: None,
        },
    }
}

fn assert_proven_match(response: &serde_json::Value) {
    let snapshot_id = response["snapshot_id"]
        .as_str()
        .expect("find refs carry their snapshot namespace");
    let ref_id = response["matches"][0]["ref_id"]
        .as_str()
        .expect("the match carries a ref");
    let (_, local_ref) = crate::refs::ref_token::resolve_ref_target(ref_id).unwrap();
    let refmap = RefStore::new().unwrap().load_snapshot(snapshot_id).unwrap();
    let entry = refmap
        .get(&local_ref)
        .expect("the match's ref is in the snapshot it names");
    assert!(
        entry.identity.unique_at_capture,
        "a find ref must carry the capture proof of the read that produced it"
    );
}

/// A root that re-identifies itself by token says nothing about whether the
/// elements inside it carry one, so when one that would be published does not,
/// a rooted find reads the whole window and proves the matches there. The
/// element-rooted read of the same subtree carries no such proof, and the ref
/// it returned could never resolve.
#[test]
fn a_token_root_find_proves_its_tokenless_matches_over_the_window() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::with_token_root();

    let mut stored = RefMap::new();
    stored.allocate(stored_token_root());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&stored).unwrap();
    let root_ref = format!("@{snapshot_id}:e1");

    let found = execute(
        find_args(Some(root_ref), Some("OnlyInWindowTwo"), None),
        &adapter,
        &CommandContext::default(),
    )
    .expect("a rooted find answers from the read that re-identified its token root");
    assert_eq!(found["matches"].as_array().map(Vec::len), Some(1));
    assert_proven_match(&found);
}

/// When every element a token root holds carries a token too, the find reads
/// that subtree alone and never pays for the window around it.
#[test]
fn a_token_root_find_over_token_matches_reads_only_its_subtree() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::with_token_root_and_matches();

    let mut stored = RefMap::new();
    stored.allocate(stored_token_root());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&stored).unwrap();
    let root_ref = format!("@{snapshot_id}:e1");

    let found = execute(
        find_args(Some(root_ref), Some("OnlyInWindowTwo"), None),
        &adapter,
        &CommandContext::default(),
    )
    .expect("a token root find answers from its own subtree");
    assert_eq!(found["matches"].as_array().map(Vec::len), Some(1));
    assert_eq!(adapter.window_reads(), 0);
}

/// A tokenless member whose actions are unread could become publishable once
/// hydrated, so the subtree alone cannot stand and the window proves it.
#[test]
fn a_token_root_with_an_unread_tokenless_member_reads_the_window() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::with_token_root_and_unread_member();

    let mut stored = RefMap::new();
    stored.allocate(stored_token_root());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&stored).unwrap();
    let root_ref = format!("@{snapshot_id}:e1");

    let _ = execute(
        find_args(Some(root_ref), Some("OnlyInWindowTwo"), None),
        &adapter,
        &CommandContext::default(),
    );
    assert_eq!(adapter.window_reads(), 1);
}

fn stored_token_root() -> crate::refs::RefEntry {
    let mut entry =
        crate::adapter::minimal_ref_entry("group", Some(super::test_support::TOKEN_ROOT_NAME));
    entry.identity.retained_object = Some(super::test_support::TOKEN_ROOT.into());
    entry.process.pid = crate::ProcessId::new(102);
    entry.source.source_app = Some("FixtureApp".into());
    entry.source.source_window_id = Some("w-2".into());
    entry.source.source_window_title = Some("Second".into());
    entry
}

fn stored_button_root() -> crate::refs::RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("button", Some("OnlyInWindowTwo"));
    entry.process.pid = crate::ProcessId::new(102);
    entry.source.source_app = Some("FixtureApp".into());
    entry.source.source_window_id = Some("w-2".into());
    entry.source.source_window_title = Some("Second".into());
    entry
}
