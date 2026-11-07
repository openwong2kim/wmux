//! The stored-path landing family: the scope gate the locator anchor applies and
//! the bounded child enumeration it descends through (in `descent`).
//!
//! Identity is not judged here: the landing is re-checked by core's full
//! predicate (`agent_desktop_core::refs::resolve_saved_ref`), which owns
//! identity for every platform.

use agent_desktop_core::{Deadline, RefEntry};

use crate::tree::walk::walker::{DEFAULT_MAX_SIBLINGS, WalkBudget};

#[path = "resolve_descent.rs"]
pub(crate) mod descent;

/// The resolve-scoped depth cap.
///
/// Independently bounded from the walk's own ceiling, and at least as deep as
/// core's whole-window observation, so every node a capture can count is one
/// the anchor can land. Electron elements commonly sit at depth 25+, so the cap
/// is the resolution bound rather than the walk bound.
pub(crate) const MAX_RESOLVE_DEPTH: u8 = 50;

/// The budget a resolution attempt enumerates under.
///
/// The sibling bound is the observation walk's own `DEFAULT_MAX_SIBLINGS`
/// rather than a resolve-scoped number, and that is load-bearing rather than
/// incidental. `read_children` reports a cap-hit as a whole child list, so a
/// truncation here settles `STALE_REF` instead of retrying; that verdict is
/// only honest while the resolver reaches at least as far as the walk that
/// issued the ref, which presents no cap-cut list as whole and therefore
/// allocates no ref past its own bound. A lower bound here would convert
/// reachable refs into settled misses with nothing else refuting them.
pub(crate) fn resolve_walk_budget(deadline: Deadline) -> WalkBudget {
    WalkBudget::new(MAX_RESOLVE_DEPTH, deadline)
        .with_max_raw_depth(MAX_RESOLVE_DEPTH)
        .with_max_siblings(DEFAULT_MAX_SIBLINGS)
}

/// The incomplete-and-retryable answer: a candidate that could not be read is
/// not a non-match. Core owns the payload
/// (`agent_desktop_core::refs::resolve_errors::identity_unknown_error`) because it
/// is byte-identical to macOS's `identity_unknown` - a `complete: false,
/// retryable: true` stamp so the caller's loop retries it.
pub(crate) use agent_desktop_core::refs::resolve_errors::identity_unknown_error;

/// Whether the stored path is scoped to the window root rather than to a
/// drill-down ancestor: no `root_ref` at all, or an absolute path that
/// overrides one. The anchor descends from the window's own root, so a path
/// relative to some other node is not one it can walk.
pub(crate) fn window_rooted(entry: &RefEntry) -> bool {
    entry.scope.root_ref.is_none() || entry.scope.path_is_absolute
}

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_search_tests.rs"]
mod tests;
