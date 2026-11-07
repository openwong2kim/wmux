use crate::AdAdapter;
use crate::actions::exact_entry::{core_ref_entry_from_exact, exact_entry_unsupported};
use crate::error::{self, AdResult};
use crate::ffi_try::trap_panic;
use crate::types::{AdExactRefEntry, AdNativeHandle};

/// Validates an exact entry and refuses it. An exact entry carries no retained
/// element token and no capture proof, so a well-formed one fails with
/// `ACTION_NOT_SUPPORTED` (`exact_entry_unsupported`) and a malformed one with
/// `INVALID_ARGS`; callers act through a snapshot ref with `ad_execute_by_ref`
/// or locate the element with `ad_find_exact` instead.
///
/// # Safety
///
/// `adapter` and `entry` must be live and valid; `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_resolve_element_exact(
    adapter: *const AdAdapter,
    entry: *const AdExactRefEntry,
    out: *mut AdNativeHandle,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        (*out).ptr = std::ptr::null();
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(entry, c"entry is null");
        if let Err(error) = core_ref_entry_from_exact(&*entry) {
            error::set_last_error(&error);
            return error::last_error_code();
        }
        let _live = crate::adapter::acquire_adapter!(adapter);
        error::set_last_error(&exact_entry_unsupported());
        error::last_error_code()
    })
}
