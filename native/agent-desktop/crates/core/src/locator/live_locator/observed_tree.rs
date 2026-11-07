use serde_json::json;

use crate::{AccessibilityNode, AdapterError, ErrorCode, refs::RefPath};

use super::{LocatorStats, ObservationSource, ObservedNode, ObservedSubtree};

#[derive(Debug, Clone)]
pub struct ObservedTree {
    pub(crate) nodes: Vec<ObservedNode>,
    pub(crate) roots: Vec<u32>,
    pub(crate) source: ObservationSource,
    pub(crate) stats: LocatorStats,
    pub(crate) structurally_complete: bool,
    pub(crate) logical_depths: Vec<u8>,
}

impl ObservedTree {
    pub fn from_roots(
        roots: Vec<ObservedSubtree>,
        source: ObservationSource,
        stats: LocatorStats,
        structurally_complete: bool,
    ) -> Result<Self, AdapterError> {
        if roots.is_empty() {
            return Err(AdapterError::internal("observation contains no roots"));
        }
        let mut tree = Self {
            nodes: Vec::new(),
            roots: Vec::new(),
            source,
            stats,
            structurally_complete,
            logical_depths: Vec::new(),
        };
        for root in roots {
            let index = tree.append(root, RefPath::new(), 0)?;
            tree.roots.push(index);
        }
        tree.structurally_complete &= tree
            .roots
            .iter()
            .all(|root| tree.nodes[*root as usize].completeness.subtree_complete);
        Ok(tree)
    }

    pub fn is_complete(&self) -> bool {
        self.structurally_complete
    }

    /// Whether this observation read the whole window: complete, and with no
    /// container whose descendants it left unread. A capture proof and a
    /// tokenless resolution both rest on it, because both count evidence over
    /// every node the window holds.
    pub(crate) fn is_exhaustive(&self) -> bool {
        self.structurally_complete && !self.nodes.iter().any(ObservedNode::omits_descendants)
    }

    pub fn into_accessibility_tree(mut self) -> Result<AccessibilityNode, AdapterError> {
        if !self.structurally_complete {
            return Err(AdapterError::new(
                ErrorCode::Timeout,
                "Accessibility observation was incomplete",
            )
            .with_suggestion("Retry with a larger timeout or a narrower tree depth")
            .with_details(json!({
                "kind": "observation_incomplete",
                "nodes_observed": self.nodes.len(),
                "query_stats": self.stats,
            })));
        }
        if self.roots.len() != 1 {
            return Err(AdapterError::internal(
                "accessibility projection requires exactly one root",
            ));
        }
        self.project(self.roots[0] as usize)
    }

    /// Projects whatever was observed and reports its completeness, rather than
    /// discarding an entire walk because the budget expired before the last
    /// node. Callers that need an all-or-nothing tree keep using
    /// `into_accessibility_tree`. The observation layer already annotates each
    /// truncated container with `children_count`, so a partial tree stays
    /// honest about its own boundaries.
    pub fn into_accessibility_tree_partial(
        mut self,
    ) -> Result<(AccessibilityNode, bool, usize), AdapterError> {
        self.project_partial()
    }

    /// `into_accessibility_tree_partial` for a caller that still needs the
    /// observation it projected, such as the capture proof behind every ref the
    /// presentation allocates.
    pub(crate) fn project_partial(
        &mut self,
    ) -> Result<(AccessibilityNode, bool, usize), AdapterError> {
        if self.roots.len() != 1 {
            return Err(AdapterError::internal(
                "accessibility projection requires exactly one root",
            ));
        }
        let complete = self.structurally_complete;
        let nodes_observed = self.nodes.len();
        let tree = self.project(self.roots[0] as usize)?;
        Ok((tree, complete, nodes_observed))
    }

    /// Projects the window cut at `max_logical_depth` the way a walk applies
    /// its own limit: a container whose children would sit below the limit
    /// keeps none, carries their count and stays complete, so it still anchors
    /// a skeleton. Every presented node is the node this observation holds, so a
    /// capture proof taken over the whole observation describes it exactly.
    pub(crate) fn project_window(
        &mut self,
        max_logical_depth: u8,
    ) -> Result<(AccessibilityNode, bool, usize), AdapterError> {
        if self.roots.len() != 1 {
            return Err(AdapterError::internal(
                "accessibility projection requires exactly one root",
            ));
        }
        let complete = self.structurally_complete;
        let nodes_observed = self.nodes.len();
        let depths = std::mem::take(&mut self.logical_depths);
        let tree = self.project_shallow(self.roots[0] as usize, &depths, max_logical_depth)?;
        Ok((tree, complete, nodes_observed))
    }

    /// Projects the subtree rooted at an observed node, cut the same way.
    ///
    /// The matched node is the subtree's depth zero, as it is for a walk that
    /// starts at an element, so the requested limit counts from there rather
    /// than from the window the node happened to sit deep inside.
    pub(crate) fn project_subtree(
        &mut self,
        index: usize,
        max_logical_depth: u8,
    ) -> Result<AccessibilityNode, AdapterError> {
        let depths = std::mem::take(&mut self.logical_depths);
        let root_depth = depths.get(index).copied().unwrap_or(0);
        self.project_shallow(index, &depths, root_depth.saturating_add(max_logical_depth))
    }

