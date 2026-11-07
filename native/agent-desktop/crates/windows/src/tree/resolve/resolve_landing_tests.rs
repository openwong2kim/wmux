//! The property every stored-path landing rests on, and what reaching one
//! costs.
//!
//! `read_children` only ever appends, and each of its exits breaks the loop
//! rather than skipping an entry, so a truncated enumeration is a *prefix* of
//! the real child list. `descend_path` applies that one level at a time, so an
//! index the prefix reaches names the same child the whole list would name
//! there - and reaching it costs only the reads up to that index.

use super::*;
use crate::tree::resolve::resolve_anchor::ANCHOR_DESCENT;
use crate::tree::walk::walker::TreeSource;
use agent_desktop_core::Deadline;

use super::tests::StubTree;

fn budget() -> WalkBudget {
    WalkBudget::new(10, Deadline::standard().expect("a standard deadline"))
}

/// The lemma the anchor trusts its landing on: what a truncation removes is a
/// suffix, so every index below it still names the child a whole walk would
/// name there. A mid-list gap - the one shape that would make a landing a
/// guess - is unconstructible, because the enumeration has no way to skip an
/// entry and carry on.
///
/// A take stop is a truncation the walk chose: indices below it land on the
/// same child a whole walk names, and a fault past it is masked - the walk
/// never got there.
#[test]
fn an_index_a_truncated_walk_reaches_names_the_child_a_whole_walk_names() {
    let short = StubTree::with_children(6).faulting_after(3);
    let whole = StubTree::with_children(6);

    for index in 0..2 {
        let landing = descend_path(&short, &0, &[index], &budget(), &ANCHOR_DESCENT)
            .expect("a fault past the take stop never surfaces");
        let control = descend_path(&whole, &0, &[index], &budget(), &ANCHOR_DESCENT)
            .expect("an unfaulting walk answers");

        assert_eq!(
            landing, control,
            "index {index} sits below the take stop, so the short walk must land on the same \
             child the whole walk lands on"
        );
    }
}

/// A take-hit keeps the truncated prefix and answers it, like a cap-hit:
/// every index the prefix reaches names the same child the whole list names
/// there.
#[test]
fn take_reports_a_truncated_prefix_whole() {
    let tree = StubTree::with_children(100);

    let read = read_children(&tree, &0, &budget(), &ANCHOR_DESCENT, Some(2))
        .expect("a bounded prefix answers");

    assert_eq!(read.len(), 2);
}

/// An index past the end still lands nowhere, take or no take: exhaustion is
/// a complete answer about a list that simply ends.
#[test]
fn a_miss_past_the_end_still_lands_nowhere() {
    let tree = StubTree::with_children(3);

    let landing =
        descend_path(&tree, &0, &[5], &budget(), &ANCHOR_DESCENT).expect("exhaustion answers");

    assert!(landing.is_none());
}

struct Counting<'a> {
    inner: &'a StubTree,
    calls: std::cell::Cell<usize>,
}

impl<'a> Counting<'a> {
    fn over(inner: &'a StubTree) -> Self {
        Self {
            inner,
            calls: std::cell::Cell::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.get()
    }
}

impl TreeSource for Counting<'_> {
    type Node = usize;

    fn first_child(&self, node: &usize) -> Result<usize, UiaFailure> {
        self.calls.set(self.calls.get() + 1);
        self.inner.first_child(node)
    }

    fn next_sibling(&self, node: &usize) -> Result<usize, UiaFailure> {
        self.calls.set(self.calls.get() + 1);
        self.inner.next_sibling(node)
    }

    fn identity(&self, node: &usize) -> crate::tree::walk::walker::NodeKey {
        self.inner.identity(node)
    }

    fn same_element(&self, left: &usize, right: &usize) -> bool {
        self.inner.same_element(left, right)
    }

    fn evidence(
        &self,
        node: &usize,
    ) -> (
        crate::tree::properties::ElementProperties,
        agent_desktop_core::LocatorEvidence,
        u64,
    ) {
        self.inner.evidence(node)
    }

    fn is_web_wrapper(
        &self,
        node: &usize,
        properties: &crate::tree::properties::ElementProperties,
    ) -> bool {
        self.inner.is_web_wrapper(node, properties)
    }
}

/// A path step needs the one child it names, never the siblings after it:
/// reaching index zero on a hundred-wide list costs one cross-process call,
/// where the whole-list walk costs a hundred and one.
#[test]
fn descend_path_reaches_index_zero_with_a_single_call() {
    let tree = StubTree::with_children(100);
    let counting = Counting::over(&tree);

    let landing = descend_path(&counting, &0, &[0], &budget(), &ANCHOR_DESCENT)
        .expect("a whole prefix answers");

    assert_eq!(landing, Some(1));
    assert_eq!(counting.calls(), 1);
}

/// The same bound mid-list: index fifty costs fifty-one calls, and the
/// landing is the child the whole walk names there.
#[test]
fn descend_path_costs_index_plus_one_calls_mid_list() {
    let tree = StubTree::with_children(100);
    let counting = Counting::over(&tree);

    let landing = descend_path(&counting, &0, &[50], &budget(), &ANCHOR_DESCENT)
        .expect("a whole prefix answers");

    assert_eq!(landing, Some(51));
    assert_eq!(counting.calls(), 51);
}
