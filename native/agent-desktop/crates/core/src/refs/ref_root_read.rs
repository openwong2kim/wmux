use crate::{
    AppError, Deadline, PlatformAdapter, RefEntry, WindowInfo,
    adapter::NativeHandle,
    refs::ref_identity::element_token,
    refs::resolve_saved_ref::{SavedRefMatch, observe_saved_ref, recorded_window},
};

/// How a drill-down or a rooted find read its root: the root's subtree alone,
/// or one complete observation of the root's window with the root's node in it.
pub(crate) enum RootRead<T> {
    Subtree(T),
    Window(Box<SavedRefMatch>),
}

/// Reads the root a saved ref names. A root carrying an element token is read
/// as its subtree alone through `read_subtree`, and that read stands only when
/// `stands_alone` accepts it: a token re-identifies itself, but a tokenless ref
/// the subtree would publish needs the window-wide capture proof. Every other
/// case locates the root in a complete whole-window observation.
pub(crate) fn read_saved_root<T>(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    deadline: Deadline,
    read_subtree: impl FnOnce(&WindowInfo, &NativeHandle) -> Result<T, AppError>,
    stands_alone: impl FnOnce(&T) -> bool,
) -> Result<RootRead<T>, AppError> {
    if element_token(entry).is_some() {
        let window = recorded_window(adapter, entry, deadline)?;
        let handle = adapter.resolve_element_strict(entry, deadline)?;
        let subtree = read_subtree(&window, &handle)?;
        if stands_alone(&subtree) {
            return Ok(RootRead::Subtree(subtree));
        }
    }
    Ok(RootRead::Window(Box::new(observe_saved_ref(
        adapter, entry, deadline, None, false,
    )?)))
}
