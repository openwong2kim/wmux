use super::*;
use crate::adapter::NoopAdapter as DefaultSurfaceAdapter;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps, WindowFilter};
use crate::context::{CommandContext, WaitSelector};
use crate::refs::refs_test_support::HomeGuard;
use crate::{AccessibilityNode, WindowInfo};
use crate::{AdapterError, ErrorCode};
struct NoopAdapter;
impl ObservationOps for NoopAdapter {}

impl ActionOps for NoopAdapter {}

impl InputOps for NoopAdapter {}

impl SystemOps for NoopAdapter {
    fn supported_surfaces(&self) -> Vec<SnapshotSurface> {
        vec![SnapshotSurface::Window]
    }
}

struct WaitSnapshotAdapter;

impl ObservationOps for WaitSnapshotAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        crate::adapter::observed_tree(
            &root,
            AccessibilityNode {
                ref_id: None,
                role: "window".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some("Doc".into()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![
                    AccessibilityNode {
                        ref_id: None,
                        role: "button".into(),
                        identity: crate::NodeIdentity {
                            retained_object: None,
                            name: Some("Submit".into()),
                            ..Default::default()
                        },
                        presentation: Default::default(),
                        children_count: None,
                        subtree_truncated: false,
                        children: vec![],
                    },
                    AccessibilityNode {
                        ref_id: None,
                        role: "button".into(),
                        identity: crate::NodeIdentity {
                            retained_object: None,
                            name: Some("zero-bounds-button".into()),
                            ..Default::default()
                        },
                        presentation: crate::NodePresentation {
                            bounds: Some(crate::Rect {
                                x: 0.0,
                                y: 0.0,
                                width: 0.0,
                                height: 0.0,
                            }),
                            ..Default::default()
                        },
                        children_count: None,
                        subtree_truncated: false,
                        children: vec![],
                    },
                ],
            },
        )
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![WindowInfo {
            id: "w-1".into(),
            title: "Doc".into(),
            app: "FixtureApp".into(),
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
            bounds: None,
            state: crate::WindowState {
                is_focused: true,
                ..Default::default()
            },
        }])
    }

    fn get_tree(
        &self,
        _win: &WindowInfo,
        _opts: &crate::adapter::TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        Ok(AccessibilityNode {
            ref_id: None,
            role: "window".into(),
            identity: crate::NodeIdentity {
                retained_object: None,
                name: Some("Doc".into()),
                ..Default::default()
            },
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children: vec![AccessibilityNode {
                ref_id: None,
                role: "button".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some("Submit".into()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![],
            }],
        })
    }
}

impl ActionOps for WaitSnapshotAdapter {}

impl InputOps for WaitSnapshotAdapter {}

impl SystemOps for WaitSnapshotAdapter {
    fn supported_surfaces(&self) -> Vec<SnapshotSurface> {
        vec![SnapshotSurface::Window]
    }
}

fn base_args() -> SnapshotArgs {
    SnapshotArgs {
        app: None,
        window_id: None,
        max_depth: 8,
        include_bounds: false,
        interactive_only: false,
        compact: false,
        surface: SnapshotSurface::Window,
        skeleton: false,
        root_ref: None,
        timeout_ms: None,
        force_electron_a11y: false,
    }
}

fn args_with_surface(surface: SnapshotSurface) -> SnapshotArgs {
    SnapshotArgs {
        surface,
        root_ref: Some("@e3".into()),
        ..base_args()
    }
}

#[test]
fn test_tree_options_clamps_skeleton_depth() {
    let mut args = base_args();
    args.skeleton = true;

    let opts = tree_options(&args);

    assert_eq!(opts.max_depth, 3);
    assert!(
        opts.skeleton,
        "skeleton flag must propagate for full snapshots"
    );
}

#[test]
fn test_tree_options_suppresses_skeleton_for_drill_down() {
    let mut args = base_args();
    args.skeleton = true;
    args.root_ref = Some("@e3".into());

    let opts = tree_options(&args);

    assert_eq!(
        opts.max_depth, 8,
        "depth must not be clamped for drill-down"
    );
    assert!(
        !opts.skeleton,
        "skeleton flag must be suppressed for drill-down so build_subtree \
         returns the full subtree and allocate_refs does not tag anchors"
    );
}

#[test]
fn default_snapshot_retains_zero_sized_node_with_ref() {
    let args = base_args();
    let result = crate::snapshot::build(
        &WaitSnapshotAdapter,
        &tree_options(&args),
        Some("FixtureApp"),
        None,
        crate::Deadline::standard().unwrap(),
    )
    .unwrap();
    let zero = result
        .tree
        .children
        .iter()
        .find(|node| node.identity.name.as_deref() == Some("zero-bounds-button"))
        .unwrap();

    assert!(zero.ref_id.is_some());
    assert_eq!(result.refmap.len(), 2);
}

#[test]
fn test_root_with_menu_surface_rejected() {
    let args = args_with_surface(SnapshotSurface::Menu);
    let err = execute(args, &NoopAdapter, &CommandContext::default())
        .expect_err("should reject --root + --surface");
    match err {
        AppError::Adapter(adapter_err) => {
            assert_eq!(adapter_err.code, ErrorCode::InvalidArgs);
            assert!(
                adapter_err.message.contains("--root") && adapter_err.message.contains("--surface"),
                "error message should name both flags, got: {}",
                adapter_err.message
            );
        }
        other => panic!("expected Adapter(InvalidArgs), got {other:?}"),
    }
}

