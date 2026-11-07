//! The Dock and the system menu bar extras: surfaces no window owns, found by
//! the process that presents them.

use super::{AXElement, properties::element::element_for_pid, surface_read};
use agent_desktop_core::{AdapterError, ErrorCode, SnapshotSurface, WindowInfo};
use std::time::Instant;

/// MenuBarAgent hosts the system status items on current macOS; Control Center
/// and SystemUIServer hosted them on earlier releases.
const MENU_BAR_EXTRAS_HOSTS: [&str; 3] = [
    "com.apple.MenuBarAgent",
    "com.apple.controlcenter",
    "com.apple.systemuiserver",
];

/// The system menu bar extras root in `pid`, or `None` when it presents none.
pub(crate) fn extras_menu_bar(
    pid: i32,
    deadline: Instant,
) -> Result<Option<AXElement>, AdapterError> {
    surface_read::element(&element_for_pid(pid), "AXExtrasMenuBar", deadline)
}

/// Whether `element` is a status item: a child of its app's extras menu bar,
/// which has no window and takes a click wherever the app is. A failed read
/// answers false.
pub(crate) fn is_status_item(element: &AXElement, deadline: Instant) -> bool {
    use super::properties::attributes::copy_element_attr_result;
    let parent = copy_element_attr_result(element, "AXParent", deadline);
    let pid = super::properties::ax_ipc::pid(element, deadline);
    match (parent, pid) {
        (Ok(Some(parent)), Ok(pid)) => matches!(
            extras_menu_bar(pid, deadline),
            Ok(Some(extras)) if super::same_element(&parent, &extras)
        ),
        _ => false,
    }
}

pub(crate) fn resolve_surface(
    surface: SnapshotSurface,
    deadline: Instant,
) -> Result<WindowInfo, AdapterError> {
    let hosts: &[&str] = match surface {
        SnapshotSurface::Dock => &["com.apple.dock"],
        SnapshotSurface::MenuBarExtras => &MENU_BAR_EXTRAS_HOSTS,
        _ => {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("'{}' is not a macOS shell surface", surface.as_str()),
            )
            .with_suggestion("Use dock or menu-bar-extras; open Control Center or Notification Center by clicking its menu-bar-extras item")
            .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
        }
    };
    let inventory = crate::system::app::workspace_apps::list_apps_inventory_until(deadline)?;
    for host in hosts {
        for app in inventory
            .apps
            .iter()
            .filter(|app| app.bundle_id.as_deref() == Some(*host))
        {
            let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
            if surface == SnapshotSurface::Dock || extras_menu_bar(pid, deadline)?.is_some() {
                return Ok(WindowInfo::for_process(app));
            }
        }
    }
    crate::system::app::workspace_apps::require_complete(&inventory.skipped)?;
    Err(AdapterError::new(
        ErrorCode::WindowNotFound,
        format!(
            "No running process presents the '{}' surface",
            surface.as_str()
        ),
    ))
}
