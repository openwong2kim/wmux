use crate::{AdapterError, AppError, refs::RefPath};

use super::ObservedTree;

/// A tree the caller already observed, and the node a query is scoped to.
///
/// A rooted find arrives here with the whole-window read that re-identified its
/// root plus that root's path, so its matches are drawn from the root's subtree
/// while the capture proof behind their refs runs over every node of the same
/// observation. Nothing is proven across two reads.
pub(crate) struct ObservedObservation {
    pub(crate) tree: ObservedTree,
    pub(crate) scope: Option<RefPath>,
}

impl ObservedObservation {
    pub(crate) fn whole(tree: ObservedTree) -> Self {
        Self { tree, scope: None }
    }

    pub(crate) fn under(tree: ObservedTree, root: usize) -> Result<Self, AppError> {
        let mut observed = Self::whole(tree);
        let scope = observed
            .tree
            .nodes
            .get(root)
            .map(|node| node.path.clone())
            .ok_or_else(|| {
                AppError::Adapter(AdapterError::internal(
                    "rooted observation is missing its root node",
                ))
            })?;
        observed.scope = Some(scope);
        Ok(observed)
    }
}
