use crate::AccessibilityNode;
use crate::refs::ref_alloc::is_ref_able;
use crate::refs::ref_identity::is_element_token;
use std::collections::HashSet;

/// Plans the boundary containers that anchor a skeleton, deepest first. A
/// boundary is covered by a ref-able node, or becomes an anchor when it can
/// hold a ref and carries identity evidence, only when `offered` accepts that
/// node; otherwise the uncovered boundary passes to the parent, so the nearest
/// accepted ancestor anchors it instead. Returns whether a boundary below
/// `node` is still uncovered.
pub(crate) fn plan_skeleton_anchors(
    node: &AccessibilityNode,
    path: &mut Vec<usize>,
    anchors: &mut HashSet<Vec<usize>>,
    offered: &dyn Fn(&AccessibilityNode, &[usize]) -> bool,
) -> bool {
    let mut uncovered_boundary = node.children_count.is_some();
    for (index, child) in node.children.iter().enumerate() {
        path.push(index);
        uncovered_boundary |= plan_skeleton_anchors(child, path, anchors, offered);
        path.pop();
    }
    if !uncovered_boundary {
        return false;
    }
    if can_receive_observed_ref(node) && is_ref_able(node) && offered(node, path.as_slice()) {
        return false;
    }
    if !path.is_empty()
        && can_receive_observed_ref(node)
        && carries_identity_evidence(node)
        && offered(node, path.as_slice())
    {
        anchors.insert(path.clone());
        return false;
    }
    true
}

/// Whether a boundary container carries anything a census could prove it by: an
/// element token, a recorded name, description or native identifier, or bounds.
/// Without one it is no drill target, so it earns neither a ref nor a census.
fn carries_identity_evidence(node: &AccessibilityNode) -> bool {
    carries_element_token(node)
        || has_meaningful_text(node.identity.name.as_deref())
        || has_meaningful_text(node.identity.description.as_deref())
        || node.identity.native_id.as_ref().is_some_and(|identifier| {
            identifier.kind != crate::IdentifierKind::Unknown && !identifier.value.trim().is_empty()
        })
        || node
            .presentation
            .bounds
            .and_then(|bounds| bounds.bounds_hash())
            .is_some()
}

fn has_meaningful_text(value: Option<&str>) -> bool {
    value.is_some_and(|text| !text.trim().is_empty())
}

pub(crate) fn carries_element_token(node: &AccessibilityNode) -> bool {
    node.identity
        .retained_object
        .as_deref()
        .is_some_and(is_element_token)
}

fn can_receive_observed_ref(node: &AccessibilityNode) -> bool {
    crate::Role::is_canonical(&node.role) && node.role != "unknown"
}
