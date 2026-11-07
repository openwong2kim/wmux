use super::MenuContext;
use crate::tree::live::test_support::ref_entry;
use crate::tree::{AtspiElement, Field, LabelOutcome, ObservedRead, WalkedNode};

fn labelled_popup(label: LabelOutcome) -> WalkedNode<ObservedRead> {
    fn node(path: &str, label: LabelOutcome) -> WalkedNode<ObservedRead> {
        let mut payload = crate::tree::live::test_support::read_of(35, "", &[]);
        payload.node.element = AtspiElement::new(":1.1", path, 1);
        payload.label = label;
        WalkedNode {
            payload,
            children: Vec::new(),
            truncated: false,
            child_count: None,
            source_index: 0,
            in_web_document: false,
        }
    }
    let mut root = node("/popup", LabelOutcome::Unlabelled);
    root.payload.node.traits.role = crate::tree::Field::Present(33);
    root.children = vec![
        node("/popup/shared", LabelOutcome::Text("Open".to_owned())),
        node("/popup/context", label),
    ];
    root
}

#[test]
fn unreadable_popup_role_or_name_cannot_certify_a_reused_item_path() {
    let complete = MenuContext::from_walk(&labelled_popup(LabelOutcome::Unlabelled));
    assert!(complete.matches(&complete));

    for field in ["role", "name"] {
        let mut popup = labelled_popup(LabelOutcome::Unlabelled);
        let context = &mut popup.children[1].payload.node;
        match field {
            "role" => context.traits.role = Field::Failed("read failed".to_owned()),
            "name" => context.properties.name = Field::Failed("read failed".to_owned()),
            _ => unreachable!(),
        }
        let captured = MenuContext::from_walk(&popup);
        let replacement = MenuContext::from_walk(&popup);
        let mut entry = ref_entry("menuitem");
        entry.identity.retained_object = Some(captured.encode("/popup/shared"));

        assert!(!captured.matches(&replacement), "unreadable {field}");
        assert!(
            replacement.entry_for(&entry).is_none(),
            "unreadable {field}"
        );
    }
}

#[test]
fn a_changed_relation_label_rejects_a_ref_even_when_raw_names_and_paths_are_reused() {
    let original = MenuContext::from_walk(&labelled_popup(LabelOutcome::Text("Document A".into())));
    let replacement =
        MenuContext::from_walk(&labelled_popup(LabelOutcome::Text("Document B".into())));
    let mut entry = ref_entry("menuitem");
    entry.identity.retained_object = Some(original.encode("/popup/shared"));

    assert!(original.entry_for(&entry).is_some());
    assert!(replacement.entry_for(&entry).is_none());
}

#[test]
fn an_unreadable_relation_label_cannot_prove_that_the_popup_context_is_unchanged() {
    let context = MenuContext::from_walk(&labelled_popup(LabelOutcome::Failed));
    let mut entry = ref_entry("menuitem");
    entry.identity.retained_object = Some(context.encode("/popup/shared"));

    assert!(!context.matches(&context));
    assert!(context.entry_for(&entry).is_none());
}

#[test]
fn a_menu_ref_is_rejected_when_a_different_popup_reuses_the_item_path() {
    let captured = MenuContext {
        root: "/org/a11y/atspi/accessible/10".to_owned(),
        shape: 100,
        complete: true,
    };
    let replacement = MenuContext {
        root: "/org/a11y/atspi/accessible/20".to_owned(),
        shape: 200,
        complete: true,
    };
    let mut entry = ref_entry("menuitem");
    entry.identity.retained_object = Some(captured.encode("/org/a11y/atspi/accessible/10/0"));

    assert!(replacement.entry_for(&entry).is_none());
}

#[test]
fn a_truncated_popup_prefix_cannot_match_or_resolve_a_same_shape_ref() {
    let incomplete = MenuContext {
        root: "/org/a11y/atspi/accessible/menu".to_owned(),
        shape: 100,
        complete: false,
    };
    let mut entry = ref_entry("menuitem");
    entry.identity.retained_object = Some(incomplete.encode("/org/a11y/atspi/accessible/menu/0"));

    assert!(!incomplete.matches(&incomplete));
    assert!(incomplete.entry_for(&entry).is_none());
}

