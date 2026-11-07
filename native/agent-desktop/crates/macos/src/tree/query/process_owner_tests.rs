use super::*;

#[test]
fn process_owner_surfaces_require_saved_process_identity_before_tree_read() {
    let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
    let window = agent_desktop_core::WindowInfo {
        id: String::new(),
        title: String::new(),
        app: "Fixture".into(),
        pid: agent_desktop_core::ProcessId::try_from(pid).expect("test pid is positive"),
        process_instance: None,
        bounds: None,
        state: agent_desktop_core::WindowState::default(),
    };

    for surface in [SnapshotSurface::Window, SnapshotSurface::MenuBarExtras] {
        let mut request = ObservationRequest::snapshot(
            &agent_desktop_core::TreeOptions::default(),
            agent_desktop_core::Deadline::after(1_000).unwrap(),
        );
        request.surface = surface;
        let error = observe_tree(ObservationRoot::Window(&window), &request)
            .expect_err("process-owner observation without saved identity must fail closed");

        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(
            error.message,
            "Application has no process instance identity"
        );
    }
}
