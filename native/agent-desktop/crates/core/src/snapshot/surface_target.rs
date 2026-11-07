use super::ref_owner_observation::RefOwnerObservation;
use crate::system::process_state::ProcessState;
use crate::{
    AdapterError, AppError, Deadline, PlatformAdapter, SnapshotOwner, SnapshotSurface, WindowInfo,
    adapter::WindowFilter,
};

/// Resolves the window that identifies the process to observe. An app-level
/// surface is not owned by a single window, so several open windows must not be
/// reported as ambiguous when one is requested.
///
/// Kinds naming OS chrome rather than a window's own sub-surface are routed to
/// the adapter's `resolve_shell_surface` seam ahead of the application path,
/// because no application owns them and the window inventory cannot identify
/// them - not even a recorded or requested window id, which a shell container
/// carries too. An adapter that answers with the trait default falls through to
/// the application path, so an adapter's shape never changes by upgrading; every
/// other answer - a missing surface, a build refusal, a timeout - is returned
/// as the adapter supplied it, and a surface that answers with another window
/// leaves the id to the application path.
///
/// `menu-bar-extras` with an app name is that app's own status item and takes the
/// application path, where a background app that lists no window is read through its process.
pub(crate) fn resolve_window_for_surface(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let app_status_item = app_name.is_some() && surface == crate::SnapshotSurface::MenuBarExtras;
    if is_shell_surface(surface) && !app_status_item {
        match adapter.resolve_shell_surface(surface, deadline) {
            Ok(window) if window_id.is_none_or(|id| window.id == id) => return Ok(window),
            Ok(_) => {}
            Err(error)
                if window_id.is_none()
                    && !error.is_default_not_supported("resolve_shell_surface") =>
            {
                return Err(error.into());
            }
            Err(_) => {}
        }
    }
    if window_id.is_some() || (surface == crate::SnapshotSurface::Window && app_name.is_none()) {
        return resolve_window(adapter, app_name, window_id, deadline);
    }
    let windows = windows_for_app(adapter, app_name, deadline)?;
    if let (true, Some(app)) = (windows.is_empty() && is_process_surface(surface), app_name) {
        return crate::system::app_lookup::windowless_app_owner(adapter, app, deadline);
    }
    if let (crate::SnapshotSurface::Window, Some(app)) = (surface, app_name) {
        return select_app_window(windows, app);
    }
    crate::system::window_lookup::select_surface_owner(
        windows,
        crate::AdapterError::new(
            crate::ErrorCode::WindowNotFound,
            format!(
                "No window found to identify the application owning surface '{}'",
                surface.as_str()
            ),
        ),
    )
}

/// Whether the surface names OS chrome rather than a window's own sub-surface:
/// the kinds an adapter may resolve directly, with no owning application and
/// no window in the inventory. Derived from the [`SnapshotSurface`] variant
/// alone - never from a platform check - so the seam stays platform-neutral.
fn is_shell_surface(surface: crate::SnapshotSurface) -> bool {
    matches!(
        surface,
        crate::SnapshotSurface::StartMenu
            | crate::SnapshotSurface::Taskbar
            | crate::SnapshotSurface::SystemTray
            | crate::SnapshotSurface::SystemTrayOverflow
            | crate::SnapshotSurface::ActionCenter
            | crate::SnapshotSurface::QuickSettings
            | crate::SnapshotSurface::Dock
            | crate::SnapshotSurface::MenuBarExtras
    )
}

/// Surfaces a background app with no window still presents, read from its
/// process; the owner then carries an empty window id.
fn is_process_surface(surface: crate::SnapshotSurface) -> bool {
    matches!(
        surface,
        crate::SnapshotSurface::Window
            | crate::SnapshotSurface::Menubar
            | crate::SnapshotSurface::MenuBarExtras
    )
}

fn select_app_window(windows: Vec<WindowInfo>, app: &str) -> Result<WindowInfo, AppError> {
    crate::system::window_lookup::select_window(
        windows,
        crate::AdapterError::app_has_no_window(app),
        "More than one window matches the target",
    )
}

pub(crate) fn surface_windows(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    use crate::SnapshotSurface::{Alert, Popover, Sheet};
    if window_id.is_none() && matches!(surface, Sheet | Popover | Alert) {
        let mut windows = match app_name {
            Some(_) => windows_for_app(adapter, app_name, deadline)?,
            None => frontmost_process_windows(adapter, surface, deadline)?,
        };
        windows.retain(|window| window.state.accessible);
        let windows = crate::system::window_lookup::surface_owner_order(windows);
        if !windows.is_empty() {
            return Ok(windows);
        }
    }
    Ok(vec![resolve_window_for_surface(
        adapter, app_name, window_id, surface, deadline,
    )?])
}

fn frontmost_process_windows(
    adapter: &dyn PlatformAdapter,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    let owner = resolve_window_for_surface(adapter, None, None, surface, deadline)?;
    let mut windows = windows_for_app(adapter, Some(owner.app.as_str()), deadline)?;
    windows.retain(|window| window.pid == owner.pid);
    if windows.is_empty() {
        windows.push(owner);
    }
    Ok(windows)
}

fn windows_for_app(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    let filter = WindowFilter {
        focused_only: app_name.is_none(),
        app: app_name.map(str::to_string),
    };
    Ok(adapter.list_windows(&filter, deadline)?)
}