#[test]
fn the_captured_popup_context_restores_the_original_item_path_for_resolution() {
    let context = MenuContext {
        root: "/org/a11y/atspi/accessible/10".to_owned(),
        shape: 100,
        complete: true,
    };
    let mut entry = ref_entry("menuitem");
    entry.identity.retained_object = Some(context.encode("/org/a11y/atspi/accessible/10/0"));

    let scoped = context.entry_for(&entry).expect("same popup context");
    assert_eq!(
        scoped.identity.retained_object.as_deref(),
        Some("/org/a11y/atspi/accessible/10/0")
    );
}

#[test]
fn a_menu_context_round_trips_utf8_paths_and_item_paths() {
    let context = MenuContext {
        root: "/org/a11y/atspi/accessible/メニュー".to_owned(),
        shape: 123,
        complete: true,
    };
    let token = context.encode("/org/a11y/atspi/accessible/メニュー/0");

    let (decoded, object) = MenuContext::decode(&token).expect("valid context token");
    assert!(context.matches(&decoded));
    assert_eq!(object, "/org/a11y/atspi/accessible/メニュー/0");
}

#[test]
fn a_menu_ref_without_its_popup_context_cannot_be_scoped_to_any_popup() {
    let context = MenuContext::test("/popup", 10);
    let entry = ref_entry("menuitem");

    assert!(entry.identity.retained_object.is_none());
    assert!(context.entry_for(&entry).is_none());
}

#[test]
fn observed_menu_context_is_validated_through_the_adapter_without_a_live_read() {
    use agent_desktop_core::{ObservationOps, SnapshotSurface};

    let adapter = crate::LinuxAdapter::new();
    let context = MenuContext::test("/popup", 10);
    let complete = context.encode("/item");
    let incomplete = MenuContext::test_incomplete("/popup", 10).encode("/item");
    let mut entry = ref_entry("menuitem");
    entry.source.source_surface = SnapshotSurface::Menu;
    entry.identity.retained_object = Some(complete.clone());
    let same_popup = context.encode("/other-item");
    assert!(
        adapter
            .validate_saved_ref_context(&entry, Some(&same_popup))
            .is_ok()
    );

    for (saved, observed, kind) in [
        (
            Some(complete.clone()),
            Some(MenuContext::test("/replacement", 10).encode("/item")),
            "menu_context_changed",
        ),
        (
            Some(complete.clone()),
            Some(MenuContext::test("/popup", 20).encode("/item")),
            "menu_context_changed",
        ),
        (
            Some(complete.clone()),
            Some(incomplete.clone()),
            "menu_context_unknown",
        ),
        (
            Some(incomplete),
            Some(complete.clone()),
            "menu_context_unknown",
        ),
        (None, Some(complete.clone()), "menu_context_unknown"),
        (Some(complete.clone()), None, "menu_context_unknown"),
        (
            Some(complete.clone()),
            Some("malformed".into()),
            "menu_context_unknown",
        ),
        (
            Some("malformed".into()),
            Some(complete.clone()),
            "menu_context_unknown",
        ),
        (
            Some(complete.clone()),
            Some(context.encode("")),
            "menu_context_unknown",
        ),
        (
            Some(context.encode("")),
            Some(complete),
            "menu_context_unknown",
        ),
    ] {
        entry.identity.retained_object = saved;
        let error = adapter
            .validate_saved_ref_context(&entry, observed.as_deref())
            .unwrap_err();
        assert_eq!(error.code, agent_desktop_core::ErrorCode::StaleRef);
        let details = error.details.unwrap();
        assert_eq!(details["kind"], kind);
        assert_eq!(details["retryable"], kind == "menu_context_unknown");
    }
    entry.source.source_surface = SnapshotSurface::Window;
    assert!(adapter.validate_saved_ref_context(&entry, None).is_ok());
}
