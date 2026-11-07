use super::{LocatorEvidence, LocatorField, ObservationSource, ObservedTree};
use crate::{
    adapter::SnapshotSurface,
    locator::LocatorQuery,
    refs::ref_alloc::is_ref_able_role_actions,
    refs::{RefEntry, RefMap, RefPath},
};

pub(crate) fn materialize_refmap(
    tree: &mut ObservedTree,
    query: &LocatorQuery,
    selected: Option<&[usize]>,
) -> Result<(RefMap, bool), crate::AdapterError> {
    let mut refmap = RefMap::new();
    let mut complete = true;
    let indices: Vec<usize> = selected
        .map(<[usize]>::to_vec)
        .unwrap_or_else(|| (0..tree.nodes.len()).collect());
    let mut planned = Vec::with_capacity(indices.len());
    {
        let proof = crate::refs::ref_capture_proof::CaptureProof::new(tree);
        for index in indices {
            let node = &tree.nodes[index];
            let (addressable, known) = addressability(&node.evidence);
            complete &= known;
            if !addressable {
                continue;
            }
            let mut entry = ref_entry(node, &tree.source, query);
            entry.identity.unique_at_capture = proof.proves_node(&entry, index);
            planned.push((index, entry));
        }
    }
    for (index, entry) in planned {
        let ref_id = refmap.try_allocate(entry).map_err(|error| {
            crate::AdapterError::new(crate::ErrorCode::InvalidArgs, error.to_string())
        })?;
        tree.nodes[index].ref_id = Some(ref_id);
    }
    Ok((refmap, complete))
}

pub(crate) fn addressability(evidence: &LocatorEvidence) -> (bool, bool) {
    let Some(role) = evidence.role.known() else {
        return (false, false);
    };
    match &evidence.ref_evidence.available_actions {
        LocatorField::Known(actions) => (is_ref_able_role_actions(role, actions), true),
        LocatorField::Absent => (is_ref_able_role_actions(role, &[]), true),
        LocatorField::Unknown => (is_ref_able_role_actions(role, &[]), false),
    }
}

/// Whether publishing refs from this observation could publish one that names
/// its node without an element token, which only a window-wide capture proof
/// can vouch for. An unread token counts as absent, and an unsettled
/// addressability counts as addressable: hydration can read actions that make
/// such a node publishable.
pub(crate) fn selects_tokenless_entry(tree: &ObservedTree) -> bool {
    tree.nodes.iter().any(|node| {
        let (addressable, settled) = addressability(&node.evidence);
        (addressable || !settled)
            && !node
                .evidence
                .identifiers
                .retained_object()
                .is_some_and(crate::refs::ref_identity::is_element_token)
    })
}

/// Whether every field a ref entry and a match response carry was read, none
/// of them unknown. An observation of that kind leaves nothing for a second
/// read of the same node to add.
pub(crate) fn fully_observed(evidence: &LocatorEvidence, space: crate::BoundsSpace) -> bool {
    !evidence.role.is_unknown()
        && !evidence.name.is_unknown()
        && !evidence.description.is_unknown()
        && !evidence.value.is_unknown()
        && evidence.identifiers.is_complete()
        && !evidence.states.is_unknown()
        && super::hydrate::geometry_complete(&evidence.ref_evidence, space)
        && addressability(evidence).1
}

pub(crate) fn screen_bounds(evidence: &LocatorEvidence) -> Option<crate::Rect> {
    evidence.ref_evidence.bounds.known().copied()
}

pub(crate) fn ref_entry(
    node: &super::ObservedNode,
    source: &ObservationSource,
    query: &LocatorQuery,
) -> RefEntry {
    let role = node
        .evidence
        .role
        .known()
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let window = node.evidence.ref_evidence.window_bounds.known().copied();
    let bounds = window.or_else(|| node.evidence.ref_evidence.bounds.known().copied());
    let identifier = selected_identifier(&node.evidence, query.identity.native_id.as_deref());
    let mut entry = RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(0),
            process_instance: None,
        },
        identity: crate::RefEntryIdentity {
            retained_object: node
                .evidence
                .identifiers
                .retained_object()
                .map(str::to_owned),
            role: role.clone(),
            name: node.evidence.name.meaningful_string(),
            value: node.evidence.value.meaningful_string(),
            description: node.evidence.description.meaningful_string(),
            native_id: identifier,
            unique_at_capture: false,
        },
        geometry: crate::RefGeometry {
            bounds,
            bounds_hash: bounds.as_ref().and_then(|value| value.bounds_hash()),
            bounds_space: window.map(|_| crate::BoundsSpace::Window),
        },
        capabilities: crate::RefCapabilities {
            states: node.evidence.states.known().cloned().unwrap_or_default(),
            available_actions: available_actions(&node.evidence),
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
            renderer_accessibility_forced: false,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: node.path.clone(),
        },
    };
    apply_source(&mut entry, source, &node.path);
    entry
}

fn apply_source(entry: &mut RefEntry, source: &ObservationSource, node_path: &RefPath) {
    match source {
        ObservationSource::Application { app, surface } => {
            entry.process.pid = app.pid;
            entry.process.process_instance = app.process_instance.clone();
            entry.source.source_app = Some(app.name.clone());
            entry.source.source_window_title = Some(String::new());
            entry.source.source_surface = *surface;
        }
        ObservationSource::Window {
            window,
            surface,
            renderer_accessibility_forced,
        } => {
            entry.process.pid = window.pid;
            entry.source.source_app = Some(window.app.clone());
            entry.source.source_window_id = (!window.is_process_owner()).then(|| window.id.clone());
            entry.source.source_window_title = Some(if window.is_process_owner() {
                String::new()
            } else {
                window.title.clone()
            });
            entry.source.source_window_bounds_hash =
                window.bounds.as_ref().and_then(crate::Rect::bounds_hash);
            entry.source.source_surface = *surface;
            entry.source.renderer_accessibility_forced = *renderer_accessibility_forced;
            entry.process.process_instance = window.process_instance.clone();
        }
        ObservationSource::Element {
            entry: source_entry,
            root_ref,
        } => {
            entry.process = source_entry.process.clone();
            entry.source = source_entry.source.clone();
            entry.scope.root_ref = root_ref
                .clone()
                .or_else(|| source_entry.scope.root_ref.clone());
            entry.scope.path_is_absolute =
                entry.scope.root_ref.is_some() || source_entry.scope.path_is_absolute;
            let mut path = source_entry.scope.path.clone();
            path.extend(node_path.iter().copied());
            entry.scope.path = path;
        }
    }
}

fn selected_identifier(
    evidence: &LocatorEvidence,
    expected: Option<&str>,
) -> Option<crate::ElementIdentifier> {
    if let Some(expected) = expected {
        if let Some(preferred) = evidence.identifiers.preferred_identifier()
            && preferred.value == expected
        {
            return Some(preferred.clone());
        }
        return evidence
            .identifiers
            .identifiers()
            .iter()
            .find(|identifier| identifier.value == expected)
            .cloned();
    }
    evidence.identifiers.preferred_identifier().cloned()
}

fn available_actions(evidence: &LocatorEvidence) -> Vec<String> {
    match &evidence.ref_evidence.available_actions {
        LocatorField::Known(actions) => actions.clone(),
        LocatorField::Absent | LocatorField::Unknown => Vec::new(),
    }
}
