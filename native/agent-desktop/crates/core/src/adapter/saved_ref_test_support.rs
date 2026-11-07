use crate::adapter::test_support::{minimal_accessibility_node, observed_tree};

/// The window inventory a saved-ref test searches: one focused window for the
/// lowest process id plus one window per further id test entries use, each
/// named after its process so a recorded window id selects exactly one.
pub(crate) fn saved_ref_window_pool() -> Vec<crate::WindowInfo> {
    [1, 2, 7, 42, 99]
        .into_iter()
        .map(|pid| {
            let mut window = saved_ref_window(&format!("w-{pid}"), pid, "test-instance");
            window.state = crate::WindowState {
                is_focused: pid == 1,
                visible: Some(true),
                ..Default::default()
            };
            window
        })
        .collect()
}

/// One window of the pool: the process the test's saved entry belongs to.
pub(crate) fn saved_ref_window(id: &str, pid: u32, instance: &str) -> crate::WindowInfo {
    crate::WindowInfo {
        id: id.into(),
        title: format!("Window {pid}"),
        app: "Test".into(),
        pid: crate::ProcessId::new(pid),
        process_instance: Some(instance.into()),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

/// A one-node observation carrying the identity a saved-ref test expects its
/// entry to match, so the shared resolver's live count sees exactly one match.
pub(crate) fn saved_ref_tree(
    root: crate::locator::live_locator::ObservationRoot<'_>,
    role: &str,
    name: Option<&str>,
) -> Result<crate::locator::live_locator::ObservedTree, crate::AdapterError> {
    if matches!(
        root,
        crate::locator::live_locator::ObservationRoot::Element { .. }
    ) {
        return saved_ref_element_tree(root);
    }
    let mut node = minimal_accessibility_node(role, name.unwrap_or_default());
    node.identity.name = name.map(str::to_string);
    observed_tree(&root, node)
}

/// The landed element a resolution re-identifies: the anchored entry's own
/// identity, which is what an element-root observation answers for.
pub(crate) fn saved_ref_element_tree(
    root: crate::locator::live_locator::ObservationRoot<'_>,
) -> Result<crate::locator::live_locator::ObservedTree, crate::AdapterError> {
    let crate::locator::live_locator::ObservationRoot::Element { entry, .. } = root else {
        return Err(crate::AdapterError::internal(
            "an element observation needs an element root",
        ));
    };
    let mut node = minimal_accessibility_node(&entry.identity.role, "");
    node.identity.name = entry.identity.name.clone();
    node.identity.value = entry.identity.value.clone();
    node.identity.description = entry.identity.description.clone();
    node.identity.native_id = entry.identity.native_id.clone();
    observed_tree(&root, node)
}

/// An observation of several nodes, for a stub whose tests save refs for more
/// than one identity: the root itself is a nameless group none of them match.
pub(crate) fn saved_ref_tree_nodes(
    root: crate::locator::live_locator::ObservationRoot<'_>,
    nodes: &[(&str, Option<&str>, Option<&str>)],
) -> Result<crate::locator::live_locator::ObservedTree, crate::AdapterError> {
    if matches!(
        root,
        crate::locator::live_locator::ObservationRoot::Element { .. }
    ) {
        return saved_ref_element_tree(root);
    }
    let mut group = minimal_accessibility_node("group", "");
    group.identity.name = None;
    group.children = nodes
        .iter()
        .map(|(role, name, value)| {
            let mut node = minimal_accessibility_node(role, name.unwrap_or_default());
            node.identity.name = name.map(str::to_string);
            node.identity.value = value.map(str::to_string);
            node
        })
        .collect();
    observed_tree(&root, group)
}

/// The anchor landing a saved-ref resolution needs: the stub's own strict
/// resolution answer for the positional anchor built from the live node.
macro_rules! saved_ref_anchor {
    () => {
        fn resolve_locator_anchor(
            &self,
            entry: &$crate::RefEntry,
            deadline: $crate::Deadline,
        ) -> Result<$crate::adapter::NativeHandle, $crate::AdapterError> {
            self.resolve_element_strict(entry, deadline)
        }
    };
}

pub(crate) use saved_ref_anchor;

/// The observation a saved-ref resolution makes: one node carrying the
/// identity the test's entry expects to match, plus its anchor landing.
macro_rules! saved_ref_observation {
    ($role:expr, $name:expr) => {
        fn observe_tree(
            &self,
            root: $crate::locator::live_locator::ObservationRoot<'_>,
            _request: &$crate::locator::live_locator::ObservationRequest,
        ) -> Result<$crate::locator::live_locator::ObservedTree, $crate::AdapterError> {
            $crate::adapter::saved_ref_tree(root, $role, $name)
        }

        $crate::adapter::saved_ref_anchor!();
    };
}

pub(crate) use saved_ref_observation;

/// [`saved_ref_observation`] for a test stub whose entries name more than one
/// identity.
macro_rules! saved_ref_observation_nodes {
    ($nodes:expr) => {
        fn observe_tree(
            &self,
            root: $crate::locator::live_locator::ObservationRoot<'_>,
            _request: &$crate::locator::live_locator::ObservationRequest,
        ) -> Result<$crate::locator::live_locator::ObservedTree, $crate::AdapterError> {
            $crate::adapter::saved_ref_tree_nodes(root, $nodes)
        }

        $crate::adapter::saved_ref_anchor!();
    };
}

pub(crate) use saved_ref_observation_nodes;

/// [`saved_ref_observation`] plus the window inventory the resolution
/// searches, for a stub that does not ship one of its own.
macro_rules! saved_ref_scope {
    ($role:expr, $name:expr) => {
        $crate::adapter::saved_ref_scope!(@inventory);
        $crate::adapter::saved_ref_observation!($role, $name);
    };
    (nodes: $nodes:expr) => {
        $crate::adapter::saved_ref_scope!(@inventory);
        $crate::adapter::saved_ref_observation_nodes!($nodes);
    };
    (@inventory) => {
        fn list_windows(
            &self,
            _filter: &$crate::adapter::WindowFilter,
            _deadline: $crate::Deadline,
        ) -> Result<Vec<$crate::WindowInfo>, $crate::AdapterError> {
            Ok($crate::adapter::saved_ref_window_pool())
        }
    };
}

pub(crate) use saved_ref_scope;
