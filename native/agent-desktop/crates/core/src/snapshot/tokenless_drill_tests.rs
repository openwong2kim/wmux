use std::sync::atomic::Ordering;

use super::tokenless_capture_support::*;
use crate::refs::refs_test_support::HomeGuard;
use crate::snapshot::snapshot_ref::run_from_ref;

#[test]
fn a_skeleton_anchor_resolves_and_its_drill_resolves() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());

    let captured = snapshot(&adapter);
    assert_eq!(
        adapter.captures(),
        1,
        "an adapter without element tokens reads the whole window once"
    );
    let (anchor_ref, anchor) = named(&captured.refmap, "Sidebar");
    assert!(
        anchor.identity.unique_at_capture,
        "an inert anchor is counted by the capture census too"
    );
    assert_eq!(captured.refmap.len(), 1);
    let sidebar = &captured.tree.children[0].children[0].children[0];
    assert_eq!(sidebar.children_count, Some(1), "a cut keeps its count");

    let snapshot_id = save(&captured.refmap);
    let before = adapter.captures();
    let drilled = run_from_ref(&adapter, &drill_opts(), &anchor_ref, Some(&snapshot_id))
        .expect("a tokenless drill reuses the walk its root resolved through");
    assert_eq!(adapter.captures(), before + 1, "one walk, not two");
    assert_eq!(
        adapter.subtrees.load(Ordering::SeqCst),
        0,
        "a tokenless drill never reads the subtree again"
    );

    let (_, button) = named(&drilled.refmap, "Save");
    assert!(
        button.identity.unique_at_capture,
        "the drill counted its refs against the window it will be resolved in"
    );
    assert_eq!(button.identity.role, "button");

    resolve(&adapter, button).expect("the drilled ref resolves");
    let anchored = adapter.anchored();
    assert_eq!(anchored.len(), 1);
    assert_eq!(anchored[0].scope.path.as_slice(), &[0, 0, 0, 0, 0]);
}

#[test]
fn a_twin_below_the_skeleton_depth_is_not_offered_as_an_anchor() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(twinned_window());

    let captured = snapshot(&adapter);
    assert_eq!(
        captured.refmap.len(),
        1,
        "the twin is never handed out as a drill target, so only the proven anchor remains"
    );
    let (_, toolbar) = named(&captured.refmap, "Toolbar");
    assert!(
        toolbar.identity.unique_at_capture,
        "the census that refuses the twin still proves its neighbour"
    );

    resolve(&adapter, toolbar).expect("a proven anchor resolves");
    assert_eq!(adapter.anchored().len(), 1);
    assert_eq!(adapter.anchored()[0].scope.path.as_slice(), &[0, 0, 1]);
}

#[test]
fn a_drill_under_a_moved_root_records_the_live_path() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(anchored_window());

    let captured = snapshot(&adapter);
    let (anchor_ref, _) = named(&captured.refmap, "Sidebar");
    assert_eq!(
        captured
            .refmap
            .get(&anchor_ref)
            .expect("anchor")
            .scope
            .path
            .as_slice(),
        &[0, 0, 0]
    );
    let snapshot_id = save(&captured.refmap);

    adapter.show(shifted_window());
    let first = run_from_ref(&adapter, &drill_opts(), &anchor_ref, Some(&snapshot_id))
        .expect("the moved anchor resolves");
    let (first_button, button) = named(&first.refmap, "Save");
    assert_eq!(
        button.scope.path.as_slice(),
        &[0, 1, 0, 0, 0],
        "a drilled ref is recorded in the path of the node the drill matched"
    );

    let second = run_from_ref(&adapter, &drill_opts(), &anchor_ref, Some(&snapshot_id))
        .expect("the re-drill replaces one subtree");
    let (second_button, _) = named(&second.refmap, "Save");
    assert!(
        second.refmap.get(&first_button).is_none(),
        "the previous drill's refs are pruned through their root, not by path"
    );
    assert_ne!(first_button, second_button);
    assert!(
        second.refmap.get(&anchor_ref).is_some(),
        "the drill never removes its own root"
    );
}

#[test]
fn a_token_rooted_drill_proves_its_tokenless_descendants() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(token_anchored_window());

    let captured = snapshot(&adapter);
    let (anchor_ref, anchor) = named(&captured.refmap, "Sidebar");
    assert_eq!(anchor.identity.retained_object.as_deref(), Some(TOKEN));
    let snapshot_id = save(&captured.refmap);

    let drilled = run_from_ref(&adapter, &drill_opts(), &anchor_ref, Some(&snapshot_id))
        .expect("a token-rooted drill is located in the whole-window read");

    let (_, button) = named(&drilled.refmap, "Save");
    assert!(
        button.identity.unique_at_capture,
        "the button below a token root is counted against the whole window"
    );
    resolve(&adapter, button).expect("the drilled ref resolves");
}

#[test]
fn a_token_rooted_drill_of_tokened_refs_reads_only_its_subtree() {
    let _guard = HomeGuard::new();
    let mut tokened = node("button", "Save");
    tokened.identity.retained_object = Some("axtok1:save".into());
    let mut sidebar = node("group", "Sidebar");
    sidebar.identity.retained_object = Some(TOKEN.into());
    sidebar.children = vec![group(vec![tokened])];
    let adapter = CaptureAdapter::new(window(vec![group(vec![group(vec![sidebar])])]));
    let captured = snapshot(&adapter);
    let (anchor_ref, _) = named(&captured.refmap, "Sidebar");
    let snapshot_id = save(&captured.refmap);
    let windows_before = adapter.captures();

    let drilled = run_from_ref(&adapter, &drill_opts(), &anchor_ref, Some(&snapshot_id))
        .expect("a drill whose refs all carry tokens reads its subtree");

    assert_eq!(adapter.captures(), windows_before, "no whole-window read");
    assert_eq!(adapter.subtrees.load(Ordering::SeqCst), 1);
    let (_, button) = named(&drilled.refmap, "Save");
    assert_eq!(
        button.identity.retained_object.as_deref(),
        Some("axtok1:save")
    );
}

#[test]
fn a_token_rooted_drill_whose_window_read_is_cut_short_replaces_nothing() {
    let _guard = HomeGuard::new();
    let adapter = CaptureAdapter::new(token_anchored_window());
    adapter.fault_whole_read(|_, mut tree| {
        let mut unread = node("scrollarea", "Unread");
        unread.children_count = Some(3);
        unread.subtree_truncated = true;
        tree.children.push(unread);
        Ok(tree)
    });
    let captured = snapshot(&adapter);
    let (anchor_ref, _) = named(&captured.refmap, "Sidebar");
    let snapshot_id = save(&captured.refmap);

    let Err(error) = run_from_ref(&adapter, &drill_opts(), &anchor_ref, Some(&snapshot_id)) else {
        panic!("a drill is all or nothing");
    };

    assert_eq!(error.code(), "TIMEOUT");
    let stored = crate::refs::refs_store::RefStore::new()
        .expect("the snapshot store opens")
        .load_snapshot(&snapshot_id)
        .expect("the snapshot loads");
    assert_eq!(stored.len(), captured.refmap.len(), "no ref was replaced");
}
