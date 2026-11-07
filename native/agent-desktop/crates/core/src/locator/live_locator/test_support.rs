use super::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
    ObservationSource, ObservedNode, ObservedTree,
};
use crate::{WindowInfo, refs::RefPath};

pub(super) fn window() -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "FixtureApp".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: true,
            ..Default::default()
        },
    }
}

pub(crate) fn evidence(role: &str, name: Option<&str>) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.to_string()),
        name: name
            .map(|value| LocatorField::Known(value.to_string()))
            .unwrap_or(LocatorField::Absent),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Known(Vec::new()),
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(Vec::new()),
            descriptors: Default::default(),
        },
    }
}

pub(crate) fn node(
    document_order: u32,
    evidence: LocatorEvidence,
    children: Vec<u32>,
    path: &[usize],
) -> ObservedNode {
    ObservedNode {
        evidence,
        path: RefPath::from_slice(path),
        children,
        document_order,
        completeness: super::ObservationCompleteness::new(true),
        children_count: None,
        ref_id: None,
    }
}

pub(crate) fn tree(
    nodes: Vec<ObservedNode>,
    roots: Vec<u32>,
    structurally_complete: bool,
) -> ObservedTree {
    for (index, node) in nodes.iter().enumerate() {
        assert_eq!(node.document_order as usize, index);
        assert!(node.children.iter().all(|child| *child as usize > index));
    }
    let logical_depths = depths_of(&nodes, &roots);
    ObservedTree {
        nodes,
        roots,
        source: ObservationSource::Window {
            window: window(),
            surface: crate::SnapshotSurface::Window,
            renderer_accessibility_forced: false,
        },
        stats: LocatorStats::default(),
        structurally_complete,
        logical_depths,
    }
}

/// The logical depth of every fixture node: none of them is a layout wrapper,
/// so each level costs one. A fixture that needs a wrapper patches the entry.
fn depths_of(nodes: &[ObservedNode], roots: &[u32]) -> Vec<u8> {
    let mut depths: Vec<u8> = vec![0; nodes.len()];
    let mut pending = roots.to_vec();
    while let Some(index) = pending.pop() {
        let Some(node) = nodes.get(index as usize) else {
            continue;
        };
        let below = depths[index as usize].saturating_add(1);
        for child in &node.children {
            if let Some(depth) = depths.get_mut(*child as usize) {
                *depth = below;
                pending.push(*child);
            }
        }
    }
    depths
}
