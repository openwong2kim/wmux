use super::*;
use crate::AccessibilityNode;
use crate::AdapterError;
use crate::actions::action_request::ActionRequest;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::refs::ref_alloc::ref_entry_from_node;
use crate::refs::refs_test_support::HomeGuard;
use crate::{refs::RefMap, refs::refs_store::RefStore};

fn node(role: &str) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: role.into(),
        identity: Default::default(),
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

fn named(role: &str, name: &str) -> AccessibilityNode {
    let mut n = node(role);
    n.identity.name = Some(name.into());
    n
}

fn drilled(role: &str, name: &str) -> AccessibilityNode {
    let mut n = named(role, name);
    n.identity.retained_object = Some(format!("axtok1:{role}-{name}"));
    n
}

fn source(app: &'static str) -> crate::refs::ref_alloc_source::RefAllocSource<'static> {
    crate::refs::ref_alloc_source::RefAllocSource {
        pid: crate::ProcessId::new(42),
        app: Some(app),
        window_id: None,
        window_title: None,
        window_bounds_hash: None,
        process_instance: Some("test-instance"),
        surface: crate::adapter::SnapshotSurface::Window,
    }
}

struct StubAdapter {
    subtree: AccessibilityNode,
    subtree_error: Option<AdapterError>,
    token: String,
    windows: Vec<crate::WindowInfo>,
    expected_app: Option<String>,
}

impl StubAdapter {
    fn new(subtree: AccessibilityNode) -> Self {
        Self::with_windows(subtree, vec![window_info("w-42", true)])
    }

    fn with_windows(subtree: AccessibilityNode, windows: Vec<crate::WindowInfo>) -> Self {
        Self {
            subtree,
            subtree_error: None,
            token: "axtok1:group-Sidebar".into(),
            windows,
            expected_app: None,
        }
    }

    fn with_subtree_error(error: AdapterError) -> Self {
        Self {
            subtree_error: Some(error),
            ..Self::new(node("group"))
        }
    }

    fn with_token(mut self, token: &str) -> Self {
        self.token = token.into();
        self
    }
}

fn window_info(id: &str, focused: bool) -> crate::WindowInfo {
    crate::WindowInfo {
        id: id.into(),
        title: "Test".into(),
        app: "TestApp".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: focused,
            ..Default::default()
        },
    }
}

impl ObservationOps for StubAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        if let Some(error) = &self.subtree_error {
            return Err(error.clone());
        }
        if matches!(
            root,
            crate::locator::live_locator::ObservationRoot::Element { .. }
        ) {
            return crate::adapter::observed_tree(&root, self.subtree.clone());
        }
        let mut drilled = self.subtree.clone();
        drilled.identity.retained_object = Some(self.token.clone());
        let mut window = node("window");
        window.children = vec![drilled];
        crate::adapter::observed_tree(&root, window)
    }

    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![crate::AppInfo {
            name: "TestApp".into(),
            pid: crate::ProcessId::new(42),
            bundle_id: None,
            process_instance: Some("test-instance".into()),
            presentation: Some(crate::AppPresentation::Background),
        }])
    }

    fn list_windows(
        &self,
        filter: &crate::adapter::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        if let Some(expected) = &self.expected_app {
            assert_eq!(filter.app.as_ref(), Some(expected));
        }
        Ok(self.windows.clone())
    }

    fn resolve_element_strict(
        &self,
        _entry: &crate::refs::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }
}

impl ActionOps for StubAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Err(AdapterError::not_supported("execute_action"))
    }
}

impl InputOps for StubAdapter {}

impl SystemOps for StubAdapter {}

fn save_latest(refmap: RefMap) -> String {
    RefStore::new()
        .unwrap()
        .save_new_snapshot(&refmap)
        .expect("snapshot refmap should save")
}

fn save_session(session_id: &str, refmap: RefMap) -> String {
    RefStore::for_session(Some(session_id))
        .unwrap()
        .save_new_snapshot(&refmap)
        .expect("session snapshot refmap should save")
}

fn load_latest() -> RefMap {
    RefStore::new()
        .unwrap()
        .load_latest()
        .expect("latest snapshot should load")
}

fn load_session_snapshot(session_id: &str, snapshot_id: &str) -> RefMap {
    RefStore::for_session(Some(session_id))
        .unwrap()
        .load(Some(snapshot_id))
        .expect("session snapshot should load")
}

fn local_ref(ref_id: &str) -> String {
    crate::refs::ref_token::resolve_ref_target(ref_id)
        .expect("result refs must be snapshot-qualified")
        .1
}

fn seed_skeleton_refmap() -> RefMap {
    let mut map = RefMap::new();
    let anchor = ref_entry_from_node(&drilled("group", "Sidebar"), &source("TestApp"), None, &[0]);
    let _ = map.allocate(anchor);
    let other = ref_entry_from_node(
        &drilled("button", "Toolbar"),
        &source("TestApp"),
        None,
        &[1],
    );
    let _ = map.allocate(other);
    map
}

fn drill_opts() -> TreeOptions {
    TreeOptions {
        interactive_only: false,
        ..Default::default()
    }
}

