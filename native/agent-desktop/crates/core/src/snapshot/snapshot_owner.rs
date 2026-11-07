use crate::{AppInfo, ObservationRoot, SnapshotSurface, WindowInfo};

#[derive(Debug, Clone)]
pub enum SnapshotOwner {
    Application(AppInfo),
    Window(WindowInfo),
}

impl SnapshotOwner {
    pub fn app_name(&self) -> &str {
        match self {
            Self::Application(app) => &app.name,
            Self::Window(window) => &window.app,
        }
    }

    pub fn window(&self) -> Option<&WindowInfo> {
        match self {
            Self::Application(_) => None,
            Self::Window(window) if !window.is_process_owner() => Some(window),
            Self::Window(_) => None,
        }
    }

    pub fn observation_root(&self, surface: SnapshotSurface) -> ObservationRoot<'_> {
        match self {
            Self::Application(app) => ObservationRoot::Application { app, surface },
            Self::Window(window) => ObservationRoot::Window(window),
        }
    }

    pub(crate) fn ref_source(
        &self,
        surface: SnapshotSurface,
    ) -> crate::refs::ref_alloc_source::RefAllocSource<'_> {
        use crate::refs::ref_alloc_source::RefAllocSource;
        match self {
            Self::Application(app) => RefAllocSource {
                pid: app.pid,
                app: Some(&app.name),
                process_instance: app.process_instance.as_deref(),
                window_id: None,
                window_title: Some(""),
                window_bounds_hash: None,
                surface,
            },
            Self::Window(window) => RefAllocSource {
                pid: window.pid,
                app: Some(&window.app),
                process_instance: window.process_instance.as_deref(),
                window_id: (!window.is_process_owner()).then_some(window.id.as_str()),
                window_title: Some(if window.is_process_owner() {
                    ""
                } else {
                    &window.title
                }),
                window_bounds_hash: window.bounds.as_ref().and_then(crate::Rect::bounds_hash),
                surface,
            },
        }
    }
}
