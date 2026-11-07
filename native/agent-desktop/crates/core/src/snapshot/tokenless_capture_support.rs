use std::sync::{
    Mutex,
    atomic::{AtomicU32, Ordering},
};

use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps, TreeOptions};
use crate::locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree};
use crate::{
    AccessibilityNode, AdapterError, Deadline, NativeHandle, RefEntry, RefMap, WindowInfo,
    refs::refs_store::RefStore,
};

pub(super) const TOKEN: &str = "axtok1:run";

/// Rewrites what the whole-window walk returns, so a test can make that one
/// read come back cut short, fail, or depend on the request it was sent.
pub(super) type WholeReadFault =
    fn(&ObservationRequest, AccessibilityNode) -> Result<AccessibilityNode, AdapterError>;

pub(super) struct CaptureAdapter {
    tree: Mutex<AccessibilityNode>,
    window: WindowInfo,
    captures: AtomicU32,
    pub(super) subtrees: AtomicU32,
    pub(super) strict: AtomicU32,
    anchors: Mutex<Vec<RefEntry>>,
    whole_read: Mutex<Option<WholeReadFault>>,
}

impl CaptureAdapter {
    pub(super) fn new(tree: AccessibilityNode) -> Self {
        Self {
            tree: Mutex::new(tree),
            window: fixture_window(),
            captures: AtomicU32::new(0),
            subtrees: AtomicU32::new(0),
            strict: AtomicU32::new(0),
            anchors: Mutex::new(Vec::new()),
            whole_read: Mutex::new(None),
        }
    }

    pub(super) fn fault_whole_read(&self, fault: WholeReadFault) {
        *self.whole_read.lock().expect("the fault locks") = Some(fault);
    }

    pub(super) fn show(&self, tree: AccessibilityNode) {
        *self.tree.lock().expect("the fixture tree locks") = tree;
    }

    pub(super) fn captures(&self) -> u32 {
        self.captures.load(Ordering::SeqCst)
    }

    pub(super) fn anchored(&self) -> Vec<RefEntry> {
        self.anchors.lock().expect("the anchors lock").clone()
    }
}

impl ObservationOps for CaptureAdapter {
    fn list_windows(
        &self,
        _filter: &crate::adapter::WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![self.window.clone()])
    }

    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        match root {
            ObservationRoot::Window(_) | ObservationRoot::Application { .. } => {
                self.captures.fetch_add(1, Ordering::SeqCst);
                let tree = self.tree.lock().expect("the fixture tree locks").clone();
                let tree = cut(tree, 0, request.max_logical_depth);
                let fault = *self.whole_read.lock().expect("the fault locks");
                let tree = match fault {
                    Some(fault)
                        if request.max_logical_depth
                            >= crate::refs::resolve_saved_ref::WHOLE_WINDOW_DEPTH =>
                    {
                        fault(request, tree)?
                    }
                    _ => tree,
                };
                crate::adapter::observed_tree(&root, tree)
            }
            ObservationRoot::Element { entry, .. } => {
                self.subtrees.fetch_add(1, Ordering::SeqCst);
                let tree = self.tree.lock().expect("the fixture tree locks").clone();
                match entry
                    .identity
                    .retained_object
                    .as_deref()
                    .and_then(|token| find_token_subtree(tree, token))
                {
                    Some(subtree) => crate::adapter::observed_tree(
                        &root,
                        cut(subtree, 0, request.max_logical_depth),
                    ),
                    None => crate::adapter::saved_ref_element_tree(root),
                }
            }
        }
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.strict.fetch_add(1, Ordering::SeqCst);
        Ok(NativeHandle::new("strict"))
    }

    fn resolve_locator_anchor(
        &self,
        entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.anchors
            .lock()
            .expect("the anchors lock")
            .push(entry.clone());
        Ok(NativeHandle::new("anchor"))
    }
}

impl ActionOps for CaptureAdapter {}
impl InputOps for CaptureAdapter {}
impl SystemOps for CaptureAdapter {}

pub(super) fn fixture_window() -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "Fixture".into(),
        pid: crate::ProcessId::new(1),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

