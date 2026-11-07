//! The bounded sibling enumeration and child-index path descent the locator
//! anchor drives.
//!
//! Both primitives are the same two cross-process calls - one `first_child`
//! followed by a `next_sibling` chain - under the same sibling cap and the
//! same deadline, and the loop is written once.
//!
//! The loop consults the deadline on every iteration, mirroring the element
//! walk's own enumeration (`walker_enumerate.rs`). Checking it only around the
//! enumeration would let a pathological list run the whole sibling cap - up to
//! `WalkBudget::max_siblings` cross-process calls - after the budget was
//! already spent.

use agent_desktop_core::AdapterError;

use crate::tree::automation::{UiaFailure, uia_failure_error};
use crate::tree::walk::walker::{TreeSource, WalkBudget};

/// What a failed enumeration step means to the resolver that asked for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DescentVerdict {
    /// The node enumerates nothing further and that is a real answer: keep
    /// what was collected, and the list still counts as whole.
    Settled,
    /// The failure is the attempt's answer and propagates as an error.
    Surfaced,
}

/// The decision that differs per enumeration axis, with the shape-only phrase
/// each axis reports a surfaced failure under.
pub(crate) struct DescentPolicy {
    pub(crate) classify: fn(UiaFailure) -> DescentVerdict,
    pub(crate) descend_context: &'static str,
    pub(crate) sibling_context: &'static str,
}

/// Enumerates one element's children, honouring the sibling cap as a hard
/// bound on pathological lists and the deadline as a bound on time.
///
/// `take` stops the loop after that many siblings: `None` enumerates the
/// whole list, while `descend_path` passes the wanted index plus one, so
/// reaching the wanted index costs index-plus-one cross-process calls however
/// long the list runs.
///
/// The cap is the other place this enumeration is not literal: a cap-hit
/// keeps the truncated list and answers it rather than erroring. That is
/// deliberate. The bound exists to make the loop total against a sibling
/// chain that never terminates - the ancestor cycle guard cannot see such a
/// chain, because it revisits no element on any root-to-node path - not to
/// clamp a large but finite list. Measured breadth is nowhere near it: the
/// widest node in the probe corpus sits in a virtualized Explorer file list
/// whose entire tree over `%WINDIR%\System32` is 196 nodes (A1-1), and a
/// WinForms `ListBox` exposes no items at all to a COM client (A17-2).
///
/// Surfacing the truncation would cost more honesty than it buys: the bound is
/// shared with the walk that issues refs in the first place, and
/// `walk_from_root` enumerates under the same `WalkBudget::max_siblings` and
/// refuses to present a cap-cut child list as whole, so no stored ref can name
/// an element past this point in its parent's sibling list. One oversized list
/// anywhere in a window would otherwise convert every correct settled miss in
/// that window into a retry loop that re-truncates identically on every
/// attempt and expires as `TIMEOUT`.
pub(crate) fn read_children<S: TreeSource>(
    source: &S,
    element: &S::Node,
    budget: &WalkBudget,
    policy: &DescentPolicy,
    take: Option<usize>,
) -> Result<Vec<S::Node>, AdapterError> {
    let limit = take
        .map(|take| take.min(budget.max_siblings))
        .unwrap_or(budget.max_siblings);
    let mut elements = Vec::new();
    let mut current = match source.first_child(element) {
        Ok(first) => first,
        Err(failure) if failure.is_exhaustion() => return Ok(elements),
        Err(failure) => return classified(failure, elements, policy, policy.descend_context),
    };
    loop {
        if elements.len() >= limit {
            break;
        }
        budget.deadline.ensure_remaining()?;
        elements.push(current.clone());
        if elements.len() >= limit {
            break;
        }
        match source.next_sibling(&current) {
            Ok(sibling) => current = sibling,
            Err(failure) if failure.is_exhaustion() => break,
            Err(failure) => return classified(failure, elements, policy, policy.sibling_context),
        }
    }
    Ok(elements)
}

/// Walks the stored child-index path from a root, O(depth) child reads.
///
/// Each level enumerates only to the wanted index plus one and stops: a path
/// step needs the one child it names, never the thousand siblings after it
/// (a ref to a subkey near the top of an expanded registry hive would
/// otherwise read all of the hive's thousands of subkeys first).
///
/// The landing is trustworthy on its own terms. [`read_children`] only ever
/// appends, and every exit it can take - the sibling cap, an expired deadline,
/// a failed read - breaks the loop rather than skipping an entry, so the list
/// it returns is always a *prefix* of the node's real child list. An index that
/// prefix reaches therefore names the same child the whole list would name at
/// that index, and this function descends only through indices the prefix
/// reached: a stored index past a truncation yields `None` and lands nowhere.
/// What that absence means belongs to the caller, not here. The index is taken
/// against the raw enumeration, the same space the walk that issued the ref
/// recorded its stored index in, so a walk that omitted a sibling from its own
/// output still leaves the stored index pointing at the child it named.
pub(crate) fn descend_path<S: TreeSource>(
    source: &S,
    root: &S::Node,
    path: &[usize],
    budget: &WalkBudget,
    policy: &DescentPolicy,
) -> Result<Option<S::Node>, AdapterError> {
    let mut current = root.clone();
    for &index in path {
        let read = read_children(
            source,
            &current,
            budget,
            policy,
            Some(index.saturating_add(1)),
        )?;
        let Some(child) = read.get(index) else {
            return Ok(None);
        };
        current = child.clone();
    }
    Ok(Some(current))
}

fn classified<N>(
    failure: UiaFailure,
    elements: Vec<N>,
    policy: &DescentPolicy,
    context: &str,
) -> Result<Vec<N>, AdapterError> {
    match (policy.classify)(failure) {
        DescentVerdict::Settled => Ok(elements),
        DescentVerdict::Surfaced => Err(uia_failure_error(failure, context)),
    }
}

#[cfg(test)]
#[path = "resolve_descent_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "resolve_landing_tests.rs"]
mod landing_tests;
