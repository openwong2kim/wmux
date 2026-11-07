use crate::{
    AccessibilityNode, AppError, SnapshotOwner, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions},
    context::CommandContext,
    refs::RefMap,
    refs::ref_alloc::{self, RefAllocConfig},
    refs::ref_alloc_options::RefAllocOptions,
    refs::ref_alloc_scope::RefAllocScope,
    refs::refs_store::RefStore,
    trace::trace_artifacts,
};
use serde_json::json;

#[derive(Clone)]
pub struct SnapshotResult {
    pub tree: AccessibilityNode,
    pub refmap: RefMap,
    pub owner: SnapshotOwner,
    pub snapshot_id: Option<String>,
    pub complete: bool,
    pub nodes_observed: usize,
    /// Set when the whole-window read that proves tokenless refs failed or was
    /// cut short; it says why, and those refs are refused when used.
    pub identity_unproven: Option<String>,
}

impl SnapshotResult {
    pub(crate) fn save_refmap(&self, store: &RefStore) -> Result<String, AppError> {
        if self.complete {
            store.save_new_snapshot(&self.refmap)
        } else {
            store.save_new_snapshot_detached(&self.refmap)
        }
    }

    pub(crate) fn bind_snapshot_id(&mut self, snapshot_id: String) {
        crate::refs::ref_token::qualify_tree_refs(&mut self.tree, &snapshot_id);
        self.snapshot_id = Some(snapshot_id);
    }
}

pub fn build(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<SnapshotResult, AppError> {
    let owners =
        surface_target::resolve_owners(adapter, app_name, window_id, opts.surface, deadline)?;
    build_for_owners(adapter, opts, owners, deadline)
}

pub(crate) fn build_for_owners(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    owners: Vec<SnapshotOwner>,
    deadline: crate::Deadline,
) -> Result<SnapshotResult, AppError> {
    let (owner, capture) = window_capture::first_surface_owner(owners, |owner| match owner {
        SnapshotOwner::Application(app) => {
            window_capture::capture_application(adapter, opts, app, opts.surface, deadline)
        }
        SnapshotOwner::Window(window) => {
            window_capture::capture_window(adapter, opts, window, deadline)
        }
    })?;
    let identity_unproven = capture.identity_unproven.clone();
    let (raw_tree, complete, nodes_observed, observed) = capture.into_parts()?;
    let capture_proof = crate::refs::ref_capture_proof::CaptureProof::new(&observed);

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: RefAllocOptions {
            include_bounds: opts.include_bounds,
            interactive_only: opts.interactive_only,
            compact: opts.compact,
            force_renderer_accessibility: opts.force_renderer_accessibility,
        },
        source: owner.ref_source(opts.surface),
        scope: RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
        capture: Some(&capture_proof),
    };
    let mut tree = ref_alloc::allocate_refs(raw_tree, &mut refmap, &config)?;

    crate::snapshot::hints::add_structural_hints(&mut tree);

    Ok(SnapshotResult {
        tree,
        refmap,
        owner,
        snapshot_id: None,
        complete,
        nodes_observed,
        identity_unproven,
    })
}

pub(crate) fn resolve_window_for_surface(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    surface_target::resolve_window_for_surface(adapter, app_name, window_id, surface, deadline)
}

pub(crate) fn surface_windows(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    surface_target::surface_windows(adapter, app_name, window_id, surface, deadline)
}

pub(crate) fn resolve_window(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    surface_target::resolve_window(adapter, app_name, window_id, deadline)
}

#[cfg(test)]
pub fn run(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app_name: Option<&str>,
    window_id: Option<&str>,
) -> Result<SnapshotResult, AppError> {
    run_with_context(
        adapter,
        opts,
        &SnapshotTarget {
            app_name,
            window_id,
        },
        &CommandContext::default(),
        DEFAULT_SNAPSHOT_TIMEOUT_MS,
    )
}

/// Which window a full snapshot targets: the focused window when both fields
/// are `None`, a named app's focused window, or an exact window id.
pub struct SnapshotTarget<'a> {
    pub app_name: Option<&'a str>,
    pub window_id: Option<&'a str>,
}

/// The default snapshot observation deadline.
///
/// A16-11 measured a cold Chromium settle at 10-25 s against the previous
/// hardcoded 3 s, so callers can raise it explicitly via `--timeout-ms`; the
/// default stays 3 s for the ecosystems that settle fast.
pub const DEFAULT_SNAPSHOT_TIMEOUT_MS: u64 = 3_000;

/// Runs a full snapshot for `target` and persists its refmap under
/// `context`'s session, using `timeout_ms` as the observation deadline
/// (`DEFAULT_SNAPSHOT_TIMEOUT_MS` for callers with no reason to raise it).
pub fn run_with_context(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    target: &SnapshotTarget,
    context: &CommandContext,
    timeout_ms: u64,
) -> Result<SnapshotResult, AppError> {
    let mut result = build(
        adapter,
        opts,
        target.app_name,
        target.window_id,
        crate::Deadline::after(timeout_ms)?,
    )?;
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = result.save_refmap(&store)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &result.refmap)?;
    result.bind_snapshot_id(snapshot_id);
    emit_snapshot_saved(context, &result)?;
    Ok(result)
}

pub(crate) fn emit_snapshot_saved(
    context: &CommandContext,
    result: &SnapshotResult,
) -> Result<(), AppError> {
    context.trace_lazy("snapshot.saved", || {
        let mut fields = json!({
            "snapshot_id": result.snapshot_id,
            "ref_count": result.refmap.len(),
        });
        if !result.owner.app_name().is_empty() {
            fields["app"] = json!(result.owner.app_name());
        }
        if let Some(reason) = &result.identity_unproven {
            fields["identity_unproven"] = json!(reason);
        }
        fields
    })
}

pub mod hints;
pub(crate) mod ref_owner_observation;
pub(crate) mod snapshot_owner;
pub(crate) mod snapshot_ref;
pub mod snapshot_surface;
pub(crate) mod surface_target;
#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
pub(crate) mod window_capture;

#[cfg(test)]
#[path = "tokenless_capture_support.rs"]
mod tokenless_capture_support;

#[cfg(test)]
#[path = "tokenless_capture_tests.rs"]
mod tokenless_capture_tests;

#[cfg(test)]
#[path = "tokenless_drill_tests.rs"]
mod tokenless_drill_tests;

#[cfg(test)]
#[path = "snapshot_deadline_tests.rs"]
mod deadline_tests;

#[cfg(test)]
#[path = "snapshot_window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "snapshot_surface_window_tests.rs"]
mod surface_window_tests;
