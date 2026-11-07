use crate::{
    ElementIdentifier, IdentityMatch, RefEntry,
    locator::live_locator::LocatorField,
    refs::ref_identity::{equality_match, meaningful_field, stable_name, stable_name_field},
    refs::ref_live_predicate::LivePredicate,
    tree::accname::non_blank,
};

pub(crate) const NATIVE_ID: u8 = 0b001;
pub(crate) const NAME: u8 = 0b010;
pub(crate) const DESCRIPTION: u8 = 0b100;

/// The identity fields capture and resolution both compare: role plus whichever
/// of native identifier, stable name and description an element records.
/// Mutable values and bounds are never identity.
#[derive(Clone, Copy)]
pub(crate) struct FullPredicate<'a> {
    pub(crate) role: &'a str,
    pub(crate) native_id: Option<&'a ElementIdentifier>,
    pub(crate) name: Option<&'a str>,
    pub(crate) description: Option<&'a str>,
    mask: u8,
}

impl<'a> FullPredicate<'a> {
    pub(crate) fn of_entry(entry: &'a RefEntry) -> Self {
        Self::of_fields(
            &entry.identity.role,
            entry.identity.name.as_deref(),
            entry.identity.value.as_deref(),
            entry.identity.description.as_deref(),
            entry.identity.native_id.as_ref(),
        )
    }

    fn of_fields(
        role: &'a str,
        name: Option<&'a str>,
        value: Option<&'a str>,
        description: Option<&'a str>,
        native_id: Option<&'a ElementIdentifier>,
    ) -> Self {
        Self {
            role,
            native_id: native_id.filter(|identifier| !identifier.value.trim().is_empty()),
            name: stable_name(role, name, value),
            description: non_blank(description),
            mask: 0,
        }
        .recorded()
    }

    /// The one rule capture and resolution apply: every field the predicate
    /// records must equal the live element's, and a field the live read could
    /// not answer is unknown instead of matching.
    pub(crate) fn compare(&self, live: &LivePredicate<'_>) -> IdentityMatch {
        [
            field_match(Some(self.role), &live.role),
            self.native_id_match(live),
            field_match(
                self.name,
                &stable_name_field(self.role, &live.name, &live.value),
            ),
            field_match(self.description, &meaningful_field(&live.description)),
        ]
        .into_iter()
        .fold(IdentityMatch::Match, conjunction)
    }

    fn native_id_match(&self, live: &LivePredicate<'_>) -> IdentityMatch {
        let Some(recorded) = self.native_id else {
            return IdentityMatch::Match;
        };
        if live.native_ids.contains(recorded) {
            IdentityMatch::Match
        } else if live.native_ids_complete {
            IdentityMatch::NoMatch
        } else {
            IdentityMatch::Unknown
        }
    }

    /// The fields this predicate records, which is the field subset a capture
    /// proof counts this predicate against.
    pub(crate) fn mask(&self) -> u8 {
        self.mask
    }

    fn recorded(mut self) -> Self {
        self.mask = bit(self.native_id.is_some(), NATIVE_ID)
            | bit(self.name.is_some(), NAME)
            | bit(self.description.is_some(), DESCRIPTION);
        self
    }
}

fn bit(recorded: bool, field: u8) -> u8 {
    if recorded { field } else { 0 }
}

fn field_match(expected: Option<&str>, actual: &LocatorField<&str>) -> IdentityMatch {
    match expected {
        Some(expected) => match actual {
            LocatorField::Known(actual) => equality_match(expected, actual),
            LocatorField::Absent => IdentityMatch::NoMatch,
            LocatorField::Unknown => IdentityMatch::Unknown,
        },
        None => IdentityMatch::Match,
    }
}

fn conjunction(left: IdentityMatch, right: IdentityMatch) -> IdentityMatch {
    match (left, right) {
        (IdentityMatch::NoMatch, _) | (_, IdentityMatch::NoMatch) => IdentityMatch::NoMatch,
        (IdentityMatch::Unknown, _) | (_, IdentityMatch::Unknown) => IdentityMatch::Unknown,
        _ => IdentityMatch::Match,
    }
}
