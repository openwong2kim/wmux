use serde::{Deserialize, Serialize};

use crate::{ProcessId, Rect, WindowState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    #[serde(rename = "app_name")]
    pub app: String,
    pub pid: ProcessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    #[serde(flatten)]
    pub state: WindowState,
}

impl WindowInfo {
    /// Identifies an app's process instead of one of its windows, for an app
    /// observed from its application root because it has no window.
    pub fn for_process(app: &crate::AppInfo) -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            app: app.name.clone(),
            pid: app.pid,
            process_instance: app.process_instance.clone(),
            bounds: None,
            state: WindowState::default(),
        }
    }

    /// Whether this names a process built by [`WindowInfo::for_process`]
    /// rather than a window.
    pub fn is_process_owner(&self) -> bool {
        self.id.is_empty()
    }
}

#[cfg(test)]
#[path = "window_info_tests.rs"]
mod tests;