pub(super) fn node(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

pub(super) fn group(children: Vec<AccessibilityNode>) -> AccessibilityNode {
    let mut group = node("group", "");
    group.children = children;
    group
}

pub(super) fn window(children: Vec<AccessibilityNode>) -> AccessibilityNode {
    let mut root = node("window", "Fixture");
    root.children = children;
    root
}

/// The subtree whose root carries `token`, as an element read of it returns.
fn find_token_subtree(node: AccessibilityNode, token: &str) -> Option<AccessibilityNode> {
    if node.identity.retained_object.as_deref() == Some(token) {
        return Some(node);
    }
    node.children
        .into_iter()
        .find_map(|child| find_token_subtree(child, token))
}

/// The window as a walk limited to `max_logical_depth` returns it: a container
/// whose children sit below the limit keeps none and carries their count.
pub(super) fn cut(
    mut node: AccessibilityNode,
    depth: u8,
    max_logical_depth: u8,
) -> AccessibilityNode {
    if node.children.is_empty() {
        return node;
    }
    if depth >= max_logical_depth {
        node.children_count = node
            .children_count
            .or(u32::try_from(node.children.len()).ok());
        node.children = Vec::new();
        return node;
    }
    node.children = node
        .children
        .into_iter()
        .map(|child| cut(child, depth + 1, max_logical_depth))
        .collect();
    node
}

/// A cut container carrying its own name three levels down, with a button the
/// skeleton cannot reach below it.
pub(super) fn anchored_window() -> AccessibilityNode {
    let mut sidebar = node("group", "Sidebar");
    sidebar.children = vec![group(vec![node("button", "Save")])];
    window(vec![group(vec![group(vec![sidebar])])])
}

/// `anchored_window` whose anchor re-identifies itself by an element token, so
/// the button below it is the one tokenless ref a drill from it must prove.
pub(super) fn token_anchored_window() -> AccessibilityNode {
    let mut sidebar = node("group", "Sidebar");
    sidebar.identity.retained_object = Some(TOKEN.into());
    sidebar.children = vec![group(vec![node("button", "Save")])];
    window(vec![group(vec![group(vec![sidebar])])])
}

/// `anchored_window` with a twin of the anchor hidden below the skeleton depth,
/// beside a second anchor that stays unique.
pub(super) fn twinned_window() -> AccessibilityNode {
    let mut twin = node("group", "Sidebar");
    twin.children = vec![node("button", "Twin")];
    let mut sidebar = node("group", "Sidebar");
    sidebar.children = vec![group(vec![twin])];
    let mut toolbar = node("group", "Toolbar");
    toolbar.children = vec![node("button", "Open")];
    window(vec![group(vec![group(vec![sidebar, toolbar])])])
}

/// `anchored_window` with the skeleton anchor pushed one sibling to the right,
/// so the path the snapshot saved is no longer where the anchor lives.
pub(super) fn shifted_window() -> AccessibilityNode {
    let mut sidebar = node("group", "Sidebar");
    sidebar.children = vec![group(vec![node("button", "Save")])];
    window(vec![group(vec![
        node("button", "Inserted"),
        group(vec![sidebar]),
    ])])
}

pub(super) fn skeleton_opts() -> TreeOptions {
    TreeOptions {
        max_depth: 3,
        skeleton: true,
        ..Default::default()
    }
}

pub(super) fn drill_opts() -> TreeOptions {
    TreeOptions {
        max_depth: 10,
        ..Default::default()
    }
}

pub(super) fn snapshot(adapter: &CaptureAdapter) -> crate::snapshot::SnapshotResult {
    crate::snapshot::build(
        adapter,
        &skeleton_opts(),
        Some("Fixture"),
        None,
        Deadline::standard().expect("a standard deadline"),
    )
    .expect("the window snapshots")
}

pub(super) fn save(refmap: &RefMap) -> String {
    RefStore::new()
        .expect("the snapshot store opens")
        .save_new_snapshot(refmap)
        .expect("the snapshot refmap saves")
}

pub(super) fn named<'a>(refmap: &'a RefMap, name: &str) -> (String, &'a RefEntry) {
    (1..=64)
        .filter_map(|index| {
            let ref_id = format!("@e{index}");
            refmap
                .get(&ref_id)
                .filter(|entry| entry.identity.name.as_deref() == Some(name))
                .map(|entry| (ref_id, entry))
        })
        .next()
        .unwrap_or_else(|| panic!("no ref names '{name}'"))
}

pub(super) fn resolve(
    adapter: &CaptureAdapter,
    entry: &RefEntry,
) -> Result<NativeHandle, AdapterError> {
    crate::refs::resolve_saved_ref::resolve_saved_ref(
        adapter,
        entry,
        Deadline::standard().expect("a standard deadline"),
        None,
    )
}
