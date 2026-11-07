use super::*;
use crate::tree::resolve::resolve_fake::Fake;

#[test]
fn a_childless_native_frame_is_conclusively_empty() {
    let fake = Fake::new();
    let mut entry = fake.entry_of("/frame", true);
    entry.identity.name = Some("window".to_owned());
    assert!(!evaluate(&fake.walk(), &entry, false).unread_region);
}

#[test]
fn an_unnamed_container_is_never_admitted_by_its_object_path() {
    use crate::tree::resolve::resolve_fake::{FRAME_PATH, node};
    use crate::tree::vocabulary::role_numbers::PANEL;

    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/viewport", node(PANEL, "", 0, 0));
    fake.add(FRAME_PATH, "/other", node(PANEL, "Named peer", 0, 0));
    let mut entry = fake.entry_of("/viewport", false);
    entry.identity.retained_object = Some(":1.2/viewport".to_owned());
    let found = evaluate(&fake.walk(), &entry, false);
    assert!(found.candidates.is_empty());
    assert!(found.unread_region);

    entry.identity.retained_object = Some(":1.2/replaced".to_owned());
    let found = evaluate(&fake.walk(), &entry, false);
    assert!(found.candidates.is_empty());
    assert!(found.unread_region);
}

#[test]
fn a_named_menu_item_is_counted_by_its_identity_not_its_object_path() {
    use crate::tree::resolve::resolve_fake::{FRAME_PATH, node};
    use crate::tree::vocabulary::role_numbers::MENU_ITEM;

    let mut fake = Fake::new();
    fake.add(
        FRAME_PATH,
        "/preferences",
        node(MENU_ITEM, "Preferences", 0, 0),
    );
    fake.add(FRAME_PATH, "/other", node(MENU_ITEM, "Preferences", 0, 0));
    let mut entry = fake.entry_of("/preferences", false);
    entry.source.source_surface = agent_desktop_core::SnapshotSurface::Menu;
    entry.identity.retained_object = Some(":1.2/preferences".to_owned());

    let found = evaluate(&fake.walk(), &entry, false);
    assert!(!found.unread_region);
    assert_eq!(found.candidates.len(), 2);

    entry.identity.retained_object = Some(":1.2/removed".to_owned());
    let found = evaluate(&fake.walk(), &entry, false);
    assert!(!found.unread_region);
    assert_eq!(found.candidates.len(), 2);
}
