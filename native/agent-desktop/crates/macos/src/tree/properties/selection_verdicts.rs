use crate::tree::AXElement;

const CAPACITY: usize = 8;

/// Selection-owner verdicts read during one observation, so the rows and
/// cells of one container reuse its answer instead of probing it again.
/// `None` records that an element owns no settable selection and
/// `Some(enabled)` that it does. Dropped with the observation that read them.
#[derive(Default)]
pub(crate) struct SelectionVerdicts {
    entries: Vec<(AXElement, Option<bool>)>,
}

impl SelectionVerdicts {
    /// The verdict recorded for `element`, marked as most recently used.
    pub(crate) fn get(&mut self, element: &AXElement) -> Option<Option<bool>> {
        let index = self
            .entries
            .iter()
            .position(|(seen, _)| crate::tree::same_element(seen, element))?;
        let entry = self.entries.remove(index);
        let verdict = entry.1;
        self.entries.push(entry);
        Some(verdict)
    }

    /// Records a verdict, evicting the least recently used one when full.
    pub(crate) fn insert(&mut self, element: AXElement, verdict: Option<bool>) {
        if self.entries.len() >= CAPACITY {
            self.entries.remove(0);
        }
        self.entries.push((element, verdict));
    }
}