    fn append(
        &mut self,
        subtree: ObservedSubtree,
        path: RefPath,
        logical_depth: u8,
    ) -> Result<u32, AdapterError> {
        let index = u32::try_from(self.nodes.len())
            .map_err(|_| AdapterError::internal("observed tree exceeds u32"))?;
        let document_order = index;
        let ObservedSubtree {
            evidence,
            children,
            completeness,
            children_count,
            source_child_index: _,
            wrapper,
        } = subtree;
        self.nodes.push(ObservedNode {
            evidence,
            path: path.clone(),
            children: Vec::new(),
            document_order,
            completeness,
            children_count,
            ref_id: None,
        });
        self.logical_depths.push(logical_depth);
        let child_logical_depth = logical_depth.saturating_add(u8::from(!wrapper));
        let mut child_indices = Vec::with_capacity(children.len());
        let mut complete = completeness.subtree_complete;
        let mut previous_native_index = None;
        for (child_order, child) in children.into_iter().enumerate() {
            let native_index = child.source_child_index.unwrap_or(child_order);
            if previous_native_index.is_some_and(|previous| previous >= native_index) {
                return Err(AdapterError::internal(
                    "locator tree children are not in native document order",
                ));
            }
            previous_native_index = Some(native_index);
            let mut child_path = path.clone();
            child_path.push(native_index);
            let child_index = self.append(child, child_path, child_logical_depth)?;
            complete &= self.nodes[child_index as usize]
                .completeness
                .subtree_complete;
            child_indices.push(child_index);
        }
        let node = self
            .nodes
            .get_mut(index as usize)
            .ok_or_else(|| AdapterError::internal("observed node disappeared during build"))?;
        node.children = child_indices;
        node.completeness.subtree_complete = complete;
        Ok(index)
    }

    fn project(&mut self, index: usize) -> Result<AccessibilityNode, AdapterError> {
        let (mut projected, child_indices) = self.projected_node(index)?;
        for child in child_indices {
            projected.children.push(self.project(child as usize)?);
        }
        Ok(projected)
    }

    /// Projects the node at `index`, cutting every descendant whose logical
    /// depth in the whole observation reaches past `max_logical_depth`; a cut
    /// node keeps its `children_count` and stays complete.
    fn project_shallow(
        &mut self,
        index: usize,
        depths: &[u8],
        max_logical_depth: u8,
    ) -> Result<AccessibilityNode, AdapterError> {
        let (mut projected, child_indices) = self.projected_node(index)?;
        let below_limit = child_indices
            .first()
            .and_then(|child| depths.get(*child as usize))
            .is_some_and(|depth| *depth > max_logical_depth);
        if below_limit {
            projected.children_count =
                projected
                    .children_count
                    .or(u32::try_from(child_indices.len())
                        .ok()
                        .filter(|count| *count > 0));
            return Ok(projected);
        }
        for child in child_indices {
            projected.children.push(self.project_shallow(
                child as usize,
                depths,
                max_logical_depth,
            )?);
        }
        Ok(projected)
    }

    /// The identity evidence is cloned rather than moved, so a capture proof that
    /// runs after the presentation was cut still reads the observation it proves
    /// each published entry against.
    fn projected_node(
        &mut self,
        index: usize,
    ) -> Result<(AccessibilityNode, Vec<u32>), AdapterError> {
        let node = self
            .nodes
            .get_mut(index)
            .ok_or_else(|| AdapterError::internal("observed child index is out of bounds"))?;
        let role = node
            .evidence
            .role
            .known()
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        let child_indices = node.children.clone();
        let projected = AccessibilityNode {
            ref_id: node.ref_id.take(),
            role,
            identity: crate::NodeIdentity {
                retained_object: node
                    .evidence
                    .identifiers
                    .retained_object()
                    .map(str::to_owned),
                name: node.evidence.name.meaningful_string(),
                value: node.evidence.value.meaningful_string(),
                description: node.evidence.description.meaningful_string(),
                native_id: node.evidence.identifiers.preferred_identifier().cloned(),
            },
            presentation: crate::NodePresentation {
                hint: None,
                states: node.evidence.states.take_known().unwrap_or_default(),
                available_actions: node
                    .evidence
                    .ref_evidence
                    .available_actions
                    .take_known()
                    .unwrap_or_default(),
                bounds: node.evidence.ref_evidence.bounds.known().copied(),
                ref_bounds: node.evidence.ref_evidence.window_bounds.known().copied(),
                descriptors: node.evidence.ref_evidence.descriptors.clone(),
            },
            children_count: node.children_count,
            subtree_truncated: !node.completeness.subtree_complete,
            children: Vec::with_capacity(child_indices.len()),
        };
        Ok((projected, child_indices))
    }
}
