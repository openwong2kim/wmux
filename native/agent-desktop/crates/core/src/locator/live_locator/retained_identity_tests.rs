use super::test_support::{evidence, node, tree};
use super::{IdentifierEvidence, LocatorField};
use crate::{IdentityMatch, RefEntry, locator::LocatorQuery};

fn identifiers(token: Option<&str>) -> IdentifierEvidence {
    let identifiers = IdentifierEvidence::typed(
        [crate::ElementIdentifier {
            kind: crate::IdentifierKind::AxIdentifier,
            value: "shared-title".into(),
        }],
        Some(0),
        true,
    );
    match token {
        Some(token) => identifiers.with_retained_object(token.into()),
        None => identifiers,
    }
}

fn observed() -> super::ObservedTree {
    let mut field = evidence("textfield", None);
    field.value = LocatorField::Known("Alpha".into());
    field.identifiers = identifiers(Some("host-generation:object-1"));
    tree(vec![node(0, field, vec![], &[])], vec![0], true)
}

fn saved() -> RefEntry {
    let tree = observed();
    super::materialize::ref_entry(&tree.nodes[0], &tree.source, &LocatorQuery::default())
}

fn matches(entry: &RefEntry, token: Option<&str>, value: &str) -> IdentityMatch {
    crate::refs::ref_identity::identity_match(
        entry,
        &LocatorField::Absent,
        &LocatorField::Known(value.into()),
        &LocatorField::Absent,
        &identifiers(token),
    )
}

#[test]
fn a_positional_retained_object_never_decides_identity() {
    let entry = saved();
    for token in [
        Some("host-generation:object-1"),
        Some("host-generation:object-2"),
        None,
    ] {
        assert_eq!(
            matches(&entry, token, "Alpha"),
            IdentityMatch::Match,
            "a positional retained object must not decide identity: {token:?}"
        );
    }
    assert!(crate::refs::ref_identity::has_meaningful_identity(&entry));
}

#[test]
fn an_element_token_decides_identity_on_its_own() {
    let mut entry = saved();
    entry.identity.retained_object = Some("axtok1:7f3a".into());

    assert_eq!(
        matches(&entry, Some("axtok1:7f3a"), "Edited"),
        IdentityMatch::Match
    );
    assert_eq!(
        matches(&entry, Some("host-generation:object-2"), "Alpha"),
        IdentityMatch::NoMatch
    );
    assert_eq!(
        matches(&entry, Some("other-host:object-1"), "Alpha"),
        IdentityMatch::NoMatch
    );
    assert_eq!(matches(&entry, None, "Alpha"), IdentityMatch::Unknown);
    assert!(crate::refs::ref_identity::has_meaningful_identity(&entry));
}

#[test]
fn snapshot_and_find_preserve_identical_private_identity_evidence() {
    let from_find = saved();
    let projected = observed().into_accessibility_tree().unwrap();
    let from_snapshot = crate::refs::ref_alloc::ref_entry_from_node(
        &projected,
        &crate::refs::ref_alloc_source::RefAllocSource {
            pid: crate::ProcessId::new(42),
            app: Some("FixtureApp"),
            window_id: Some("w-1"),
            window_title: Some("Fixture"),
            window_bounds_hash: None,
            process_instance: Some("test-instance"),
            surface: crate::SnapshotSurface::Window,
        },
        None,
        &[],
    );
    assert_eq!(from_find.identity, from_snapshot.identity);
    let serialized = serde_json::to_string(&from_snapshot).unwrap();
    let restored: RefEntry = serde_json::from_str(&serialized).unwrap();
    assert_eq!(restored.identity, from_find.identity);
    let public = serde_json::to_value(projected).unwrap();
    assert!(public.get("retained_object").is_none());
    assert_eq!(public["native_id"]["value"], "shared-title");
}

#[test]
fn an_empty_retained_object_is_not_an_element_token() {
    let mut entry = saved();
    entry.identity.retained_object = Some(String::new());
    assert!(crate::refs::ref_identity::element_token(&entry).is_none());
    assert_eq!(matches(&entry, Some(""), "Alpha"), IdentityMatch::Match);
    assert_eq!(matches(&entry, None, "Alpha"), IdentityMatch::Match);
}
