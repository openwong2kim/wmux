//! `wmux-native claude-hook` as a process: when it hands the run to the Node
//! bridge beside it, and what it does when it cannot. Each case runs a copy
//! of the binary in its own directory, with a sandbox HOME and a `node` on
//! PATH that only records its argv.
#![cfg(unix)]

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{PoisonError, RwLock, RwLockWriteGuard};

const BRIDGE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../integrations/claude/bin/wmux-bridge.mjs"
);

/// Parallel tests write executables and spawn processes. A fork inherits any
/// write descriptor another test still has open until the child execs, and
/// exec of a file open for writing fails with ETXTBSY ("Text file busy"). So
/// creating, writing or copying an executable holds the write lock, and every
/// spawn holds the read lock until the child has exec'd (`Command::spawn`
/// returns only after that).
static EXECUTABLES: RwLock<()> = RwLock::new(());

fn writing_executables() -> RwLockWriteGuard<'static, ()> {
    EXECUTABLES.write().unwrap_or_else(PoisonError::into_inner)
}

fn spawn(command: &mut Command) -> Child {
    let _no_executable_being_written = EXECUTABLES.read().unwrap_or_else(PoisonError::into_inner);
    command.spawn().unwrap()
}

struct Case {
    dir: PathBuf,
}

impl Case {
    /// The binary in a fresh directory; `bridge` is the .mjs beside it.
    fn new(tag: &str, bridge: Option<&[u8]>) -> Case {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("claude-hook-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["bin", "fake-node", "home"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        let _writing = writing_executables();
        std::fs::copy(env!("CARGO_BIN_EXE_wmux-native"), dir.join("bin/wmux-native")).unwrap();
        if let Some(source) = bridge {
            std::fs::write(dir.join("bin/wmux-bridge.mjs"), source).unwrap();
        }
        let node = dir.join("fake-node/node");
        std::fs::write(
            &node,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_NODE_ARGS\"\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        Case { dir }
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)], with_node: bool, stdin: &str) -> Output {
        self.run_with_stderr(args, env, with_node, stdin, Stdio::piped())
    }

    fn run_with_stderr(
        &self,
        args: &[&str],
        env: &[(&str, &str)],
        with_node: bool,
        stdin: &str,
        stderr: Stdio,
    ) -> Output {
        let mut command = self.command(env, with_node);
        command.arg("claude-hook").args(args).stderr(stderr);
        Self::feed(spawn(&mut command), stdin)
    }

    /// The binary with exactly `args`: the form a settings entry carries.
    fn run_argv(&self, args: &[OsString], env: &[(&str, &str)], with_node: bool, stdin: &str) -> Output {
        let mut command = self.command(env, with_node);
        command.args(args).stderr(Stdio::piped());
        Self::feed(spawn(&mut command), stdin)
    }

    /// The binary in the sandbox, with no arguments yet.
    fn command(&self, env: &[(&str, &str)], with_node: bool) -> Command {
        let path = if with_node {
            format!("{}:/usr/bin:/bin", self.dir.join("fake-node").display())
        } else {
            "/usr/bin:/bin".into()
        };
        let mut command = Command::new(self.dir.join("bin/wmux-native"));
        command
            .env_clear()
            .env("PATH", path)
            .env("HOME", self.dir.join("home"))
            .env("WMUX_DATA_SUFFIX", "-claude-hook-test")
            .env("FAKE_NODE_ARGS", self.dir.join("node-args"))
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        command
    }

    fn feed(mut child: Child, stdin: &str) -> Output {
        use std::io::Write;
        let _ = child.stdin.take().unwrap().write_all(stdin.as_bytes());
        child.wait_with_output().unwrap()
    }