#[path = "snapshot_log_tests.rs"]
mod log_tests;

#[test]
fn test_root_with_window_surface_does_not_short_circuit_validation() {
    let args = args_with_surface(SnapshotSurface::Window);
    let result = execute(args, &NoopAdapter, &CommandContext::default());
    assert!(
        result.is_err(),
        "NoopAdapter cannot satisfy run_from_ref so this must error"
    );
    let AppError::Adapter(adapter_err) = result.unwrap_err() else {
        panic!("a window surface with a bare --root must fail as an adapter error");
    };
    assert_eq!(adapter_err.code, ErrorCode::InvalidArgs);
    assert!(adapter_err.message.contains("expected @<snapshot_id>:e<N>"));
    assert!(!adapter_err.message.contains("--surface"));
}

#[test]
fn unsupported_surface_fails_before_adapter_traversal() {
    let sheet = || SnapshotArgs {
        surface: SnapshotSurface::Sheet,
        ..base_args()
    };
    assert!(matches!(
        execute(sheet(), &NoopAdapter, &CommandContext::default()),
        Err(AppError::Adapter(error)) if error.code == ErrorCode::InvalidArgs
    ));
    let err = execute(sheet(), &DefaultSurfaceAdapter, &CommandContext::default()).unwrap_err();
    let AppError::Adapter(adapter_error) = err else {
        panic!("expected adapter error")
    };

    assert_eq!(adapter_error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(
        adapter_error.details,
        Some(serde_json::json!({ "requested_surface": "sheet", "supported_surfaces": [] }))
    );
}

#[test]
fn test_invalid_root_ref_format_returns_invalid_args() {
    let args = SnapshotArgs {
        root_ref: Some("not-a-ref".into()),
        ..base_args()
    };
    let err = execute(args, &NoopAdapter, &CommandContext::default())
        .expect_err("malformed --root should fail");
    match err {
        AppError::Adapter(adapter_err) => {
            assert_eq!(
                adapter_err.code,
                ErrorCode::InvalidArgs,
                "malformed ref must return INVALID_ARGS, not STALE_REF"
            );
        }
        other => panic!("expected Adapter(InvalidArgs), got {other:?}"),
    }
}

#[test]
fn test_bare_root_ref_is_rejected_with_a_qualified_ref_suggestion() {
    let args = SnapshotArgs {
        root_ref: Some("@e42".into()),
        ..base_args()
    };
    let err = execute(args, &NoopAdapter, &CommandContext::default())
        .expect_err("bare refs are not accepted");
    let AppError::Adapter(adapter_err) = err else {
        panic!("expected an adapter error");
    };
    assert_eq!(adapter_err.code, ErrorCode::InvalidArgs);
    assert!(adapter_err.message.contains("expected @<snapshot_id>:e<N>"));
    assert!(
        adapter_err
            .suggestion
            .as_deref()
            .is_some_and(|suggestion| suggestion.contains("@s8f3k2p9:e1"))
    );
}

#[test]
fn wait_for_selector_returns_matched_snapshot() {
    let _guard = HomeGuard::new();
    let mut args = base_args();
    args.app = Some("FixtureApp".into());
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: "button:Submit".into(),
        gone: false,
        timeout_ms: 5_000,
    }));
    let value = execute(args, &WaitSnapshotAdapter, &context).unwrap();
    assert_eq!(value["matched_selector"], "button:Submit");
    assert!(value["snapshot_id"].as_str().is_some());
}

#[test]
fn root_and_wait_for_are_mutually_exclusive() {
    let mut args = base_args();
    args.root_ref = Some("@e1".into());
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: "button:Submit".into(),
        gone: false,
        timeout_ms: 5_000,
    }));
    let err = execute(args, &NoopAdapter, &context).expect_err("root + wait must fail");
    match err {
        AppError::Adapter(adapter_err) => {
            assert_eq!(adapter_err.code, ErrorCode::InvalidArgs);
        }
        other => panic!("expected InvalidArgs, got {other:?}"),
    }
}

#[test]
fn an_unproven_capture_is_flagged_in_the_payload() {
    let mut result = crate::snapshot::SnapshotResult {
        tree: crate::adapter::minimal_accessibility_node("window", "Fixture"),
        refmap: crate::RefMap::new(),
        owner: crate::SnapshotOwner::Window(WindowInfo {
            id: "w-1".into(),
            title: "Fixture".into(),
            app: "Fixture".into(),
            pid: crate::ProcessId::new(1),
            process_instance: None,
            bounds: None,
            state: crate::WindowState::default(),
        }),
        snapshot_id: None,
        complete: true,
        nodes_observed: 1,
        identity_unproven: None,
    };
    let proven = format_snapshot_fields(&result, None, None).unwrap();
    assert!(proven.get("identity_unproven").is_none());
    assert_eq!(proven["window"]["id"], "w-1");
    let crate::SnapshotOwner::Window(window) = &mut result.owner else {
        panic!("expected a window owner");
    };
    window.id.clear();
    assert!(
        format_snapshot_fields(&result, None, None)
            .unwrap()
            .get("window")
            .is_none()
    );

    result.identity_unproven = Some("the whole-window read was cut short".into());
    let unproven = format_snapshot_fields(&result, None, None).unwrap();
    assert_eq!(unproven["identity_unproven"], true);
    assert_eq!(unproven["complete"], true);
}