#[test]
fn test_run_from_ref_returns_subtree_and_persists_refs() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let mut child_btn = named("button", "Save");
    child_btn.children = vec![];
    let mut subtree_root = named("group", "Sidebar");
    subtree_root.children = vec![child_btn];

    let adapter = StubAdapter::new(subtree_root);
    let result = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id))
        .expect("drill should succeed");

    let on_disk = load_latest();
    assert_eq!(on_disk.len(), result.refmap.len());
    assert!(
        result.refmap.len() >= 3,
        "expected at least 2 skeleton + 1 drill ref, got {}",
        result.refmap.len()
    );

    let drill_ref = result
        .tree
        .children
        .iter()
        .find(|c| c.role == "button")
        .and_then(|c| c.ref_id.as_deref())
        .expect("button child should carry a ref");
    let drill_entry = on_disk.get(&local_ref(drill_ref)).expect("entry persisted");
    assert_eq!(drill_entry.scope.root_ref.as_deref(), Some("@e1"));
    assert!(
        drill_entry.scope.path_is_absolute,
        "drilled refs must retain an absolute path for fast, scoped resolution"
    );
    assert_eq!(drill_entry.scope.path.as_slice(), [0, 0]);
    assert!(drill_entry.identity.unique_at_capture);
}

#[test]
fn test_run_from_ref_explicit_session_snapshot_with_matching_context() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_session("agent-a", seed_skeleton_refmap());

    let adapter = StubAdapter::new(named("button", "Save"));
    let context = crate::CommandContext::new(Some("agent-a".into()), None, false).unwrap();
    let result = run_from_ref_with_context(
        &adapter,
        &drill_opts(),
        &format!("@{snapshot_id}:e1"),
        &context,
        crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS,
    )
    .expect("session snapshot should drill within its namespace");

    assert_eq!(result.snapshot_id.as_deref(), Some(snapshot_id.as_str()));
    let on_disk = load_session_snapshot("agent-a", &snapshot_id);
    assert!(on_disk.get("@e1").is_some(), "skeleton anchor preserved");
    let drill_ref = result.tree.ref_id.as_deref().expect("drill ref");
    let drill_entry = on_disk
        .get(&local_ref(drill_ref))
        .expect("drill ref persisted");
    assert_eq!(drill_entry.identity.name.as_deref(), Some("Save"));
    assert!(
        RefStore::new()
            .unwrap()
            .latest_snapshot_id()
            .unwrap()
            .is_none()
    );
}

#[test]
fn test_run_from_ref_leaves_stored_refs_when_subtree_read_fails() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let adapter = StubAdapter::with_subtree_error(AdapterError::new(
        crate::ErrorCode::ActionFailed,
        "subtree failed",
    ));
    let result = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id));

    assert!(result.is_err());
    assert_eq!(
        load_latest().len(),
        2,
        "a failed drill must not persist refs"
    );
}

#[test]
fn test_run_from_ref_stale_root_returns_stale_ref() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(RefMap::new());

    let adapter = StubAdapter::new(named("group", "Sidebar"));
    let result = run_from_ref(&adapter, &drill_opts(), "@e99", Some(&snapshot_id));
    let err = match result {
        Ok(_) => panic!("stale root must error"),
        Err(e) => e,
    };
    match err {
        AppError::Adapter(adapter_err) => {
            assert_eq!(adapter_err.code, crate::ErrorCode::StaleRef);
            let suggestion = adapter_err.suggestion.as_deref().unwrap_or("");
            assert!(
                suggestion.contains("snapshot"),
                "stale-ref suggestion should mention running a snapshot, got: {suggestion}"
            );
        }
        other => panic!("expected Adapter(StaleRef), got {other:?}"),
    }
}

#[test]
fn test_run_from_ref_re_drill_replaces_drill_refs_only() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_latest(seed_skeleton_refmap());

    let subtree = named("button", "Save");
    let adapter = StubAdapter::new(subtree);

    let first = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();
    let first_count = first.refmap.len();
    let first_button_ref = first.tree.ref_id.clone().expect("button should get a ref");

    let second = run_from_ref(&adapter, &drill_opts(), "@e1", Some(&snapshot_id)).unwrap();
    let second_count = second.refmap.len();
    let second_button_ref = second.tree.ref_id.clone().expect("button should get a ref");

    assert_eq!(
        first_count, second_count,
        "ref count stable across re-drill"
    );
    assert_ne!(
        first_button_ref, second_button_ref,
        "re-drill should issue a fresh ref id (counter continues)"
    );
    let on_disk = load_latest();
    assert!(on_disk.get("@e1").is_some(), "skeleton anchor preserved");
    assert!(on_disk.get(&local_ref(&second_button_ref)).is_some());
    assert!(
        on_disk.get(&local_ref(&first_button_ref)).is_none(),
        "first drill ref must be invalidated by remove_by_root_ref"
    );
}

#[test]
fn a_tokenless_drill_refuses_a_depth_no_walk_supports() {
    use crate::snapshot::tokenless_capture_support as tokenless;

    let _guard = HomeGuard::new();
    let adapter = tokenless::CaptureAdapter::new(tokenless::anchored_window());
    let captured = tokenless::snapshot(&adapter);
    let (anchor_ref, _) = tokenless::named(&captured.refmap, "Sidebar");
    let snapshot_id = tokenless::save(&captured.refmap);
    let too_deep = TreeOptions {
        max_depth: 51,
        ..drill_opts()
    };
    let walks_before = adapter.captures();

    let drill = run_from_ref(&adapter, &too_deep, &anchor_ref, Some(&snapshot_id));

    match drill {
        Ok(_) => panic!("a depth no snapshotted walk reaches must be refused"),
        Err(AppError::Adapter(error)) => assert_eq!(error.code, crate::ErrorCode::InvalidArgs),
        Err(other) => panic!("expected Adapter(InvalidArgs), got {other:?}"),
    }
    assert_eq!(
        adapter.captures(),
        walks_before,
        "the refusal must land before the drill observes anything"
    );
}

#[path = "snapshot_ref_window_tests.rs"]
mod window_tests;

#[path = "snapshot_ref_merge_tests.rs"]
mod merge_tests;
