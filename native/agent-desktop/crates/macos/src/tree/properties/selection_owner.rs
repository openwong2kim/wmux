use super::action_list::{AvailableActionsRead, read_settable, record_error};
use super::selection_verdicts::SelectionVerdicts;
use crate::tree::AXElement;
use crate::tree::properties::attributes::{copy_bool_attr_result, copy_element_attr_result};

pub(crate) const MAX_SELECTION_OWNER_DEPTH: usize = 2;

/// `Some(enabled)` when an ancestor of `el` within the depth bound lets its
/// selection be written, so a row with no press action of its own can still be
/// chosen; such a member is a list item, not a control, so its own `AXEnabled`
/// says nothing about whether it can be chosen. A failed read leaves `read`
/// incomplete and caches nothing, so an unknown is never taken for an answer.
pub(super) fn container_selection(
    el: &AXElement,
    deadline: std::time::Instant,
    read: &mut AvailableActionsRead,
    verdicts: &mut SelectionVerdicts,
) -> Option<bool> {
    if !read.complete {
        return None;
    }
    let mut current = el.clone();
    for _ in 0..MAX_SELECTION_OWNER_DEPTH {
        current = parent_of(&current, deadline, read)?;
        let verdict = verdicts.get(&current).unwrap_or_else(|| {
            let verdict = own_selection(&current, deadline, read);
            if read.complete {
                verdicts.insert(current.clone(), verdict);
            }
            verdict
        });
        if !read.complete {
            return None;
        }
        if verdict.is_some() {
            return verdict;
        }
    }
    None
}

/// True when writing the container's selection is the only way to choose `el`,
/// so a press on anything inside it would act on something else. A read that
/// cannot complete counts as true, so an unknown never authorizes the press.
pub(crate) fn selects_only_through_container(el: &AXElement, deadline: std::time::Instant) -> bool {
    let mut read = AvailableActionsRead::default();
    let own = crate::actions::select::container_select::SELECTED;
    if read_settable(el, own, deadline, &mut read).unwrap_or(false) {
        return false;
    }
    let verdict = container_selection(el, deadline, &mut read, &mut SelectionVerdicts::default());
    verdict == Some(true) || !read.complete
}

/// `Some(enabled)` when `element` lets its selection be written, `None` when
/// it does not.
fn own_selection(
    element: &AXElement,
    deadline: std::time::Instant,
    read: &mut AvailableActionsRead,
) -> Option<bool> {
    let owns = crate::actions::select::container_select::SELECTION_ATTRIBUTES
        .iter()
        .any(|attr| read_settable(element, attr, deadline, read).unwrap_or(false));
    if !owns {
        return None;
    }
    match copy_bool_attr_result(element, "AXEnabled", deadline) {
        Ok(enabled) => Some(enabled != Some(false)),
        Err(error) => {
            record_error(read, error);
            None
        }
    }
}

fn parent_of(
    element: &AXElement,
    deadline: std::time::Instant,
    read: &mut AvailableActionsRead,
) -> Option<AXElement> {
    copy_element_attr_result(element, "AXParent", deadline)
        .map_err(|error| record_error(read, error))
        .ok()
        .flatten()
}
