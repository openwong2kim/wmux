use crate::refs::RefPath;

use super::{LocatorEvidence, ObservationCompleteness};

#[derive(Debug, Clone)]
pub struct ObservedNode {
    pub(crate) evidence: LocatorEvidence,
    pub(crate) path: RefPath,
    pub(crate) children: Vec<u32>,
    pub(crate) document_order: u32,
    pub(crate) completeness: ObservationCompleteness,
    pub(crate) children_count: Option<u32>,
    pub(crate) ref_id: Option<String>,
}

impl ObservedNode {
    /// A container whose descendants were not read cannot support any verdict
    /// about the elements it might hide.
    pub(crate) fn omits_descendants(&self) -> bool {
        !self.completeness.subtree_complete
            || (self.children_count.is_some_and(|count| count > 0) && self.children.is_empty())
    }
}