pub(crate) fn resolve_window(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let filter = WindowFilter {
        focused_only: app_name.is_none() && window_id.is_none(),
        app: app_name.map(str::to_string),
    };

    let windows = adapter.list_windows(&filter, deadline)?;

    if let Some(wid) = window_id {
        windows.into_iter().find(|w| w.id == wid).ok_or_else(|| {
            AppError::Adapter(
                crate::AdapterError::new(
                    crate::ErrorCode::WindowNotFound,
                    format!("No window with id {wid}"),
                )
                .with_suggestion("Run 'list-windows' to see available window IDs.")
                .unsent(),
            )
        })
    } else if let Some(app) = app_name {
        if windows.is_empty() {
            if let Err(AppError::Adapter(error)) =
                crate::system::app_lookup::resolve_app(Some(app), adapter, deadline)
            {
                if error.code == crate::ErrorCode::AppNotFound {
                    return Err(AppError::Adapter(error));
                }
            }
        }
        select_app_window(windows, app)
    } else {
        crate::system::window_lookup::select_window(
            windows,
            crate::AdapterError::new(crate::ErrorCode::WindowNotFound, "No focused window found"),
            "More than one window matches the target",
        )
    }
}
pub(crate) fn resolve_owners(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: SnapshotSurface,
    deadline: Deadline,
) -> Result<Vec<SnapshotOwner>, AppError> {
    if !adapter.is_application_surface(surface) {
        return super::surface_windows(adapter, app_name, window_id, surface, deadline)
            .map(|windows| windows.into_iter().map(SnapshotOwner::Window).collect());
    }
    let app = if window_id.is_some() {
        let window = super::resolve_window(adapter, app_name, window_id, deadline)?;
        crate::system::app_lookup::resolve_app_owning(&window, adapter, deadline)?
    } else if app_name.is_some() {
        crate::system::app_lookup::resolve_app(app_name, adapter, deadline)?
    } else {
        adapter.focused_app(deadline)?.ok_or_else(|| {
            AdapterError::new(
                crate::ErrorCode::AppNotFound,
                "No focused application was found when --app was omitted",
            )
            .unsent()
        })?
    };
    crate::system::app_lookup::process_identity(&app)?;
    Ok(vec![SnapshotOwner::Application(app)])
}

pub(crate) fn resolve_ref_owner(
    adapter: &dyn PlatformAdapter,
    entry: &crate::RefEntry,
    deadline: Deadline,
) -> Result<RefOwnerObservation, AppError> {
    let process = entry.process.identity().ok_or_else(|| {
        AdapterError::new(
            crate::ErrorCode::ActionNotSupported,
            "Ref has no process-instance identity for post-action observation",
        )
    })?;
    let application_surface = adapter.is_application_surface(entry.source.source_surface);
    if application_surface || entry.source.is_process_owned() {
        return Ok(match adapter.process_state(process, deadline)? {
            ProcessState::Running => {
                let app = application_from_ref(entry)?;
                let owner = if application_surface {
                    SnapshotOwner::Application(app)
                } else {
                    SnapshotOwner::Window(crate::WindowInfo::for_process(&app))
                };
                RefOwnerObservation::Present(owner)
            }
            state @ (ProcessState::Exited { .. } | ProcessState::Crashed { .. }) => {
                RefOwnerObservation::Absent(Some(state))
            }
            ProcessState::Unresponsive => {
                RefOwnerObservation::Unavailable(ProcessState::Unresponsive)
            }
        });
    }
    let expected = crate::WindowInfo {
        id: entry.source.source_window_id.clone().ok_or_else(|| {
            AdapterError::new(
                crate::ErrorCode::ActionNotSupported,
                "Ref has no source window for post-action observation",
            )
        })?,
        title: entry.source.source_window_title.clone().unwrap_or_default(),
        app: entry.source.source_app.clone().unwrap_or_default(),
        pid: entry.process.pid,
        process_instance: Some(process.instance.clone()),
        bounds: None,
        state: Default::default(),
    };
    match adapter.resolve_window_strict(&expected, deadline) {
        Ok(window) => {
            if window.id != expected.id
                || window.pid != expected.pid
                || window.process_instance != expected.process_instance
            {
                return Err(AdapterError::stale_ref_because(
                    "Original window identity changed during observation",
                )
                .into());
            }
            Ok(RefOwnerObservation::Present(SnapshotOwner::Window(window)))
        }
        Err(error) if error.code == crate::ErrorCode::WindowNotFound => {
            let state = match adapter.process_state(process, deadline) {
                Ok(state) => state,
                Err(error) if error.is_default_not_supported("process_state") => {
                    return Ok(RefOwnerObservation::Absent(None));
                }
                Err(error) => return Err(error.into()),
            };
            Ok(RefOwnerObservation::Absent(match state {
                ProcessState::Exited { .. } | ProcessState::Crashed { .. } => Some(state),
                ProcessState::Running | ProcessState::Unresponsive => None,
            }))
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn application_from_ref(entry: &crate::RefEntry) -> Result<crate::AppInfo, AppError> {
    Ok(crate::AppInfo {
        name: entry.source.source_app.clone().ok_or_else(|| {
            AdapterError::stale_ref_because("root ref has no application identity")
        })?,
        pid: entry.process.pid,
        process_instance: entry.process.process_instance.clone(),
        bundle_id: None,
        presentation: None,
    })
}

pub(crate) fn ref_observation_surface(
    adapter: &dyn PlatformAdapter,
    entry: &crate::RefEntry,
) -> SnapshotSurface {
    if adapter.is_application_surface(entry.source.source_surface)
        || entry.source.is_process_owned()
    {
        entry.source.source_surface
    } else {
        SnapshotSurface::Window
    }
}

pub(crate) fn is_confirmed_surface_absence(error: &AppError, surface: SnapshotSurface) -> bool {
    matches!(error, AppError::Adapter(error) if error.is_confirmed_surface_absence(surface))
}
