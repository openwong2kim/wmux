use agent_desktop_core::{AdapterError, AppInfo, ErrorCode};
use std::time::Instant;

pub(crate) fn list_apps_until(deadline: Instant) -> Result<Vec<AppInfo>, AdapterError> {
    #[cfg(test)]
    if crate::system::app::app_inventory::adapter_tests::workspace_inventory().is_some() {
        return Ok(Vec::new());
    }
    list_apps_with_filter(None, deadline)
}

pub(crate) fn list_apps_scoped_until(
    name: &str,
    deadline: Instant,
) -> Result<Vec<AppInfo>, AdapterError> {
    list_apps_with_filter(Some(name), deadline)
}

fn list_apps_with_filter(
    name: Option<&str>,
    deadline: Instant,
) -> Result<Vec<AppInfo>, AdapterError> {
    if Instant::now() >= deadline {
        return Err(AdapterError::timeout("process app inventory timed out"));
    }
    let mut apps = Vec::new();
    crate::system::process::process_arguments::visit_commands_until(deadline, |pid, command| {
        if let Some(app) = app_from_command(pid, command)?
            && name.is_none_or(|name| agent_desktop_core::app_name_matches(&app.name, name))
        {
            apps.push(app);
        }
        Ok(())
    })?;
    enrich_process_instances(
        apps,
        crate::system::process::process_identity::token_for_pid,
    )
}

fn enrich_process_instances(
    apps: Vec<AppInfo>,
    mut resolve: impl FnMut(i32) -> Result<Option<String>, AdapterError>,
) -> Result<Vec<AppInfo>, AdapterError> {
    let mut enriched = Vec::with_capacity(apps.len());
    for mut app in apps {
        let pid = crate::system::process::process_identity::to_pid_t(app.pid)?;
        app.process_instance = match resolve(pid) {
            Ok(Some(instance)) => Some(instance),
            Ok(None) => continue,
            Err(error) if is_cross_uid_identity_error(&error) => continue,
            Err(error) => return Err(error),
        };
        enriched.push(app);
    }
    Ok(enriched)
}

pub(crate) fn is_cross_uid_identity_error(error: &AdapterError) -> bool {
    error.code == ErrorCode::PermDenied
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("process_identity_permission")
}

fn app_from_command(pid: i32, command: &[u8]) -> Result<Option<AppInfo>, AdapterError> {
    if pid <= 0 {
        return Ok(None);
    }
    let Some(name) = std::str::from_utf8(command)
        .ok()
        .and_then(app_name_from_command)
    else {
        return Ok(None);
    };
    Ok(Some(AppInfo {
        name,
        pid: crate::system::process::process_identity::from_pid_t(pid)?,
        bundle_id: None,
        process_instance: None,
        presentation: None,
    }))
}

fn app_name_from_command(command: &str) -> Option<String> {
    if command.contains("/Contents/Frameworks/")
        || command.contains("/Contents/PlugIns/")
        || command.contains("/XPCServices/")
        || command.contains(".appex/")
    {
        return None;
    }

    let marker = ".app/Contents/MacOS";
    let marker_start = command.find(marker)?;
    let app_path = &command[..marker_start + ".app".len()];
    let app_name = app_path.rsplit('/').next()?.strip_suffix(".app")?;
    if app_name.is_empty() {
        None
    } else {
        Some(app_name.to_string())
    }
}

#[cfg(test)]
#[path = "process_apps_tests.rs"]
mod tests;
