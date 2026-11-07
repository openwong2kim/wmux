use super::role_match;
use agent_desktop_core::{IdentityMatch, LocatorField};

#[test]
fn only_a_known_role_equal_to_the_saved_role_matches() {
    assert_eq!(
        role_match(&LocatorField::Known("cell".into()), "cell"),
        IdentityMatch::Match
    );
    assert_eq!(
        role_match(&LocatorField::Known("row".into()), "cell"),
        IdentityMatch::NoMatch
    );
}

#[test]
fn an_unreadable_role_is_unknown_and_an_absent_role_is_a_mismatch() {
    assert_eq!(
        role_match(&LocatorField::Unknown, "cell"),
        IdentityMatch::Unknown
    );
    assert_eq!(
        role_match(&LocatorField::Absent, "cell"),
        IdentityMatch::NoMatch
    );
}
