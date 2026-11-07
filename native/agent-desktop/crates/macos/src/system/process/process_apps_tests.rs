use super::*;
use agent_desktop_core::ProcessId;

#[test]
fn app_name_from_command_extracts_app_bundle_name() {
    assert_eq!(
        app_name_from_command("/Applications/Finder.app/Contents/MacOS/Finder").as_deref(),
        Some("Finder")
    );
}

#[test]
fn app_name_from_command_rejects_framework_helpers() {
    assert_eq!(
        app_name_from_command(
            "/Applications/Foo.app/Contents/Frameworks/Foo Helper.app/Contents/MacOS/Foo Helper",
        ),
        None
    );
}

#[test]
fn app_name_from_command_rejects_plugin_helpers() {
    assert_eq!(
        app_name_from_command(
            "/Applications/Foo.app/Contents/PlugIns/Foo Plugin.app/Contents/MacOS/Foo Plugin",
        ),
        None
    );
}

#[test]
fn app_name_from_command_rejects_xpc_services() {
    assert_eq!(
        app_name_from_command("/Applications/Foo.app/Contents/XPCServices/Worker.xpc/Worker"),
        None
    );
}

#[test]
fn app_name_from_command_rejects_app_extensions() {
    assert_eq!(
        app_name_from_command("/Applications/Foo.app/Contents/PlugIns/Share.appex/Share"),
        None
    );
}

#[test]
fn app_name_from_command_rejects_empty_app_name() {
    assert_eq!(
        app_name_from_command("/Applications/.app/Contents/MacOS/Foo"),
        None
    );
}

fn apps_from(commands: &[(i32, &str)]) -> Vec<AppInfo> {
    commands
        .iter()
        .filter_map(|(pid, command)| app_from_command(*pid, command.as_bytes()).unwrap())
        .collect()
}

#[test]
fn expired_deadline_is_rejected_before_reading_processes() {
    let error = list_apps_until(Instant::now()).unwrap_err();

    assert_eq!(error.code.as_str(), "TIMEOUT");
}

#[test]
fn app_command_produces_an_unidentified_app_record() {
    let app = app_from_command(42, b"/Applications/Mail.app/Contents/MacOS/Mail")
        .unwrap()
        .unwrap();

    assert_eq!(app.name, "Mail");
    assert_eq!(app.pid, ProcessId::new(42));
    assert!(app.bundle_id.is_none());
    assert!(app.process_instance.is_none());
}

#[test]
fn non_app_processes_produce_no_records() {
    assert!(apps_from(&[(1, "/sbin/launchd"), (2, "/usr/libexec/logd"), (3, "-zsh")]).is_empty());
}

#[test]
fn rewritten_commands_that_cannot_name_an_app_are_skipped() {
    for command in [
        "/Applications/.app/Contents/MacOS/Foo",
        "/Applications/Foo.app/Contents/XPCServices/Bar.app/Contents/MacOS/Bar",
        "2BUA8C4S2C.com.example.helper",
    ] {
        assert!(app_from_command(42, command.as_bytes()).unwrap().is_none());
    }
}

#[test]
fn non_utf8_command_is_skipped_without_failing_the_inventory() {
    let command = b"/tmp/\xffZ.app/Contents/MacOS/Z";

    assert!(app_from_command(42, command).unwrap().is_none());
}

#[test]
fn non_positive_pid_is_skipped() {
    let command = b"/Applications/Mail.app/Contents/MacOS/Mail";

    assert!(app_from_command(0, command).unwrap().is_none());
    assert!(app_from_command(-1, command).unwrap().is_none());
}

#[test]
fn inaccessible_cross_uid_process_is_skipped() {
    let apps = apps_from(&[
        (42, "/Applications/Visible.app/Contents/MacOS/Visible"),
        (43, "/Applications/Private.app/Contents/MacOS/Private"),
    ]);
    let enriched = enrich_process_instances(apps, |pid| {
        if pid == 43 {
            Err(
                AdapterError::new(ErrorCode::PermDenied, "permission denied").with_details(
                    serde_json::json!({
                        "kind": "process_identity_permission",
                        "retryable": false,
                    }),
                ),
            )
        } else {
            Ok(Some(format!("instance-{pid}")))
        }
    })
    .unwrap();

    assert_eq!(enriched.len(), 1);
    assert_eq!(enriched[0].name, "Visible");
    assert_eq!(enriched[0].process_instance.as_deref(), Some("instance-42"));
}

#[test]
fn process_that_exits_during_identity_enrichment_is_skipped() {
    let apps = apps_from(&[
        (42, "/Applications/Visible.app/Contents/MacOS/Visible"),
        (43, "/Applications/Exited.app/Contents/MacOS/Exited"),
    ]);
    let enriched = enrich_process_instances(apps, |pid| {
        if pid == 43 {
            Ok(None)
        } else {
            Ok(Some(format!("instance-{pid}")))
        }
    })
    .unwrap();

    assert_eq!(enriched.len(), 1);
    assert_eq!(enriched[0].name, "Visible");
}

#[test]
fn process_identity_failure_other_than_cross_uid_permission_is_not_hidden() {
    let apps = apps_from(&[(42, "/Applications/Broken.app/Contents/MacOS/Broken")]);
    let error = enrich_process_instances(apps, |_| {
        Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "identity unavailable",
        ))
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}
