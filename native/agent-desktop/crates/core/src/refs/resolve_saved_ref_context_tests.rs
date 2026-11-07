use super::test_support::{RuleAdapter, entry, node, tree_with};
use crate::{RefMap, refs::refs_test_support::HomeGuard};

/// The platform context gate must run on the observation used by both callers,
/// even when a complete node skips locator hydration and no anchor is resolved.
#[test]
fn rooted_find_and_drill_validate_the_observed_menu_context_before_publishing() {
    use crate::commands::find::{FindArgs, FindFilterArgs, FindSelectionArgs};
    use crate::context::CommandContext;
    use crate::refs::refs_store::RefStore;

    let _guard = HomeGuard::new();
    for token in [Some("captured-popup"), Some("replacement-popup"), None] {
        let accepted = token == Some("captured-popup");
        let mut live = node("button", "Run");
        live.identity.retained_object = token.map(str::to_owned);
        let adapter = RuleAdapter::new(tree_with(vec![live]));
        let mut entry = entry();
        entry.source.source_surface = crate::SnapshotSurface::Menu;
        entry.identity.retained_object = Some("captured-popup".into());
        let mut stored = RefMap::new();
        stored.allocate(entry);
        let store = RefStore::new().unwrap();
        let snapshot_id = store.save_new_snapshot(&stored).unwrap();
        let root = format!("@{snapshot_id}:e1");
        let found = crate::commands::find::execute(
            FindArgs {
                app: None,
                window_id: None,
                root: Some(root.clone()),
                surface: crate::SnapshotSurface::Window,
                filter: FindFilterArgs {
                    role: Some("button".into()),
                    name: Some("Run".into()),
                    description: None,
                    native_id: None,
                    value: None,
                    text: None,
                    exact: true,
                },
                states: Vec::new(),
                selection: FindSelectionArgs {
                    count: false,
                    first: true,
                    last: false,
                    nth: None,
                    limit: None,
                },
                timeout_ms: Some(1000),
            },
            &adapter,
            &CommandContext::default(),
        );
        assert_eq!(found.is_ok(), accepted, "find: {token:?}");
        let drilled = crate::snapshot::snapshot_ref::run_from_ref_with_context(
            &adapter,
            &crate::TreeOptions::default(),
            &root,
            &CommandContext::default(),
            1000,
        );
        assert_eq!(drilled.is_ok(), accepted, "drill: {token:?}");
        assert_eq!(
            adapter.counts(),
            (2, 2, 0, 0),
            "no second observation or landing"
        );
        if !accepted {
            assert_eq!(found.err().unwrap().code(), "STALE_REF");
            assert_eq!(drilled.err().unwrap().code(), "STALE_REF");
            assert_eq!(
                serde_json::to_value(store.load_latest().unwrap()).unwrap(),
                serde_json::to_value(&stored).unwrap(),
                "a refused find or drill must not publish replacement refs",
            );
        }
    }
}
