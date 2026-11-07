use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Point};

use crate::tree::AXElement;

pub(crate) struct PreparedPhysicalTarget {
    identity: crate::system::process::process_identity::ProcessIdentity,
    window: Option<AXElement>,
    focus_required: bool,
}

impl PreparedPhysicalTarget {
    pub(crate) fn prepare(element: &AXElement, deadline: Deadline) -> Result<Self, AdapterError> {
        let pid =
            crate::system::app::app_ops::pid_from_element(element, deadline).ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::StaleRef,
                    "Physical input target no longer has an owning application",
                )
            })?;
        let identity = crate::system::process::process_identity::ProcessIdentity::capture(pid)?
            .ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::StaleRef,
                    "Physical input target process exited before input preparation",
                )
            })?;
        let native_menu = crate::tree::native_menu::is_native_menu(element, deadline)?;
        let window = if native_menu {
            None
        } else {
            target_window(element, pid, deadline)?
        };
        let focus_required = native_menu || window.is_some();
        let prepared = Self {
            identity,
            window,
            focus_required,
        };
        prepared.verify_focus(deadline)?;
        Ok(prepared)
    }

    /// Requires the app to be frontmost and the window main whenever the
    /// target has a window that focus applies to.
    fn verify_focus(&self, deadline: Deadline) -> Result<(), AdapterError> {
        if !self.focus_required {
            return Ok(());
        }
        crate::system::focus::verify_app_focused(self.identity.pid(), deadline)?;
        if let Some(window) = &self.window {
            crate::system::focus::verify_window_main(window, deadline)?;
        }
        Ok(())
    }

    pub(crate) fn verify_pointer(
        &self,
        element: &AXElement,
        point: &Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        self.verify_focus(deadline)?;
        verify_pointer_identity(
            crate::tree::hit_test::hit_test_ax_element(element, point.clone(), deadline),
            || self.identity.still_matches(),
        )
    }
}

/// The window that must stay main during input, or `None` when focus cannot
/// apply: a background app (a menu bar app, the Dock, a system panel) never
/// becomes frontmost, and a status item has no window. The hit test still
/// gates delivery. Any other target without a verified window is refused.
fn target_window(
    element: &AXElement,
    pid: i32,
    deadline: Deadline,
) -> Result<Option<AXElement>, AdapterError> {
    let instant = crate::tree::locator_deadline::from_operation(deadline)?;
    if is_background_app(pid, instant) {
        return Ok(None);
    }
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)?;
    let result = crate::tree::properties::attributes::copy_element_attr_result(
        element, "AXWindow", deadline,
    );
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    match result {
        Ok(Some(window)) => Ok(Some(window)),
        Ok(None) if crate::tree::shell_surface::is_status_item(element, instant) => Ok(None),
        Ok(None) => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Physical input target has no verified owning window",
        )
        .with_details(serde_json::json!({ "physical_delivery_started": false }))),
        Err(error) => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Could not verify the physical input target window",
        )
        .with_details(serde_json::json!({
            "ax_error": error,
            "physical_delivery_started": false,
        }))),
    }
}

/// Whether `pid` is an app AppKit runs without a regular activation policy. A
/// failed inventory read answers false, which keeps every focus check.
fn is_background_app(pid: i32, deadline: std::time::Instant) -> bool {
    crate::system::app::workspace_apps::window_owner_snapshot_until(deadline).is_ok_and(|owners| {
        owners.owner(pid).is_some_and(|owner| {
            owner.activation_policy != crate::system::app::workspace_apps::ActivationPolicy::Regular
        })
    })
}

fn verify_pointer_identity(
    hit: Result<agent_desktop_core::HitTestResult, AdapterError>,
    same_instance: impl FnOnce() -> Result<bool, AdapterError>,
) -> Result<(), AdapterError> {
    match hit? {
        agent_desktop_core::adapter::hit_test::HitTestResult::ReachesTarget => {}
        agent_desktop_core::adapter::hit_test::HitTestResult::InterceptedBy {
            role, name, ..
        } => {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "Physical input point is intercepted by another accessibility element",
            )
            .with_details(serde_json::json!({
                "physical_delivery_started": false,
                "occluder_role": role,
                "occluder_name": name,
            })));
        }
        agent_desktop_core::adapter::hit_test::HitTestResult::Unknown => {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "Physical input target could not be proven at the final input point",
            )
            .with_details(serde_json::json!({ "physical_delivery_started": false })));
        }
    }
    if !same_instance()? {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Physical input target process instance changed at input delivery",
        )
        .with_details(serde_json::json!({ "physical_delivery_started": false })));
    }
    Ok(())
}

#[cfg(test)]
#[path = "physical_target_tests.rs"]
mod tests;
