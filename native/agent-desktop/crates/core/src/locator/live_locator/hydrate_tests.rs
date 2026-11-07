use super::*;
use crate::locator::live_locator::test_support::{evidence, node, tree};

#[test]
fn selected_hydration_preserves_window_geometry_and_refuses_unread_or_mixed_frames() {
    use crate::{BoundsSpace, LocatorField, Rect};
    let bounds = Rect {
        x: 10.0,
        y: 20.0,
        width: 80.0,
        height: 30.0,
    };
    let query = LocatorQuery::default();
    let mut observed = node(0, evidence("button", None), vec![], &[]);
    observed.evidence.ref_evidence.bounds = LocatorField::Unknown;
    observed.evidence.ref_evidence.window_bounds = LocatorField::Known(bounds);
    let source = tree(vec![observed.clone()], vec![0], true).source;
    let mut entry = super::super::materialize::ref_entry(&observed, &source, &query);
    assert_eq!(entry.geometry.bounds_space, Some(BoundsSpace::Window));
    assert!(evidence_complete(&query, &observed, BoundsSpace::Window));
    assert!(anchor_matches(&entry, &observed, false));

    observed.evidence.ref_evidence.window_bounds = LocatorField::Known(Rect { x: 110.0, ..bounds });
    observed.evidence.ref_evidence.bounds = LocatorField::Known(bounds);
    assert!(!anchor_matches(&entry, &observed, false));
    observed.evidence.ref_evidence.bounds = LocatorField::Unknown;
    for window in [LocatorField::Unknown, LocatorField::Absent] {
        observed.evidence.ref_evidence.window_bounds = window;
        assert!(!evidence_complete(&query, &observed, BoundsSpace::Window));
        assert!(!anchor_matches(&entry, &observed, false));
    }
    observed.evidence.ref_evidence.window_bounds = LocatorField::Unknown;
    observed.evidence.ref_evidence.bounds = LocatorField::Known(bounds);
    assert!(!evidence_complete(&query, &observed, BoundsSpace::Window));
    observed.evidence.ref_evidence.window_bounds = LocatorField::Known(bounds);
    observed.evidence.ref_evidence.bounds = LocatorField::Unknown;
    entry.geometry.bounds_space = Some(BoundsSpace::Screen);
    assert!(!evidence_complete(&query, &observed, BoundsSpace::Screen));
    assert!(!anchor_matches(&entry, &observed, false));
}

#[test]
fn a_positional_retained_object_is_not_hydration_identity() {
    let mut observed = evidence("textfield", None);
    observed.identifiers = observed.identifiers.with_retained_object("host:1".into());
    let observed = node(0, observed, vec![], &[]);
    let tree = tree(vec![observed.clone()], vec![0], true);
    let entry =
        super::super::materialize::ref_entry(&observed, &tree.source, &LocatorQuery::default());
    assert!(!anchor_matches(&entry, &observed, false));
    let mut replacement = observed;
    replacement.evidence.identifiers = crate::IdentifierEvidence::absent();
    assert!(!anchor_matches(&entry, &replacement, false));
    replacement.evidence.identifiers =
        crate::IdentifierEvidence::absent().with_retained_object("host:2".into());
    assert!(!anchor_matches(&entry, &replacement, false));
}
