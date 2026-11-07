use crate::{
    AccessibilityNode, AppError, SnapshotOwner, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions},
    context::CommandContext,
    locator::live_locator::{ObservationRequest, ObservationRoot},
    refs::ref_alloc::{self, RefAllocConfig},
    refs::ref_alloc_options::RefAllocOptions,
    refs::ref_alloc_scope::RefAllocScope,
    refs::ref_alloc_source::RefAllocSource,
    refs::ref_root_read::{RootRead, read_saved_root},
    refs::refs_store::RefStore,
    snapshot::SnapshotResult,
};

/// What one drill-down presents: the window it reports, the subtree that
/// replaces the stored refs, the path coordinates its refs are recorded in, and
/// the whole-window observation that proves them.
struct DrillCapture {
    window: WindowInfo,
    tree: AccessibilityNode,
    nodes_observed: usize,
    path_prefix: crate::refs::RefPath,
    observed: crate::locator::live_locator::ObservedTree,
}

#[cfg(test)]
pub fn run_from_ref(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    root_ref_id: &str,
    snapshot_id: Option<&str>,
) -> Result<SnapshotResult, AppError> {
    run_from_ref_with_context(
        adapter,
        opts,
        &crate::refs::ref_token::qualify_for_test(root_ref_id, snapshot_id),
        &CommandContext::default(),
        crate::snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS,
    )
}

/// Drills into the stored ref `root_ref_id` (snapshot-qualified), replacing that subtree's refs in the
/// existing snapshot - `timeout_ms` is the observation deadline (A16-11),
/// threaded into both the drill-down read and the strict re-resolution that
/// precedes it.
///
/// A drill-down replaces refs inside an existing snapshot, so it must observe
/// its whole subtree or leave the stored map untouched. Partial projection is
/// only safe for a full snapshot, which writes a fresh map and destroys nothing.
///
/// A root with an element token is read as its subtree alone when every ref
/// that subtree holds carries a token too, since a token re-identifies itself.
/// Any other drill locates its root in one complete observation of its window,
/// by its token or by its recorded predicate, and projects the subtree from that
/// same observation: the refs it writes were counted against the window they
/// will be resolved in, and the walk that located the root doubles as their
/// evidence.
pub fn run_from_ref_with_context(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    root_ref_id: &str,
    context: &CommandContext,
    timeout_ms: u64,
) -> Result<SnapshotResult, AppError> {
    let store = RefStore::for_session(context.session_id())?;
    let (active_snapshot_id, local_root_ref) =
        crate::refs::ref_token::resolve_ref_target(root_ref_id)?;
    let refmap = store.load_snapshot(&active_snapshot_id)?;

    let entry = refmap
        .get(&local_root_ref)
        .ok_or_else(|| AppError::stale_ref(root_ref_id))?
        .clone();

    let deadline = crate::Deadline::after(timeout_ms)?;
    let capture = drill_capture(adapter, opts, &entry, deadline)?;
    let DrillCapture {
        window,
        tree: raw_tree,
        nodes_observed,
        path_prefix,
        observed,
    } = capture;
    let capture_proof =
        crate::refs::ref_capture_proof::CaptureProof::new(&observed).rooted_at(&path_prefix);
    let owner = resolve_result_owner(&entry, &window, adapter)?;
    let config = RefAllocConfig {
        options: RefAllocOptions {
            include_bounds: opts.include_bounds,
            interactive_only: opts.interactive_only,
            compact: opts.compact,
            force_renderer_accessibility: entry.source.renderer_accessibility_forced,
        },
        source: RefAllocSource {
            pid: entry.process.pid,
            app: entry.source.source_app.as_deref(),
            window_id: entry.source.source_window_id.as_deref(),
            window_title: entry.source.source_window_title.as_deref(),
            window_bounds_hash: entry.source.source_window_bounds_hash,
            process_instance: entry.process.process_instance.as_deref(),
            surface: entry.source.source_surface,
        },
        scope: RefAllocScope {
            root_ref_id: Some(&local_root_ref),
            path_prefix: path_prefix.as_slice(),
        },
        capture: Some(&capture_proof),
    };

    let (mut tree, refmap) = store.update_existing_snapshot(
        &active_snapshot_id,
        &local_root_ref,
        &entry,
        |current| {
            current.remove_by_root_ref(&local_root_ref);
            let mut tree = ref_alloc::allocate_refs(raw_tree, current, &config)?;
            crate::snapshot::hints::add_structural_hints(&mut tree);
            Ok(tree)
        },
    )?;
    crate::trace::trace_artifacts::copy_refmap_if_full(
        context,
        &store,
        &active_snapshot_id,
        &refmap,
    )?;
    crate::refs::ref_token::qualify_tree_refs(&mut tree, &active_snapshot_id);
    context.trace_lazy("snapshot.root.saved", || {
        serde_json::json!({
            "root_ref": root_ref_id,
            "snapshot_id": active_snapshot_id,
            "ref_count": refmap.len()
        })
    })?;

    Ok(SnapshotResult {
        tree,
        refmap,
        owner,
        snapshot_id: Some(active_snapshot_id),
        complete: true,
        nodes_observed,
        identity_unproven: None,
    })
}

