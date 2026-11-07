use super::*;
use crate::system::runtime::hresult::ReadDisposition;
use crate::tree::automation::{
    ERR_INVALID_ARG, ERR_INVALID_OBJECT, ERR_NONE, ERR_NULL_PTR, ERR_TIMEOUT,
    uia_failure_disposition,
};
use crate::tree::name_evidence::LabelOutcome;
use crate::tree::properties::ElementProperties;
use crate::tree::resolve::resolve_anchor::ANCHOR_DESCENT;
use crate::tree::resolve::resolve_search;
use crate::tree::walk::walker::{NodeKey, walk_vocabulary};
use agent_desktop_core::{Deadline, ErrorCode, LocatorEvidence};

/// An enumerator whose fault carries a caller-chosen [`UiaFailure`], so every
/// read disposition can be driven end to end through the shared loop under
/// each resolver's own policy, rather than asserted on a classifier in
/// isolation - nodes are their own indices, root `0` and children `1..=n`,
/// and a sibling fault is `(after, failure)`, firing once `node >= after` so
/// `failing_on_siblings`/`faulting_after` differ only in threshold.
pub(crate) struct StubTree {
    child_count: usize,
    first_child_failure: Option<UiaFailure>,
    sibling_fault: Option<(usize, UiaFailure)>,
}

impl StubTree {
    pub(crate) fn with_children(child_count: usize) -> Self {
        Self {
            child_count,
            first_child_failure: None,
            sibling_fault: None,
        }
    }

    pub(crate) fn failing_to_descend(mut self, failure: UiaFailure) -> Self {
        self.first_child_failure = Some(failure);
        self
    }

    pub(crate) fn failing_on_siblings(mut self, failure: UiaFailure) -> Self {
        self.sibling_fault = Some((0, failure));
        self
    }

    /// Faults with `ERR_TIMEOUT` once `read_siblings` have read cleanly.
    pub(crate) fn faulting_after(mut self, read_siblings: usize) -> Self {
        self.sibling_fault = Some((read_siblings, UiaFailure::Sentinel(ERR_TIMEOUT)));
        self
    }
}

impl TreeSource for StubTree {
    type Node = usize;

    fn first_child(&self, node: &usize) -> Result<usize, UiaFailure> {
        if let Some(failure) = self.first_child_failure {
            return Err(failure);
        }
        if *node == 0 && self.child_count > 0 {
            Ok(1)
        } else {
            Err(UiaFailure::Sentinel(ERR_NONE))
        }
    }

    fn next_sibling(&self, node: &usize) -> Result<usize, UiaFailure> {
        if let Some((_, failure)) = self.sibling_fault.filter(|(after, _)| *node >= *after) {
            return Err(failure);
        }
        if *node < self.child_count {
            Ok(node + 1)
        } else {
            Err(UiaFailure::Sentinel(ERR_NONE))
        }
    }

    fn identity(&self, node: &usize) -> NodeKey {
        NodeKey::Runtime(vec![i32::try_from(*node).unwrap_or_default()])
    }

    fn same_element(&self, left: &usize, right: &usize) -> bool {
        left == right
    }

    fn evidence(&self, _node: &usize) -> (ElementProperties, LocatorEvidence, u64) {
        let properties = ElementProperties::from_reads(Vec::new());
        let vocabulary = walk_vocabulary(&properties, &LabelOutcome::Unlabelled);
        (
            properties.clone(),
            properties.locator_evidence(vocabulary),
            0,
        )
    }

    fn is_web_wrapper(&self, _node: &usize, _properties: &ElementProperties) -> bool {
        false
    }
}

fn live_budget() -> WalkBudget {
    WalkBudget::new(10, Deadline::standard().expect("a standard deadline"))
}

fn expired_budget() -> WalkBudget {
    let deadline = Deadline::standard()
        .expect("a standard deadline")
        .capped(std::time::Duration::ZERO);
    assert!(
        deadline.is_expired(),
        "a zero-length cap must produce an already-expired deadline"
    );
    WalkBudget::new(10, deadline)
}