    /// What the fake node was called with, None when it never ran.
    fn node_args(&self) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(self.dir.join("node-args")).ok()?;
        Some(text.lines().map(str::to_string).collect())
    }

    /// `outcome` (plus `reason` or `flag`) of each bridge.log line.
    fn log(&self) -> Vec<String> {
        let path = self.dir.join("home/.wmux-claude-hook-test/bridge.log");
        let text = std::fs::read_to_string(path).unwrap_or_default();
        text.lines()
            .map(|line| {
                assert!(line.ends_with(r#","impl":"native"}"#), "{line}");
                let field = |key: &str| {
                    let at = line.find(&format!("\"{key}\":\""))? + key.len() + 4;
                    Some(line[at..].split('"').next().unwrap().to_string())
                };
                let outcome = field("outcome").unwrap();
                match field("reason").or_else(|| field("flag")).or_else(|| field("verdict")) {
                    Some(extra) => format!("{outcome} {extra}"),
                    None => outcome,
                }
            })
            .collect()
    }

    fn bridge(&self) -> String {
        self.dir.join("bin/wmux-bridge.mjs").display().to_string()
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn pinned() -> Vec<u8> {
    std::fs::read(BRIDGE).unwrap()
}

fn quiet(out: &Output) {
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty(), "{}", String::from_utf8_lossy(&out.stdout));
}

#[test]
fn the_kill_switch_env_hands_the_run_to_node_before_anything_else() {
    let case = Case::new("env-switch", Some(&pinned()));
    let out = case.run(&["Stop", "--x"], &[("WMUX_HOOK_RUNTIME", "node")], true, "{}");
    quiet(&out);
    assert_eq!(case.node_args(), Some(vec![case.bridge(), "Stop".into(), "--x".into()]));
    assert!(case.log().is_empty());
}

#[test]
fn the_named_form_hands_over_to_node_before_anything_else() {
    // Even a named bridge that is not the one beside the binary: nothing is
    // compared, logged or created before the hand-over.
    let case = Case::new("env-switch-named", Some(&pinned()));
    let args = ["/elsewhere/wmux-bridge.mjs".into(), "Stop".into(), "--x".into()];
    quiet(&case.run_argv(&args, &[("WMUX_HOOK_RUNTIME", "node")], true, "{}"));
    assert_eq!(case.node_args(), Some(vec![case.bridge(), "Stop".into(), "--x".into()]));
    assert!(!case.dir.join("home/.wmux-claude-hook-test").exists());
}

#[test]
fn the_kill_switch_file_hands_the_run_to_node() {
    let case = Case::new("file-switch", Some(&pinned()));
    std::fs::write(case.dir.join("bin/native-disabled"), b"").unwrap();
    quiet(&case.run(&["Stop"], &[], true, "{}"));
    assert_eq!(case.node_args(), Some(vec![case.bridge(), "Stop".into()]));
}

#[test]
fn the_pinned_bridge_runs_natively() {
    let case = Case::new("native", Some(&pinned()));
    quiet(&case.run(&["Stop"], &[], true, "{}"));
    assert_eq!(case.node_args(), None);
    // No tokens in the sandbox: the native walk has nowhere to send.
    assert_eq!(case.log(), ["no-auth-token"]);
}

#[test]
fn a_bridge_this_port_was_not_made_from_runs_on_node() {
    let mut changed = pinned();
    changed.extend_from_slice(b"// edited\n");
    let case = Case::new("mismatch", Some(&changed));
    quiet(&case.run(&["Stop"], &[], true, "{}"));
    assert_eq!(case.node_args(), Some(vec![case.bridge(), "Stop".into()]));
    assert_eq!(case.log(), ["impl-fallback bridge-sha-mismatch"]);
}

#[test]
fn without_node_a_mismatched_bridge_still_runs_natively() {
    let mut changed = pinned();
    changed.extend_from_slice(b"// edited\n");
    let case = Case::new("mismatch-no-node", Some(&changed));
    quiet(&case.run(&["Stop"], &[], false, "{}"));
    assert_eq!(
        case.log(),
        [
            "impl-fallback bridge-sha-mismatch",
            "impl-fallback node-missing",
            "no-auth-token"
        ]
    );
}

#[test]
fn without_node_the_kill_switch_runs_natively() {
    let case = Case::new("switch-no-node", Some(&pinned()));
    quiet(&case.run(&["Stop"], &[("WMUX_HOOK_RUNTIME", "node")], false, "{}"));
    assert_eq!(case.log(), ["impl-fallback node-missing", "no-auth-token"]);
}

#[test]
fn a_failed_exec_is_not_tried_again() {
    // The kill switch and a stale bridge would each hand over.
    let mut changed = pinned();
    changed.extend_from_slice(b"// edited\n");
    let case = Case::new("exec-once", Some(&changed));
    quiet(&case.run(&["Stop"], &[("WMUX_HOOK_RUNTIME", "node")], false, "{}"));
    assert_eq!(
        case.log(),
        [
            "impl-fallback node-missing",
            "impl-fallback bridge-sha-mismatch",
            "no-auth-token"
        ]
    );
}

#[test]
fn without_a_bridge_beside_it_the_run_stays_native() {
    let case = Case::new("no-bridge", None);
    quiet(&case.run(&["Stop"], &[("WMUX_HOOK_RUNTIME", "node")], true, "{}"));
    assert_eq!(case.node_args(), None);
    assert_eq!(case.log(), ["impl-native-no-bridge", "no-auth-token"]);
}

#[test]
fn an_unknown_event_logs_this_process_argv_and_reads_no_stdin() {
    let case = Case::new("unknown", Some(&pinned()));
    quiet(&case.run(&["Bogus", "--gate"], &[], true, ""));
    let log = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
    let exe = case.dir.join("bin/wmux-native").display().to_string();
    assert!(
        log.contains(&format!(
            r#""hook":"Bogus","outcome":"unknown-hook-name","argv":["{exe}","claude-hook","Bogus","--gate"]"#
        )),
        "{log}"
    );
    assert_eq!(case.node_args(), None);
}

#[test]
fn the_bridge_named_in_argv1_runs_the_claude_hook() {
    let case = Case::new("argv-bridge", Some(&pinned()));
    quiet(&case.run_argv(&[case.bridge().into(), "Stop".into()], &[], true, "{}"));
    assert_eq!(case.node_args(), None);
    assert_eq!(case.log(), ["no-auth-token"]);
}

#[test]
fn the_named_form_hands_over_with_the_node_forms_argv() {
    let case = Case::new("argv-switch", Some(&pinned()));
    let args = [case.bridge().into(), "PreToolUse".into(), "--permission-gate".into()];
    quiet(&case.run_argv(&args, &[("WMUX_HOOK_RUNTIME", "node")], true, "{}"));
    assert_eq!(
        case.node_args(),
        Some(vec![case.bridge(), "PreToolUse".into(), "--permission-gate".into()])
    );
    assert!(case.log().is_empty());
}

#[test]
fn a_named_bridge_reached_through_a_link_is_the_one_beside_it() {
    let case = Case::new("argv-link", Some(&pinned()));
    std::os::unix::fs::symlink(case.dir.join("bin"), case.dir.join("link")).unwrap();
    let named = case.dir.join("link/wmux-bridge.mjs");
    quiet(&case.run_argv(&[named.into(), "Stop".into()], &[], true, "{}"));
    assert_eq!(case.log(), ["no-auth-token"]);
}

#[test]
fn a_named_bridge_in_a_non_utf8_directory_still_dispatches_and_is_noted() {
    let case = Case::new("argv-elsewhere", Some(&pinned()));
    // Not UTF-8, and not the bridge beside the binary: the basename still
    // dispatches, the run uses the bridge beside it, and the difference is noted.
    let named = OsString::from_vec(b"/nonexistent/\xff\xfe/wmux-bridge.mjs".to_vec());
    quiet(&case.run_argv(&[named, "Stop".into()], &[], true, "{}"));
    assert_eq!(case.node_args(), None);
    assert_eq!(case.log(), ["no-auth-token"]);
    let log = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
    assert!(
        log.contains(r#""bridgeNamed":"/nonexistent/"#)
            && log.contains(&format!(r#"/wmux-bridge.mjs","bridgeUsed":"{}""#, case.bridge())),
        "{log}"
    );
}

#[test]
fn another_basename_in_argv1_is_the_usage() {
    let case = Case::new("argv-other", Some(&pinned()));
    let named = format!("{}.bak", case.bridge());
    let out = case.run_argv(&[named.into(), "Stop".into()], &[], true, "{}");
    quiet(&out);
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("usage: wmux-native"));
    assert_eq!(case.node_args(), None);
    assert!(!case.dir.join("home/.wmux-claude-hook-test").exists());
}

#[test]
fn the_self_test_answers_without_reading_stdin_or_logging() {
    let case = Case::new("self-test", Some(&pinned()));
    let mut command = case.command(&[], true);
    command.arg("--self-test").stderr(Stdio::piped());
    let mut child = spawn(&mut command);
    // Held open: a self-test that read stdin would never return.
    let _stdin = child.stdin.take();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "the self-test waited on stdin");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let pin = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/claude-hook.ported-from.sha256")).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!("wmux-claude-hook protocol 1 pin {}\n", pin.trim())
    );
    assert!(out.stderr.is_empty());
    assert!(std::fs::read_dir(case.dir.join("home")).unwrap().next().is_none());
    assert_eq!(case.node_args(), None);
}

/// `depth` levels below the outermost array: `[` × (depth + 1).
fn nested(depth: usize) -> String {
    format!("{}{}", "[".repeat(depth + 1), "]".repeat(depth + 1))
}

#[test]
fn a_payload_at_the_depth_limit_goes_through_every_recursive_path() {
    // PAYLOAD_DEPTH_MAX is 1 500: on the run's 64 MiB stack the payload is
    // cloned (spread, and the unknown-entrypoint strip) and stringified (the
    // envelope); the debug envelope lists its keys.
    let case = Case::new("deep", Some(&pinned()));
    std::fs::create_dir_all(case.dir.join("home/.wmux-claude-hook-test")).unwrap();
    std::fs::write(case.dir.join("home/.wmux-claude-hook-test/daemon-auth-token"), "t").unwrap();
    let in_object = format!(r#"{{"session_id":"s","x":{}}}"#, nested(1_499));
    for (env, payload) in [
        (vec![], nested(1_500)),
        (vec![("CLAUDE_CODE_ENTRYPOINT", "desktop")], in_object.clone()),
        (vec![("WMUX_BRIDGE_DEBUG", "1")], in_object.clone()),
    ] {
        let out = case.run(&["Stop"], &env, true, &payload);
        quiet(&out);
        assert_eq!(case.log().last().unwrap(), "rpc-failed", "{env:?}");
    }
    // One level more is refused before anything is sent.
    quiet(&case.run(&["Stop"], &[], true, &nested(1_501)));
    let log = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
    assert!(
        log.lines()
            .last()
            .unwrap()
            .contains(r#""outcome":"uncaught","error":"RangeError: Maximum call stack size exceeded""#),
        "{log}"
    );
    quiet(&case.run(&["Stop"], &[], true, &nested(200_000)));
    assert_eq!(case.log().last().unwrap(), "uncaught");
}

#[test]
fn after_a_failed_hand_over_a_closed_daemon_socket_is_logged_not_fatal() {
    // A failed exec must leave SIGPIPE ignored: the native run that follows
    // writes to a daemon that closes without reading.
    let case = Case::new("sigpipe", Some(&pinned()));
    let wmux_home = case.dir.join("home/.wmux-claude-hook-test");
    std::fs::create_dir_all(&wmux_home).unwrap();
    std::fs::write(wmux_home.join("daemon-auth-token"), "t").unwrap();
    // sun_path is short: the socket goes under the system temp dir.
    let socket = std::env::temp_dir().join(format!("wmux-sigpipe-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    // It reads part of the request and then closes, so the bridge is still
    // writing when the other end goes away.
    std::thread::spawn(move || {
        use std::io::Read;
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut chunk = [0u8; 64 * 1024];
            let _ = stream.read_exact(&mut chunk);
        }
    });
    let stdin = format!(r#"{{"session_id":"s","pad":"{}"}}"#, "x".repeat(900_000));
    let socket_text = socket.display().to_string();
    for round in 0..20 {
        let out = case.run(
            &["Stop"],
            &[("WMUX_HOOK_RUNTIME", "node"), ("WMUX_PIPE_NAME", &socket_text)],
            false,
            &stdin,
        );
        assert_eq!(out.status.code(), Some(0), "round {round}: {out:?}");
        assert_eq!(case.log().last().unwrap(), "rpc-failed", "round {round}");
    }
    let _ = std::fs::remove_file(&socket);
    assert_eq!(&case.log()[..2], ["impl-fallback node-missing", "rpc-failed"]);
}

#[test]
fn a_broken_stderr_does_not_stop_the_send() {
    // WMUX_BRIDGE_DEBUG writes the envelope to stderr; a stderr nobody reads
    // any more must not end the run before the RPC.
    let case = Case::new("broken-stderr", Some(&pinned()));
    let wmux_home = case.dir.join("home/.wmux-claude-hook-test");
    std::fs::create_dir_all(&wmux_home).unwrap();
    std::fs::write(wmux_home.join("daemon-auth-token"), "t").unwrap();
    let (stderr, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    drop(reader);
    let absent = case.dir.join("absent.sock").display().to_string();
    let out = case.run_with_stderr(
        &["Stop"],
        &[("WMUX_BRIDGE_DEBUG", "1"), ("WMUX_PIPE_NAME", &absent)],
        true,
        r#"{"session_id":"s"}"#,
        Stdio::from(std::os::fd::OwnedFd::from(stderr)),
    );
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(case.log(), ["rpc-failed"]);
}

#[cfg(target_os = "linux")]
#[test]
fn the_hand_over_comes_before_the_run_thread() {
    // An address space too small for the run's own stack: the kill switch
    // still hands over, and without it the run fails open.
    let case = Case::new("no-thread", Some(&pinned()));
    let limited = case.dir.join("limited");
    {
        let _writing = writing_executables();
        std::fs::write(
            &limited,
            format!(
                "#!/bin/sh\nulimit -v 49152 || exit 99\nexec '{}' \"$@\"\n",
                case.dir.join("bin/wmux-native").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&limited, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let run = |env: &[(&str, &str)]| {
        let out = spawn(
            Command::new(&limited)
                .args(["claude-hook", "Stop"])
                .env_clear()
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", case.dir.join("fake-node").display()),
                )
                .env("HOME", case.dir.join("home"))
                .env("WMUX_DATA_SUFFIX", "-claude-hook-test")
                .env("FAKE_NODE_ARGS", case.dir.join("node-args"))
                .envs(env.iter().copied())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .wait_with_output()
        .unwrap();
        quiet(&out);
    };
    run(&[("WMUX_HOOK_RUNTIME", "node")]);
    assert_eq!(case.node_args(), Some(vec![case.bridge(), "Stop".into()]));
    assert!(case.log().is_empty());
    run(&[]);
    assert_eq!(case.log(), ["uncaught"]);
}

#[test]
fn a_missing_bridge_adds_no_line_to_a_run_that_logs_nothing() {
    // A throttled PostToolUse logs nothing, so it does not log the missing
    // bridge either; the first run of the two does.
    let case = Case::new("no-bridge-quiet", None);
    let payload = r#"{"session_id":"s1","tool_name":"Bash"}"#;
    for _ in 0..2 {
        quiet(&case.run(&["PostToolUse"], &[("WMUX_PTY_ID", "pty-1")], true, payload));
    }
    assert_eq!(case.log(), ["impl-native-no-bridge", "no-auth-token"]);
}

#[test]
fn a_named_bridge_adds_no_line_to_a_run_that_logs_nothing() {
    // A throttled PostToolUse logs nothing, so a differing name adds nothing
    // to it either; the first run of the two carries it on its own line.
    let case = Case::new("named-quiet", Some(&pinned()));
    let payload = r#"{"session_id":"s1","tool_name":"Bash"}"#;
    let args = ["/elsewhere/wmux-bridge.mjs".into(), "PostToolUse".into()];
    for _ in 0..2 {
        quiet(&case.run_argv(&args, &[("WMUX_PTY_ID", "pty-1")], true, payload));
    }
    assert_eq!(case.log(), ["no-auth-token"]);
}

#[test]
fn a_differing_name_rides_on_the_runs_own_line() {
    let case = Case::new("named-field", Some(&pinned()));
    quiet(&case.run_argv(&["/elsewhere/wmux-bridge.mjs".into(), "Stop".into()], &[], true, "{}"));
    assert_eq!(case.log(), ["no-auth-token"]);
    let log = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
    assert!(
        log.contains(&format!(
            r#""bridgeNamed":"/elsewhere/wmux-bridge.mjs","bridgeUsed":"{}","impl":"native"}}"#,
            case.bridge()
        )),
        "{log}"
    );
}

#[test]
fn without_a_bridge_beside_it_the_named_one_is_noted_with_none_used() {
    let case = Case::new("named-no-bridge", None);
    quiet(&case.run_argv(&["/elsewhere/wmux-bridge.mjs".into(), "Stop".into()], &[], true, "{}"));
    assert_eq!(case.log(), ["impl-native-no-bridge", "no-auth-token"]);
    let log = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
    assert!(
        log.contains(r#""bridgeNamed":"/elsewhere/wmux-bridge.mjs","impl":"native"}"#),
        "{log}"
    );
    assert!(!log.contains("bridgeUsed"), "{log}");
}

/// A main that answers every request with `{"id", "ok": true, "result"}`;
/// the socket's path, under the system temp dir (sun_path is short).
fn stub_main(tag: &str, result: &'static str) -> String {
    use std::io::{BufRead, BufReader, Write};
    let socket = std::env::temp_dir().join(format!("wmux-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut line = String::new();
            let _ = BufReader::new(&stream).read_line(&mut line);
            let id = line
                .split(r#""id":""#)
                .nth(1)
                .and_then(|r| r.split('"').next())
                .unwrap_or("");
            let _ = writeln!(stream, r#"{{"id":"{id}","ok":true,"result":{result}}}"#);
        }
    });
    socket.display().to_string()
}

/// A case with a daemon token, for a run that sends.
fn with_token(tag: &str) -> Case {
    let case = Case::new(tag, Some(&pinned()));
    let wmux_home = case.dir.join("home/.wmux-claude-hook-test");
    std::fs::create_dir_all(&wmux_home).unwrap();
    std::fs::write(wmux_home.join("daemon-auth-token"), "t").unwrap();
    case
}

#[test]
fn the_permission_gate_answers_here() {
    let case = with_token("perm-deny");
    let socket = stub_main("perm-deny", r#"{"ok":true,"permissionDecision":"deny"}"#);
    let env = [
        ("WMUX_PIPE_NAME", socket.as_str()),
        ("WMUX_PTY_ID", "pty-1"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ];
    let payload = r#"{"session_id":"s1","tool_name":"Bash"}"#;
    let out = case.run(&["PreToolUse", "--permission-gate"], &env, true, payload);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        concat!(
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","#,
            r#""permissionDecisionReason":"denied from the wmux remote approval"}}"#,
            "\n"
        )
    );
    assert_eq!(case.log(), ["ok", "permission-gate deny"]);
    assert_eq!(case.node_args(), None);

    // The reader went away: the verdict is logged, then its loss; exit 0.
    let (stdout, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    drop(reader);
    let mut child = spawn(
        Command::new(case.dir.join("bin/wmux-native"))
            .args(["claude-hook", "PreToolUse", "--permission-gate"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", case.dir.join("home"))
            .env("WMUX_DATA_SUFFIX", "-claude-hook-test")
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(std::os::fd::OwnedFd::from(stdout)))
            .stderr(Stdio::null()),
    );
    use std::io::Write;
    child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0));
    assert_eq!(case.log()[2..], ["ok", "permission-gate deny", "stdout-lost"]);
    let _ = std::fs::remove_file(&socket);
}

/// A gate block from a stub main: (case, the stub's socket).
fn gate_block(tag: &str) -> (Case, String) {
    let case = with_token(tag);
    let socket = stub_main(tag, r#"{"ok":true,"block":{"reason":"wait"}}"#);
    // The gate is main's: main's token.
    std::fs::write(case.dir.join("home/.wmux-claude-hook-test-auth-token"), "m").unwrap();
    (case, socket)
}

#[test]
fn a_gate_block_is_exit_2_even_when_stderr_is_gone() {
    let (case, socket) = gate_block("gate-block");
    let env = [("WMUX_PIPE_NAME", socket.as_str())];
    let out = case.run(&["Stop", "--gate"], &env, true, r#"{"session_id":"s1"}"#);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "wait\n");
    assert!(out.stdout.is_empty());
    assert_eq!(case.log(), ["ok", "gate-blocked"]);

    let (stderr, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    drop(reader);
    let out = case.run_with_stderr(
        &["Stop", "--gate"],
        &env,
        true,
        r#"{"session_id":"s1"}"#,
        Stdio::from(std::os::fd::OwnedFd::from(stderr)),
    );
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(case.log()[2..], ["ok", "gate-blocked", "stderr-lost"]);
    let _ = std::fs::remove_file(&socket);
}

/// The panic hook exists in debug builds only.
#[cfg(debug_assertions)]
#[test]
fn a_gate_block_is_exit_2_even_when_the_run_panics_after_it() {
    let (case, socket) = gate_block("gate-panic");
    let env = [
        ("WMUX_PIPE_NAME", socket.as_str()),
        ("WMUX_CLAUDE_HOOK_PANIC_AFTER_VERDICT", "1"),
    ];
    let out = case.run(&["Stop", "--gate"], &env, true, r#"{"session_id":"s1"}"#);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(case.log(), ["ok", "gate-blocked", "uncaught"]);
    let _ = std::fs::remove_file(&socket);
}

const ALLOW: &str = concat!(
    r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#,
    "\n"
);

/// What a run printed and logged.
#[derive(Clone, Debug, PartialEq)]
struct Seen {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    log: Vec<String>,
}

fn seen(case: &Case, out: Output, before: usize) -> Seen {
    Seen {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        log: case.log()[before..].to_vec(),
    }
}

fn expect(code: i32, stdout: &str, stderr: &str, log: &[&str]) -> Seen {
    Seen {
        code: Some(code),
        stdout: stdout.into(),
        stderr: stderr.into(),
        log: log.iter().map(|l| l.to_string()).collect(),
    }
}

/// Both tokens, for a walk that may address main or the daemon.
fn both_tokens(case: &Case) {
    let home = case.dir.join("home");
    std::fs::create_dir_all(home.join(".wmux-claude-hook-test")).unwrap();
    std::fs::write(home.join(".wmux-claude-hook-test/daemon-auth-token"), "d").unwrap();
    std::fs::write(home.join(".wmux-claude-hook-test-auth-token"), "m").unwrap();
}

#[test]
fn every_decision_runs_here_whatever_the_setup() {
    // One reply holds a refusal, a context and an allow, so each mode's own
    // answer shows. Every setup but a stale bridge with node runs natively.
    let socket = stub_main(
        "matrix",
        r#"{"ok":true,"block":{"reason":"r"},"additionalContext":"c","permissionDecision":"allow"}"#,
    );
    let env = [
        ("WMUX_PIPE_NAME", socket.as_str()),
        ("WMUX_PTY_ID", "pty-1"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ];
    let payload = r#"{"session_id":"s1","prompt":"p","tool_name":"Bash"}"#;
    let rows: [(&[&str], Seen); 8] = [
        (&["Stop", "--gate"], expect(2, "", "r\n", &["ok", "gate-blocked"])),
        (
            &["UserPromptSubmit", "--context"],
            expect(2, "", "r\n", &["ok", "prompt-blocked"]),
        ),
        // --context on another event is no mode: a plain run.
        (&["Stop", "--context"], expect(0, "", "", &["ok"])),
        (
            &["PreToolUse", "--permission-gate"],
            expect(0, ALLOW, "", &["ok", "permission-gate allow"]),
        ),
        // The permission gate's exit 0 wins over a block's 2.
        (
            &["PreToolUse", "--gate", "--permission-gate"],
            expect(0, ALLOW, "r\n", &["ok", "gate-blocked", "permission-gate allow"]),
        ),
        (
            &["UserPromptSubmit", "--context", "--permission-gate"],
            expect(0, ALLOW, "r\n", &["ok", "prompt-blocked", "permission-gate allow"]),
        ),
        (
            &["UserPromptSubmit", "--gate", "--context"],
            expect(2, "", "r\nr\n", &["ok", "gate-blocked", "prompt-blocked"]),
        ),
        (
            &["UserPromptSubmit", "--gate", "--context", "--permission-gate"],
            expect(
                0,
                ALLOW,
                "r\nr\n",
                &["ok", "gate-blocked", "prompt-blocked", "permission-gate allow"],
            ),
        ),
    ];
    let mut stale = pinned();
    stale.extend_from_slice(b"// edited\n");
    let pin = pinned();
    // (tag, the bridge beside the binary, node on PATH, the lines before the run's own)
    let setups = [
        ("pinned", Some(&pin[..]), true, vec![]),
        ("no-bridge", None, true, vec!["impl-native-no-bridge"]),
        ("no-node", Some(&pin[..]), false, vec![]),
        (
            "stale-no-node",
            Some(&stale[..]),
            false,
            vec!["impl-fallback bridge-sha-mismatch", "impl-fallback node-missing"],
        ),
    ];
    for (tag, bridge, with_node, prefix) in setups {
        let case = Case::new(&format!("matrix-{tag}"), bridge);
        both_tokens(&case);
        for (args, row) in &rows {
            let before = case.log().len();
            let mut want = row.clone();
            want.log = prefix
                .iter()
                .map(|l| l.to_string())
                .chain(row.log.iter().cloned())
                .collect();
            let out = case.run(args, &env, with_node, payload);
            assert_eq!(seen(&case, out, before), want, "{tag} {args:?}");
        }
        assert_eq!(case.node_args(), None, "{tag}");
        let all = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
        assert!(!all.contains(concat!("decision", "-unported")), "{tag}");
    }

    // A stale bridge with node: the one setup that still hands decisions over.
    let case = Case::new("matrix-stale-node", Some(&stale));
    both_tokens(&case);
    let out = case.run(&["Stop", "--gate"], &env, true, payload);
    assert_eq!(
        seen(&case, out, 0),
        expect(0, "", "", &["impl-fallback bridge-sha-mismatch"])
    );
    assert_eq!(
        case.node_args(),
        Some(vec![case.bridge(), "Stop".into(), "--gate".into()])
    );
    let _ = std::fs::remove_file(&socket);
}

#[test]
fn each_mode_on_a_run_with_nothing_to_decide() {
    // No token, malformed stdin, and an answer with no decision in it: no
    // block, no stdout, exit 0; only the permission gate logs its no-opinion.
    let socket = stub_main("nothing", r#"{"ok":true}"#);
    let env = [
        ("WMUX_PIPE_NAME", socket.as_str()),
        ("WMUX_PTY_ID", "pty-1"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ];
    let payload = r#"{"session_id":"s1","prompt":"p","tool_name":"Bash"}"#;
    for (args, answered) in [
        (["Stop", "--gate"], &["ok"][..]),
        (["UserPromptSubmit", "--context"], &["ok"][..]),
        (
            ["PreToolUse", "--permission-gate"],
            &["ok", "permission-gate no-opinion"][..],
        ),
    ] {
        let case = Case::new(&format!("nothing-{}", &args[1][2..]), Some(&pinned()));
        let out = case.run(&args, &env, true, payload);
        assert_eq!(seen(&case, out, 0), expect(0, "", "", &["no-auth-token"]), "{args:?}");
        both_tokens(&case);
        let out = case.run(&args, &env, true, "{");
        assert_eq!(seen(&case, out, 1), expect(0, "", "", &["malformed-stdin"]), "{args:?}");
        let out = case.run(&args, &env, true, payload);
        assert_eq!(seen(&case, out, 2), expect(0, "", "", answered), "{args:?}");
    }
    let _ = std::fs::remove_file(&socket);
}