fn resolve_result_owner(
    entry: &crate::refs::RefEntry,
    window: &WindowInfo,
    adapter: &dyn PlatformAdapter,
) -> Result<SnapshotOwner, AppError> {
    if adapter.is_application_surface(entry.source.source_surface) {
        let app = super::surface_target::application_from_ref(entry)?;
        crate::system::app_lookup::process_identity(&app)?;
        Ok(SnapshotOwner::Application(app))
    } else {
        Ok(SnapshotOwner::Window(window.clone()))
    }
}

fn drill_capture(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    entry: &crate::refs::RefEntry,
    deadline: crate::Deadline,
) -> Result<DrillCapture, AppError> {
    ObservationRequest::snapshot(opts, deadline).validate()?;
    let (window, mut observed, index) = match read_saved_root(
        adapter,
        entry,
        deadline,
        |window, handle| read_token_subtree(adapter, opts, entry, window, handle, deadline),
        |subtree| !ref_alloc::selects_tokenless_entry(&subtree.tree),
    )? {
        RootRead::Subtree(subtree) => return Ok(subtree),
        RootRead::Window(window_read) => *window_read,
    };
    if !observed.is_exhaustive() {
        return Err(drill_incomplete(observed.nodes.len()));
    }
    let path_prefix = observed
        .nodes
        .get(index)
        .map(|node| node.path.clone())
        .ok_or_else(|| {
            AppError::Adapter(crate::AdapterError::internal(
                "saved ref match is missing from the observation",
            ))
        })?;
    let nodes_observed = observed.nodes.len();
    let tree = observed.project_subtree(index, ObservationRequest::snapshot_logical_depth(opts))?;
    Ok(DrillCapture {
        window,
        tree,
        nodes_observed,
        path_prefix,
        observed,
    })
}

/// A token root's subtree read alone, through the adapter that owns the
/// token. It proves nothing, so it stands only for a drill whose refs all carry
/// tokens.
fn read_token_subtree(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    entry: &crate::refs::RefEntry,
    window: &WindowInfo,
    handle: &crate::adapter::NativeHandle,
    deadline: crate::Deadline,
) -> Result<DrillCapture, AppError> {
    let options = opts.with_ref_identity_bounds();
    let mut observed = crate::tree::renderer_accessibility::observe_tree(
        adapter,
        ObservationRoot::Element {
            handle,
            entry,
            root_ref: None,
        },
        &ObservationRequest::snapshot(&options, deadline).validate()?,
        None,
    )?;
    let (tree, complete, nodes_observed) = observed.project_partial()?;
    if !complete {
        return Err(drill_incomplete(nodes_observed));
    }
    Ok(DrillCapture {
        window: window.clone(),
        tree,
        nodes_observed,
        path_prefix: entry.scope.path.clone(),
        observed,
    })
}

fn drill_incomplete(nodes_observed: usize) -> AppError {
    AppError::Adapter(
        crate::AdapterError::new(
            crate::ErrorCode::Timeout,
            "The drill-down observation was incomplete, so no refs were replaced",
        )
        .with_suggestion("Retry with a larger --timeout-ms, or drill a narrower subtree")
        .with_details(serde_json::json!({
            "kind": "observation_incomplete",
            "nodes_observed": nodes_observed,
        })),
    )
}

#[cfg(test)]
#[path = "snapshot_ref_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "snapshot_ref_alloc_tests.rs"]
mod alloc_tests;
