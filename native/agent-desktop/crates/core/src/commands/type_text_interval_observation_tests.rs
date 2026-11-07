use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::commands::type_text::{TypeArgs, execute};
use crate::locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree};
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    ActionRequest, ActionResult, AdapterError, CommandContext, RefEntry, actions::capability,
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A text field that counts how often its whole window is observed.
#[derive(Default)]
struct CountedField {
    typed: Mutex<String>,
    window_reads: AtomicUsize,
}

impl ObservationOps for CountedField {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if matches!(root, ObservationRoot::Window(_)) {
            self.window_reads.fetch_add(1, Ordering::SeqCst);
        }
        crate::adapter::saved_ref_tree(root, "textfield", Some("Target"))
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "Target",
        [capability::TYPE_TEXT],
        adapter => crate::ElementState {
            role: "textfield".into(),
            states: Vec::new(),
            value: Some(adapter.typed.lock().unwrap().clone()),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }
    );
    crate::adapter::saved_ref_anchor!();
    crate::adapter::saved_ref_scope!(@inventory);
}

impl ActionOps for CountedField {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if let crate::Action::TypeText(text) = request.action {
            self.typed.lock().unwrap().push_str(&text);
        }
        Ok(ActionResult::delivered_unverified("type_text"))
    }
}

impl InputOps for CountedField {}

impl SystemOps for CountedField {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();
}

/// `type --interval-ms` keeps the element its first keystroke landed on: the
/// whole window is read once for the whole burst, not again to start it.
#[test]
fn a_burst_reads_the_whole_window_once() {
    let _home = HomeGuard::new();
    let snapshot_id = super::identity::field_snapshot();
    let adapter = CountedField::default();

    execute(
        TypeArgs {
            ref_id: format!("@{snapshot_id}:e1"),
            text: "abc".into(),
            timeout_ms: None,
            interval_ms: Some(5),
        },
        &adapter,
        &CommandContext::default(),
    )
    .expect("typing succeeds");

    assert_eq!(*adapter.typed.lock().unwrap(), "abc");
    assert_eq!(adapter.window_reads.load(Ordering::SeqCst), 1);
}
