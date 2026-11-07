use super::*;
use crate::adapter::AdAdapter;
use crate::types::{
    AdExactWindowInfo, AdFindQuery, AdFindSelectionKind, AdNativeHandle, AdRect, AdWindowInfo,
};
use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};
use agent_desktop_core::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, ObservationRequest,
    ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
};

const TEST_TIMEOUT_MS: u64 = 1_000;

struct CardinalityAdapter {
    duplicate: bool,
    complete: bool,
    landed: &'static str,
}

impl ActionOps for CardinalityAdapter {}
impl InputOps for CardinalityAdapter {}
impl SystemOps for CardinalityAdapter {}

impl ObservationOps for CardinalityAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, agent_desktop_core::AdapterError> {
        if let ObservationRoot::Element { .. } = root {
            return ObservedTree::from_roots(
                vec![subtree_named(self.landed, self.complete)],
                ObservationSource::from_root(&root, agent_desktop_core::SnapshotSurface::Window),
                Default::default(),
                self.complete,
            );
        }
        let ObservationRoot::Window(window) = root else {
            return Err(agent_desktop_core::AdapterError::internal(
                "expected window root",
            ));
        };
        let mut roots = vec![subtree(self.complete)];
        if self.duplicate {
            roots.push(subtree(self.complete));
        }
        ObservedTree::from_roots(
            roots,
            ObservationSource::Window {
                window: window.clone(),
                surface: agent_desktop_core::SnapshotSurface::Window,
                renderer_accessibility_forced: false,
            },
            Default::default(),
            self.complete,
        )
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &agent_desktop_core::RefEntry,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<agent_desktop_core::NativeHandle, agent_desktop_core::AdapterError> {
        Ok(agent_desktop_core::NativeHandle::null())
    }
}

fn subtree(complete: bool) -> ObservedSubtree {
    subtree_named("Save", complete)
}

fn subtree_named(name: &str, complete: bool) -> ObservedSubtree {
    ObservedSubtree::new(
        LocatorEvidence {
            role: LocatorField::Known("button".into()),
            name: LocatorField::Known(name.into()),
            description: LocatorField::Absent,
            value: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Known(Vec::new()),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Absent,
                available_actions: LocatorField::Known(vec!["Click".into()]),
                descriptors: Default::default(),
            },
        },
        Vec::new(),
        complete,
        None,
    )
}

fn ffi_window() -> AdExactWindowInfo {
    AdExactWindowInfo {
        version: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_VERSION,
        size: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_SIZE as u32,
        window: AdWindowInfo {
            id: c"w-1".as_ptr(),
            title: c"Fixture".as_ptr(),
            app_name: c"Fixture".as_ptr(),
            pid: 42,
            bounds: AdRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            has_bounds: false,
            is_focused: false,
        },
        process_instance: c"42:100".as_ptr(),
        accessible: true,
    }
}

fn query() -> AdFindQuery {
    let mut query = unsafe { std::mem::zeroed::<AdFindQuery>() };
    query.control.version = crate::types::find_query::AD_FIND_QUERY_VERSION;
    query.control.selection.kind = AdFindSelectionKind::Strict as i32;
    query.control.timeout_ms = TEST_TIMEOUT_MS;
    query.filter.identity.name = c"Save".as_ptr();
    query
}

fn call(adapter: CardinalityAdapter) -> AdResult {
    let handle = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(adapter),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let mut out = AdNativeHandle {
        ptr: std::ptr::null(),
    };
    let result = unsafe { ad_find_exact(handle, &ffi_window(), &query(), &mut out) };
    unsafe { crate::adapter::ad_adapter_destroy(handle) };
    assert!(out.ptr.is_null());
    result
}

#[test]
fn strict_duplicate_is_ambiguous_at_the_c_boundary() {
    assert_eq!(
        call(CardinalityAdapter {
            duplicate: true,
            complete: true,
            landed: "Save",
        }),
        AdResult::ErrAmbiguousTarget
    );
}

#[test]
fn strict_incomplete_observation_times_out_at_the_c_boundary() {
    assert_eq!(
        call(CardinalityAdapter {
            duplicate: false,
            complete: false,
            landed: "Save",
        }),
        AdResult::ErrTimeout
    );
}

/// A find lands the entry its observation materialized through the adapter's
/// locator anchor, the landing every platform shares, rather than through a
/// saved-ref search. The stub implements the anchor and nothing else, so a
/// regression back to strict resolution fails here instead of on a desktop.
#[test]
fn a_found_element_lands_through_the_locator_anchor() {
    let adapter = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(CardinalityAdapter {
            duplicate: false,
            complete: true,
            landed: "Save",
        }),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let mut out = AdNativeHandle {
        ptr: std::ptr::null(),
    };

    let result = unsafe { ad_find_exact(adapter, &ffi_window(), &query(), &mut out) };
    let freed = unsafe { crate::actions::native_handle::ad_free_handle(adapter, &mut out) };

    assert_eq!(result, AdResult::Ok);
    assert!(out.ptr.is_null(), "freeing the handle must zero it");
    assert_eq!(freed, AdResult::Ok);
    unsafe { crate::adapter::ad_adapter_destroy(adapter) };
}

/// The handle a C caller receives is the element the query selected, so the
/// landing is re-identified by that entry's full predicate before it is
/// published: a different control occupying the anchored path is refused.
#[test]
fn a_landing_that_is_not_the_selected_element_is_never_published() {
    let adapter = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(CardinalityAdapter {
            duplicate: false,
            complete: true,
            landed: "Delete",
        }),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let mut out = AdNativeHandle {
        ptr: std::ptr::null(),
    };

    let result = unsafe { ad_find_exact(adapter, &ffi_window(), &query(), &mut out) };
    unsafe { crate::adapter::ad_adapter_destroy(adapter) };

    assert_eq!(result, AdResult::ErrStaleRef);
    assert!(out.ptr.is_null(), "a refused landing publishes no handle");
}
