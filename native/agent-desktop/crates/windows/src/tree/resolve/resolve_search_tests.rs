use super::*;
use agent_desktop_core::ElementIdentifier;

fn entry() -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry("button");
    entry.identity.name = Some("name".into());
    entry.identity.native_id = Some(ElementIdentifier {
        kind: agent_desktop_core::IdentifierKind::AutomationId,
        value: "id".into(),
    });
    entry.scope.path_is_absolute = true;
    entry
}

/// Window-rootedness is a disjunction and every other builder in this file
/// leaves `root_ref` unset, which satisfies it through the first disjunct
/// alone. Both disjuncts are pinned here, in both directions: dropping the
/// absolute-path one would settle every drill-down anchor `STALE_REF` while
/// the rest of this suite stayed green.
#[test]
fn a_drill_down_ref_is_window_rooted_only_when_its_path_is_absolute() {
    let mut absolute_under_a_root = entry();
    absolute_under_a_root.scope.root_ref = Some("root".to_string());
    absolute_under_a_root.scope.path_is_absolute = true;
    assert!(window_rooted(&absolute_under_a_root));

    let mut relative_under_a_root = absolute_under_a_root.clone();
    relative_under_a_root.scope.path_is_absolute = false;
    assert!(!window_rooted(&relative_under_a_root));
}

/// The other disjunct, isolated the same way: a ref with no drill-down root at
/// all is window-rooted whatever its path flag says.
#[test]
fn a_ref_with_no_drill_down_root_is_window_rooted_whatever_its_path_flag() {
    let mut rootless = entry();
    rootless.scope.root_ref = None;
    rootless.scope.path_is_absolute = false;
    assert!(window_rooted(&rootless));

    rootless.scope.path_is_absolute = true;
    assert!(window_rooted(&rootless));
}
