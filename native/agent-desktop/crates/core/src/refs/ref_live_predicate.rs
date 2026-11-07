use crate::{
    ElementIdentifier,
    locator::live_locator::{LocatorEvidence, LocatorField},
    refs::ref_identity::{meaningful_field, stable_name_field},
};

/// What a live element reports for the fields a predicate records, with the
/// identifier read's completeness kept so an unread field answers `Unknown`.
pub(crate) struct LivePredicate<'a> {
    pub(crate) role: LocatorField<&'a str>,
    pub(crate) name: LocatorField<&'a str>,
    pub(crate) value: LocatorField<&'a str>,
    pub(crate) description: LocatorField<&'a str>,
    pub(crate) native_ids: &'a [ElementIdentifier],
    pub(crate) native_ids_complete: bool,
}

impl<'a> LivePredicate<'a> {
    pub(crate) fn observed(evidence: &'a LocatorEvidence) -> Self {
        Self {
            role: meaningful_field(&evidence.role),
            name: meaningful_field(&evidence.name),
            value: meaningful_field(&evidence.value),
            description: meaningful_field(&evidence.description),
            native_ids: evidence.identifiers.identifiers(),
            native_ids_complete: evidence.identifiers.is_complete(),
        }
    }

    /// The stable name a predicate carrying `role` compares this element by.
    pub(crate) fn stable_name(&self, role: &str) -> LocatorField<&str> {
        stable_name_field(role, &self.name, &self.value)
    }
}
