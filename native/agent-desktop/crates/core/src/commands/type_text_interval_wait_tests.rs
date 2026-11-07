use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps, WindowFilter};
use crate::commands::type_text::{TypeArgs, execute};
use crate::context::WaitSelector;
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    AccessibilityNode, ActionRequest, ActionResult, AdapterError, CommandContext, RefEntry,
    WindowInfo,
};
use std::sync::Mutex;

/// A field whose window title reads back whatever has been typed so far, so a
/// `--wait-for` on the title passes only once the whole text is in.
#[derive(Default)]
struct TitledField {
    typed: Mutex<String>,
}

impl TitledField {
    fn window(&self) -> AccessibilityNode {
        AccessibilityNode {
            ref_id: None,
            role: "window".into(),
            identity: crate::NodeIdentity {
                name: Some(self.typed.lock().unwrap().clone()),
                ..Default::default()
            },
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children: vec![crate::adapter::minimal_accessibility_node(
                "textfield",
                "Target",
            )],
        }
    }
}

impl ObservationOps for TitledField {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        if matches!(
            root,
            crate::locator::live_locator::ObservationRoot::Element { .. }
        ) {
            return crate::adapter::saved_ref_element_tree(root);
        }
        crate::adapter::observed_tree(&root, self.window())
    }

    fn get_tree(
        &self,
        _window: &WindowInfo,
        _options: &crate::adapter::TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        Ok(self.window())
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![WindowInfo {
            id: "w-1".into(),
            title: "Doc".into(),
            app: "Fixture".into(),
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
            bounds: None,
            state: crate::WindowState {
                is_focused: true,
                ..Default::default()
            },
        }])
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "Target",
        [crate::actions::capability::TYPE_TEXT],
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
}

impl ActionOps for TitledField {
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

impl InputOps for TitledField {}

impl SystemOps for TitledField {
    fn resolve_window_strict(
        &self,
        expected: &WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        assert_eq!(expected.id, "w-1");
        assert_eq!(expected.pid, crate::ProcessId::new(1));
        assert_eq!(expected.process_instance.as_deref(), Some("test-instance"));
        Ok(expected.clone())
    }

    crate::adapter::guarded_interaction_lease!();
}

/// A wait for the whole text would time out if it ran after the first
/// keystroke, and the rest would never be typed. It runs once, after the last.
#[test]
fn a_wait_for_runs_once_after_the_last_keystroke() {
    let _guard = HomeGuard::new();
    let mut entry = crate::adapter::minimal_ref_entry("textfield", Some("Target"));
    entry.source.source_window_id = Some("w-1".into());
    entry.capabilities.available_actions = vec!["SetValue".into()];
    let mut refmap = crate::RefMap::new();
    refmap.allocate(entry);
    let snapshot_id = crate::RefStore::new()
        .unwrap()
        .save_new_snapshot(&refmap)
        .unwrap();
    let adapter = TitledField::default();
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: ":abc".into(),
        gone: false,
        timeout_ms: 300,
    }));

    let value = execute(
        TypeArgs {
            ref_id: format!("@{snapshot_id}:e1"),
            text: "abc".into(),
            timeout_ms: None,
            interval_ms: Some(10),
        },
        &adapter,
        &context,
    )
    .expect("the wait is met once every keystroke has landed");

    assert_eq!(*adapter.typed.lock().unwrap(), "abc");
    assert_eq!(value["matched_selector"], ":abc");
    assert_eq!(value["after_action"]["keystrokes"], 3);
}
