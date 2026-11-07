#![cfg(target_os = "macos")]

use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::net::UnixListener;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MARKER: &str = "AGENT_DESKTOP_INTERNAL_COMMAND_HOST";
const SIGKILL: i32 = 9;

static HOST_TEST_LOCK: Mutex<()> = Mutex::new(());

struct KilledOnDrop(Child);

impl Drop for KilledOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn private_dir(label: &str) -> PathBuf {
    let path = PathBuf::from(format!("/tmp/adh-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .expect("create private dir");
    path
}

fn run(args: &[&str], tmpdir: &Path) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-desktop"))
        .args(args)
        .env("TMPDIR", tmpdir)
        .env("AGENT_DESKTOP_HOME", tmpdir.join("home"))
        .env_remove(MARKER)
        .stdin(Stdio::null())
        .output()
        .expect("binary runs");
    assert!(output.status.success(), "{args:?}: {output:?}");
    output
}

fn spawn_renamed_copy(tmpdir: &Path, name: &str, marked: bool, args: &[&str]) -> KilledOnDrop {
    let executable = tmpdir.join(name);
    std::fs::copy(env!("CARGO_BIN_EXE_agent-desktop"), &executable).expect("copy binary");
    let mut command = Command::new(&executable);
    command
        .args(args)
        .env("TMPDIR", tmpdir)
        .env("AGENT_DESKTOP_HOME", tmpdir.join("home"))
        .env_remove(MARKER)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if marked {
        command.env(MARKER, "1");
    }
    KilledOnDrop(command.spawn().expect("copy starts"))
}

fn exit_within(child: &mut KilledOnDrop, limit: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(status) = child.0.try_wait().expect("poll child") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn commands_never_reach_or_remove_a_command_host_socket() {
    let _lock = HOST_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmpdir = private_dir("socket");
    let uid = std::fs::metadata(&tmpdir).expect("stat tmpdir").uid();
    let host_dir = tmpdir.join(format!("agent-desktop-host-{uid}"));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&host_dir)
        .expect("create host dir");
    let socket = host_dir.join("0123456789abcdef.sock");
    let listener = UnixListener::bind(&socket).expect("bind decoy socket");
    listener.set_nonblocking(true).expect("nonblocking");

    run(&["version"], &tmpdir);
    run(&["list-apps"], &tmpdir);
    run(&["batch", r#"[{"command":"version"}]"#], &tmpdir);

    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "a command connected to the host socket"
    );
    assert!(socket.exists(), "a command removed the socket file");
    let entries: Vec<_> = std::fs::read_dir(&host_dir)
        .expect("read host dir")
        .map(|entry| entry.expect("read host entry").path())
        .collect();
    assert_eq!(entries, vec![socket], "a command created host files");
    let _ = std::fs::remove_dir_all(&tmpdir);
}

#[test]
fn a_call_stops_marked_processes_under_any_name_and_leaves_others_running() {
    let _lock = HOST_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmpdir = private_dir("marker");
    let mut marked = spawn_renamed_copy(&tmpdir, "renamed-host", true, &["wait", "10000"]);
    let mut unmarked = spawn_renamed_copy(&tmpdir, "ordinary-copy", false, &["wait", "10000"]);

    run(&["version"], &tmpdir);

    let status = exit_within(&mut marked, Duration::from_secs(3)).expect("marked copy survived");
    assert_eq!(status.signal(), Some(SIGKILL), "{status}");
    assert!(
        exit_within(&mut unmarked, Duration::from_secs(1)).is_none(),
        "a process without the marker was stopped"
    );
    let _ = std::fs::remove_dir_all(&tmpdir);
}

#[test]
fn a_marked_copy_running_version_exits_successfully() {
    let _lock = HOST_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmpdir = private_dir("self");
    let mut marked = spawn_renamed_copy(&tmpdir, "agent-desktop", true, &["version"]);

    let status =
        exit_within(&mut marked, Duration::from_secs(3)).expect("marked version copy did not exit");
    assert!(status.success(), "marked version copy failed: {status}");
    assert_eq!(status.signal(), None, "marked version copy was killed");
    let _ = std::fs::remove_dir_all(&tmpdir);
}

#[test]
#[ignore = "helper process spawned by a_marked_process_that_is_not_agent_desktop_survives_a_call"]
fn marked_process_helper_sleeps() {
    std::thread::sleep(Duration::from_secs(10));
}

#[test]
fn a_marked_process_that_is_not_agent_desktop_survives_a_call() {
    let _lock = HOST_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmpdir = private_dir("foreign");
    let mut foreign = KilledOnDrop(
        Command::new(std::env::current_exe().expect("test binary path"))
            .args([
                "--ignored",
                "--exact",
                "marked_process_helper_sleeps",
                "--nocapture",
            ])
            .env(MARKER, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("helper starts"),
    );
    std::thread::sleep(Duration::from_millis(500));

    run(&["version"], &tmpdir);

    assert!(
        exit_within(&mut foreign, Duration::from_secs(1)).is_none(),
        "a marked process that is not agent-desktop was stopped"
    );
    let _ = std::fs::remove_dir_all(&tmpdir);
}
