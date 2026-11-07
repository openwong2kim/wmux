use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::commands::type_text::{TypeArgs, execute};
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    ActionRequest, ActionResult, AdapterError, CommandContext, Rect, RefEntry, actions::capability,
};
use std::sync::Mutex;

/// A text field that a differently named field replaces at the same location
/// once the first keystroke has landed: the handle the burst keeps reaches a
/// different element from then on.
#[derive(Default)]
struct ReplacedField {
    typed: Mutex<String>,
}

impl ReplacedField {
    fn live_name(&self) -> &'static str {
        match self.typed.lock().unwrap().is_empty() {
            true => "Target",
            false => "Replacement",
        }
    }
}

impl ObservationOps for ReplacedField {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        adapter.live_name(),
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
    crate::adapter::saved_ref_scope!("textfield", Some("Target"));
}

impl ActionOps for ReplacedField {
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

impl InputOps for ReplacedField {}

impl SystemOps for ReplacedField {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();
}

pub(super) fn field_snapshot() -> String {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let mut entry = crate::adapter::minimal_ref_entry("textfield", Some("Target"));
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry.capabilities.available_actions = vec![capability::TYPE_TEXT.into()];
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-1".into());
    entry.source.source_window_title = Some("Fixture".into());
    let mut refmap = crate::refs::RefMap::new();
    refmap.allocate(entry);
    crate::refs::refs_store::RefStore::new()
        .expect("the ref store")
        .save_new_snapshot(&refmap)
        .expect("the snapshot")
}

/// `type --interval-ms` re-identifies the burst's element under every
/// keystroke's lease: once a field with another name occupies the same
/// location, the remaining text is refused instead of typed into it.
#[test]
fn a_field_replaced_mid_burst_refuses_the_remaining_keystrokes() {
    let _home = HomeGuard::new();
    let snapshot_id = field_snapshot();
    let adapter = ReplacedField::default();

    let error = execute(
        TypeArgs {
            ref_id: format!("@{snapshot_id}:e1"),
            text: "abc".into(),
            timeout_ms: None,
            interval_ms: Some(5),
        },
        &adapter,
        &CommandContext::default(),
    )
    .expect_err("the replacement is refused");

    assert_eq!(error.code(), "STALE_REF");
    assert_eq!(*adapter.typed.lock().unwrap(), "a");
}