/// The control for the expiry pins below: with time left the enumeration
/// reads the whole sibling list, so an expiry assertion below can only be
/// produced by the deadline check itself.
#[test]
fn a_live_deadline_enumerates_the_whole_sibling_list() {
    let tree = StubTree::with_children(3);
    let read = read_children(&tree, &0, &live_budget(), &ANCHOR_DESCENT, None)
        .expect("an unfaulting enumeration succeeds");
    assert_eq!(read, vec![1, 2, 3]);
}

/// The anchor's expiry policy: it settles in one attempt, so an expired
/// deadline must surface as the timeout it is. A partial list would land short
/// of the stored index and settle `STALE_REF` - reporting the element as
/// genuinely gone when the truth is only that time ran out.
#[test]
fn an_expired_deadline_surfaces_a_timeout_for_the_anchor_never_a_settled_miss() {
    let tree = StubTree::with_children(10);
    let error = match read_children(&tree, &0, &expired_budget(), &ANCHOR_DESCENT, None) {
        Err(error) => error,
        Ok(read) => panic!(
            "an expired anchor enumeration must surface, it yielded {} children",
            read.len()
        ),
    };
    assert_eq!(error.code, ErrorCode::Timeout);
}

/// The same policy one level up: a path walk whose enumeration runs out of
/// time must not answer "no such child". `descend_path` returning `None` is
/// the anchor's settled-miss signal, and a starved read is not a miss.
#[test]
fn an_expired_deadline_never_lands_the_anchor_path_nowhere() {
    let tree = StubTree::with_children(3);
    let error = match descend_path(&tree, &0, &[0], &expired_budget(), &ANCHOR_DESCENT) {
        Err(error) => error,
        Ok(landing) => panic!(
            "a starved path walk must surface, it landed on {:?}",
            landing
        ),
    };
    assert_eq!(error.code, ErrorCode::Timeout);
}

/// A node that vanished mid-descent is the anchor's settled answer: it walks
/// one exact path that churn makes permanently wrong, so the absence is what
/// it reports rather than a gap it keeps looking past.
#[test]
fn a_vanished_node_settles_the_anchor() {
    let vanished = UiaFailure::Sentinel(ERR_INVALID_OBJECT);
    assert_eq!(
        uia_failure_disposition(vanished),
        ReadDisposition::Unavailable,
        "this pin drives the vanished-node arm and needs that disposition"
    );
    let tree = StubTree::with_children(3).failing_on_siblings(vanished);

    let anchored = read_children(&tree, &0, &live_budget(), &ANCHOR_DESCENT, None)
        .expect("a vanished sibling never surfaces for the anchor");
    assert_eq!(anchored, vec![1]);
}

/// Transport propagates for the anchor so its bounded retry loop replays the
/// cheap path walk rather than swallowing the fault.
#[test]
fn a_transport_failure_surfaces_for_the_anchor() {
    let transport = UiaFailure::Sentinel(ERR_TIMEOUT);
    assert_eq!(
        uia_failure_disposition(transport),
        ReadDisposition::Retryable,
        "this pin drives the transport arm and needs that disposition"
    );
    let tree = StubTree::with_children(3).failing_on_siblings(transport);

    let error = match read_children(&tree, &0, &live_budget(), &ANCHOR_DESCENT, None) {
        Err(error) => error,
        Ok(_) => panic!("a transport failure must surface for the anchor, not settle"),
    };
    assert!(error.is_explicitly_retryable());
}

/// A settled absence means the provider said the enumeration cannot exist, so
/// the empty list is real and the anchor has nothing left to retry for.
#[test]
fn a_settled_absence_ends_the_enumeration_whole() {
    let absent = UiaFailure::Sentinel(ERR_INVALID_ARG);
    assert_eq!(
        uia_failure_disposition(absent),
        ReadDisposition::SettledAbsence,
        "this pin drives the settled-absence arm and needs that disposition"
    );
    let tree = StubTree::with_children(3).failing_to_descend(absent);

    let read = read_children(&tree, &0, &live_budget(), &ANCHOR_DESCENT, None)
        .expect("a settled absence never surfaces");
    assert!(read.is_empty());
}

