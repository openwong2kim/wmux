use agent_desktop_core::{
    AdapterError, EvidenceRequirements, IdentityMatch, LocatorField, NativeHandle, RefEntry,
};

use super::resolve_classify::classify_candidates;
use super::resolve_errors::identity_unknown as identity_unknown_error;
pub(in crate::tree) use super::resolve_errors::incomplete_traversal as incomplete_traversal_error;
use super::resolve_read_context::ResolveReadContext;
use crate::tree::AXElement;
use crate::tree::element_dedupe::push_unique;

/// Lands a tokenless anchor by its path inside the scoped roots. Only the role
/// of the landed element is checked here; core confirms its identity against
/// the full recorded predicate after the landing.
#[cfg(target_os = "macos")]
pub(in crate::tree) fn find_entry_by_path(
    roots: &[AXElement],
    entry: &RefEntry,
    read_context: &mut ResolveReadContext,
) -> Result<NativeHandle, AdapterError> {
    crate::tree::locator_deadline::remaining(read_context.deadline)?;
    let mut matches = Vec::new();
    let mut incomplete = None;
    for root in roots {
        crate::tree::locator_deadline::remaining(read_context.deadline)?;
        let Some(candidate) = element_at_path(root, &entry.scope.path, read_context)? else {
            continue;
        };
        match landed_role_match(&candidate, entry, read_context)? {
            IdentityMatch::Match => {
                push_unique(&mut matches, candidate);
            }
            IdentityMatch::Unknown => {
                incomplete.get_or_insert_with(|| identity_unknown_error(entry));
            }
            IdentityMatch::NoMatch => {}
        }
        if matches.len() > 1 {
            break;
        }
    }
    match incomplete {
        Some(error) if matches.len() < 2 => Err(error),
        _ => classify_candidates(matches, entry),
    }
}

#[cfg(target_os = "macos")]
fn element_at_path(
    root: &AXElement,
    path: &[usize],
    context: &mut ResolveReadContext,
) -> Result<Option<AXElement>, AdapterError> {
    walk_finite_path(root.clone(), path, |current, index| {
        crate::tree::locator_deadline::remaining(context.deadline)?;
        if !context.usage.claim_node() {
            context.stats.traversal.limits.node_hits += 1;
            return Err(incomplete_traversal_error("path_node_budget", 0));
        }
        context.stats.reads.counts.attribute_batches += 1;
        context.stats.reads.counts.attributes_requested += 1;
        let role = super::resolve_ax_read::read_string(&current, "AXRole", context.deadline)?;
        let mut read = crate::tree::query::child_read::read_child_at(
            &current,
            role.as_deref(),
            index,
            context.deadline,
        );
        record_path_child_read(&read, context);
        crate::tree::locator_deadline::remaining(context.deadline)?;
        if read.status.api_disabled {
            return Err(AdapterError::permission_denied());
        }
        if !read.complete {
            return Err(incomplete_traversal_error("path_children", 0));
        }
        context
            .usage
            .claim_edges(usize::from(!read.elements.is_empty()));
        Ok(read.elements.pop())
    })
}

pub(in crate::tree) fn walk_finite_path<T>(
    mut current: T,
    path: &[usize],
    mut read_child: impl FnMut(T, usize) -> Result<Option<T>, AdapterError>,
) -> Result<Option<T>, AdapterError> {
    for index in path {
        let Some(child) = read_child(current, *index)? else {
            return Ok(None);
        };
        current = child;
    }
    Ok(Some(current))
}

#[cfg(target_os = "macos")]
fn record_path_child_read(
    read: &crate::tree::query::child_read::ChildRead,
    context: &mut ResolveReadContext,
) {
    context.stats.reads.counts.child_reads += read.status.attempts;
    context.stats.reads.health.cannot_complete += read.status.health.cannot_complete;
    context.stats.reads.health.native_read_failures += read.status.health.native_read_failures;
    context.stats.reads.health.deadline_exhausted += read.status.health.deadline_exhausted;
    context.stats.traversal.limits.child_count_changes += u64::from(read.status.count_changed);
    context.stats.traversal.limits.child_hits += u64::from(read.status.cursor_stalled);
}

#[cfg(target_os = "macos")]
fn landed_role_match(
    element: &AXElement,
    entry: &RefEntry,
    context: &mut ResolveReadContext,
) -> Result<IdentityMatch, AdapterError> {
    let requirements = EvidenceRequirements {
        role: true,
        ..EvidenceRequirements::default()
    };
    let read = read_node(element, requirements, context)?;
    if read.invalid_element {
        return Ok(IdentityMatch::Unknown);
    }
    Ok(role_match(&read.evidence.role, &entry.identity.role))
}

fn role_match(role: &LocatorField<String>, expected: &str) -> IdentityMatch {
    match role.known() {
        Some(actual) if actual == expected => IdentityMatch::Match,
        Some(_) => IdentityMatch::NoMatch,
        None if role.is_unknown() => IdentityMatch::Unknown,
        None => IdentityMatch::NoMatch,
    }
}

#[cfg(target_os = "macos")]
fn read_node(
    element: &AXElement,
    requirements: EvidenceRequirements,
    context: &mut ResolveReadContext,
) -> Result<crate::tree::query::node_read::NodeRead, AdapterError> {
    if !context.usage.claim_node() {
        context.stats.traversal.limits.node_hits += 1;
        return Err(incomplete_traversal_error("node_budget", 0));
    }
    let child_plan =
        crate::tree::query::child_read_plan::ChildReadPlan::load(context.usage.child_capacity());
    let read = crate::tree::query::node_read::read_node(
        element,
        crate::tree::query::node_read_context::NodeReadContext {
            tree: &crate::tree::TreeBuildContext::empty(false),
            stats: &mut context.stats,
            usage: &mut context.usage,
            requirements,
            deadline: context.deadline,
            child_plan,
        },
    )?;
    context
        .usage
        .note_child_demand(read.child_read.total_count, &mut context.stats);
    context.usage.claim_edges(read.child_read.elements.len());
    Ok(read)
}

#[cfg(all(test, target_os = "macos"))]
#[path = "resolve_search_tests.rs"]
mod tests;
