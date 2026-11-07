use super::*;
use crate::locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree};

/// A window whose whole-window read differs from what the provisional landing
/// sees: a twin of the target, or one read that comes back cut short.
struct DispatchReadAdapter {
    window_reads: AtomicU32,
    dispatches: AtomicU32,
    twin: bool,
    disabled_after_a_read: bool,
}

impl DispatchReadAdapter {
    fn new(twin: bool) -> Self {
        Self {
            window_reads: AtomicU32::new(0),
            dispatches: AtomicU32::new(0),
            twin,
            disabled_after_a_read: false,
        }
    }
}

impl ObservationOps for DispatchReadAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if matches!(root, ObservationRoot::Element { .. }) {
            return crate::adapter::saved_ref_element_tree(root);
        }
        let read = self.window_reads.fetch_add(1, Ordering::SeqCst) + 1;
        if self.twin {
            return crate::adapter::saved_ref_tree_nodes(
                root,
                &[("button", Some("Run"), None), ("button", Some("Run"), None)],
            );
        }
        if read == 1 {
            let mut unread = crate::adapter::minimal_accessibility_node("scrollarea", "Feed");
            unread.children_count = Some(3);
            let mut window = crate::adapter::minimal_accessibility_node("group", "");
            window.identity.name = None;
            window.children = vec![
                crate::adapter::minimal_accessibility_node("button", "Run"),
                unread,
            ];
            return crate::adapter::observed_tree(&root, window);
        }
        crate::adapter::saved_ref_tree(root, "button", Some("Run"))
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn list_windows(
        &self,
        _filter: &crate::adapter::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        Ok(crate::adapter::saved_ref_window_pool())
    }

    crate::adapter::complete_live_observation!(
        "button",
        "Run",
        [capability::CLICK],
        adapter => crate::ElementState {
            role: "button".into(),
            states: Vec::new(),
            value: None,
            enabled: Some(
                !(adapter.disabled_after_a_read && adapter.window_reads.load(Ordering::SeqCst) > 0),
            ),
            hidden: Some(false),
            offscreen: Some(false),
        }
    );
}

impl ActionOps for DispatchReadAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for DispatchReadAdapter {}

impl SystemOps for DispatchReadAdapter {
    crate::adapter::guarded_interaction_lease!();
}

fn click(adapter: &DispatchReadAdapter, timeout_ms: u64) -> Result<ActionResult, AdapterError> {
    execute_with_auto_wait(
        RefActionWaitCtx {
            adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        request_with_timeout(timeout_ms),
        crate::ref_action::ref_action_single::dispatch_resolved,
    )
}

#[test]
fn a_twin_found_by_the_count_under_the_lease_is_never_dispatched() {
    let adapter = DispatchReadAdapter::new(true);

    let error = click(&adapter, 2_000).unwrap_err();

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.unwrap()["kind"], "saved_ref_ambiguous");
    assert_eq!(adapter.window_reads.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
}

#[test]
fn a_cut_short_count_under_the_lease_waits_again_within_the_budget() {
    let adapter = DispatchReadAdapter::new(false);

    click(&adapter, 5_000).expect("the second whole-window read is complete");

    assert_eq!(adapter.window_reads.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 1);
}

#[test]
fn a_budget_spent_after_a_refusal_reports_that_refusal() {
    let mut adapter = DispatchReadAdapter::new(false);
    adapter.disabled_after_a_read = true;

    let error = click(&adapter, 600).unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.expect("timeout details");
    assert_eq!(details["refusal"]["code"], "TIMEOUT");
    assert_eq!(
        details["refusal"]["details"]["kind"],
        "resolution_identity_unknown"
    );
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
}