/// A terminal failure has no defined recovery, so the anchor may not present
/// a truncated list as an answer.
#[test]
fn a_terminal_failure_surfaces() {
    let terminal = UiaFailure::Sentinel(ERR_NULL_PTR);
    assert_eq!(
        uia_failure_disposition(terminal),
        ReadDisposition::Terminal,
        "this pin drives the terminal arm and needs that disposition"
    );
    let tree = StubTree::with_children(3).failing_to_descend(terminal);

    let error = match read_children(&tree, &0, &live_budget(), &ANCHOR_DESCENT, None) {
        Err(error) => error,
        Ok(_) => panic!("a terminal failure must surface, never yield a child list"),
    };
    assert!(!error.is_explicitly_retryable());
}

/// The sibling cap truncates the list and answers it rather than erroring. A
/// stored index past the cap therefore lands nowhere - the anchor's
/// settled-miss signal - rather than surfacing a read failure the retry loop
/// would replay to the same truncation. Changing it decides the whole
/// resolution contract for an oversized list and must never be an incidental
/// edit.
#[test]
fn the_sibling_cap_truncates_and_reports_the_truncated_list_as_whole() {
    let tree = StubTree::with_children(12);
    let capped = live_budget().with_max_siblings(4);
    let read = read_children(&tree, &0, &capped, &ANCHOR_DESCENT, None)
        .expect("a cap-hit never surfaces as an error");
    assert_eq!(
        read,
        vec![1, 2, 3, 4],
        "the cap bounds the list at exactly its own value"
    );
}

/// The bound every resolver enumerates under is at least the bound the walk
/// that issued the ref enumerated under. This is what makes the settled
/// verdict above honest rather than merely convenient: the walk presents no
/// cap-cut child list as whole and so allocates no ref past its own bound, and
/// a resolver reaching at least as far can never truncate away an element a
/// stored ref legitimately names. The observation walk never overrides the
/// default, so `WalkBudget::new` is the bound refs are issued under.
#[test]
fn every_resolver_enumerates_at_least_as_far_as_the_walk_that_issued_the_ref() {
    let deadline = Deadline::standard().expect("a standard deadline");
    let issuing_walk = WalkBudget::new(10, deadline).max_siblings;

    assert!(
        resolve_search::resolve_walk_budget(deadline).max_siblings >= issuing_walk,
        "a resolver bounded tighter than the walk would settle STALE_REF on refs the walk \
         legitimately issued"
    );
}

/// The anchor's reading of the same truncation, one level up. A stored index
/// past the cap lands nowhere, and `descend_path` reports that as a `None`
/// landing - the anchor's settled-miss signal. So the cap-hit settles the
/// anchor in one attempt instead of replaying a path walk that would truncate
/// at the same place.
#[test]
fn a_stored_index_past_the_sibling_cap_settles_the_anchor_rather_than_retrying() {
    let tree = StubTree::with_children(12);
    let capped = live_budget().with_max_siblings(4);

    let landing = descend_path(&tree, &0, &[6], &capped, &ANCHOR_DESCENT)
        .expect("a cap-hit never surfaces for the anchor");

    assert!(
        landing.is_none(),
        "an index the truncated list does not reach lands nowhere"
    );
}

/// The shape-only phrase both enumeration axes report under belongs to the
/// policy, not to the shared loop: the anchor descends one exact path, so
/// descent and sibling walk are the same act to a reader of the error.
#[test]
fn the_anchor_keeps_one_axis_wording() {
    let terminal = UiaFailure::Sentinel(ERR_NULL_PTR);
    let descend = StubTree::with_children(3).failing_to_descend(terminal);
    let siblings = StubTree::with_children(3).failing_on_siblings(terminal);

    let anchor_descend = read_children(&descend, &0, &live_budget(), &ANCHOR_DESCENT, None)
        .expect_err("a terminal descent surfaces");
    let anchor_sibling = read_children(&siblings, &0, &live_budget(), &ANCHOR_DESCENT, None)
        .expect_err("a terminal sibling walk surfaces");
    assert_eq!(anchor_descend.message, anchor_sibling.message);
}
