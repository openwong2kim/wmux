#[non_exhaustive]
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotSurface {
    #[default]
    Window,
    Focused,
    Menu,
    Menubar,
    Sheet,
    Popover,
    Alert,
    Desktop,
    Taskbar,
    #[serde(alias = "system-tray")]
    SystemTray,
    #[serde(alias = "quick-settings")]
    QuickSettings,
    #[serde(alias = "notification-center")]
    NotificationCenter,
    Toolbar,
    Dock,
    Spotlight,
    #[serde(alias = "menu-bar-extras")]
    MenuBarExtras,
    #[serde(alias = "system-tray-overflow")]
    SystemTrayOverflow,
    #[serde(alias = "start-menu")]
    StartMenu,
    #[serde(alias = "action-center")]
    ActionCenter,
}

impl SnapshotSurface {
    /// The refusal for a surface an adapter does not root: a wrong argument
    /// when the platform roots other kinds, a platform limit when it roots none.
    pub fn unavailable_error(self, supported: &[Self]) -> crate::AdapterError {
        crate::AdapterError::new(
            if supported.is_empty() {
                crate::ErrorCode::PlatformNotSupported
            } else {
                crate::ErrorCode::InvalidArgs
            },
            format!("Snapshot surface '{}' is not available on this platform", self.as_str()),
        )
        .with_details(serde_json::json!({
            "requested_surface": self.as_str(),
            "supported_surfaces": supported.iter().map(|surface| surface.as_str()).collect::<Vec<_>>()
        }))
        .with_suggestion("Choose one of the supported snapshot surfaces")
        .with_disposition(crate::DeliverySemantics::not_delivered())
    }

    pub fn is_window(surface: &Self) -> bool {
        matches!(surface, Self::Window)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Focused => "focused",
            Self::Menu => "menu",
            Self::Menubar => "menubar",
            Self::Sheet => "sheet",
            Self::Popover => "popover",
            Self::Alert => "alert",
            Self::Desktop => "desktop",
            Self::Taskbar => "taskbar",
            Self::SystemTray => "system-tray",
            Self::QuickSettings => "quick-settings",
            Self::NotificationCenter => "notification-center",
            Self::Toolbar => "toolbar",
            Self::Dock => "dock",
            Self::Spotlight => "spotlight",
            Self::MenuBarExtras => "menu-bar-extras",
            Self::SystemTrayOverflow => "system-tray-overflow",
            Self::StartMenu => "start-menu",
            Self::ActionCenter => "action-center",
        }
    }
}
