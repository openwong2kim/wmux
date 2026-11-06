//! `wmux-native claude-hook` as a process: when it hands the run to the Node
//! bridge beside it, and what it does when it cannot. Each case runs a copy
//! of the binary in its own directory, with a sandbox HOME and a `node` on
//! PATH that only records its argv.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const BRIDGE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../integrations/claude/bin/wmux-bridge.mjs"
);

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
        let path = if with_node {
            format!("{}:/usr/bin:/bin", self.dir.join("fake-node").display())
        } else {
            "/usr/bin:/bin".into()
        };
        let mut child = Command::new(self.dir.join("bin/wmux-native"))
            .arg("claude-hook")
            .args(args)
            .env_clear()
            .env("PATH", path)
            .env("HOME", self.dir.join("home"))
            .env("WMUX_DATA_SUFFIX", "-claude-hook-test")
            .env("FAKE_NODE_ARGS", self.dir.join("node-args"))
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .unwrap();
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
                match field("reason").or_else(|| field("flag")) {
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
    // Kill switch, a stale bridge and a decision flag would each hand over.
    let mut changed = pinned();
    changed.extend_from_slice(b"// edited\n");
    let case = Case::new("exec-once", Some(&changed));
    let args = ["UserPromptSubmit", "--context"];
    quiet(&case.run(&args, &[("WMUX_HOOK_RUNTIME", "node")], false, "{}"));
    assert_eq!(
        case.log(),
        [
            "impl-fallback node-missing",
            "impl-fallback bridge-sha-mismatch",
            "decision-unported --context",
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
fn decision_flags_run_on_node() {
    let case = Case::new("decision", Some(&pinned()));
    for args in [vec!["UserPromptSubmit", "--context"]] {
        let _ = std::fs::remove_file(case.dir.join("node-args"));
        quiet(&case.run(&args, &[], true, ""));
        let expected: Vec<String> = std::iter::once(case.bridge())
            .chain(args.iter().map(|a| a.to_string()))
            .collect();
        assert_eq!(case.node_args(), Some(expected), "{args:?}");
    }
    assert!(case.log().is_empty());
}

#[test]
fn a_decision_flag_with_no_bridge_or_no_node_fails_open() {
    // Only the decision fails open: exit 0 and an empty stdout (the gate
    // allows, the prompt runs, the tool goes through the session's own
    // permission flow). The run itself goes on as a plain one: the signal is
    // sent, and a lifecycle capture that did not land is spooled.
    for (args, payload, kind, spooled) in [(
        ["UserPromptSubmit", "--context"],
        r#"{"session_id":"s1","prompt":"p"}"#,
        "agent.user_prompt_submit",
        true,
    )] {
        let case = Case::new(&format!("decision-{}", &args[1][2..]), None);
        let wmux_home = case.dir.join("home/.wmux-claude-hook-test");
        std::fs::create_dir_all(&wmux_home).unwrap();
        std::fs::write(wmux_home.join("daemon-auth-token"), "t").unwrap();
        let absent = case.dir.join("absent.sock").display().to_string();
        let env = [
            ("WMUX_PIPE_NAME", absent.as_str()),
            ("WMUX_PTY_ID", "pty-1"),
            ("WMUX_BRIDGE_DEBUG", "1"),
        ];
        let out = case.run(&args, &env, true, payload);
        quiet(&out);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains(&format!(r#""kind":"{kind}""#)), "{args:?}: {stderr}");
        let mut expected = vec![
            "impl-native-no-bridge".to_string(),
            format!("decision-unported {}", args[1]),
            "rpc-failed".to_string(),
        ];
        if spooled {
            expected.push("resume-spooled".into());
        }
        assert_eq!(case.log(), expected, "{args:?}");
        assert_eq!(case.node_args(), None);
    }

    let no_node = Case::new("decision-no-node", Some(&pinned()));
    quiet(&no_node.run(&["UserPromptSubmit", "--context"], &[], false, "{}"));
    assert_eq!(
        no_node.log(),
        [
            "impl-fallback node-missing",
            "decision-unported --context",
            "no-auth-token"
        ]
    );
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

/// `depth` levels below the outermost array: `[` × (depth + 1).
fn nested(depth: usize) -> String {
    format!("{}{}", "[".repeat(depth + 1), "]".repeat(depth + 1))
}

#[test]
fn a_payload_at_the_depth_limit_goes_through_every_recursive_path() {
    // PAYLOAD_DEPTH_MAX is 10 000: on the run's 64 MiB stack the payload is
    // cloned (spread, and the unknown-entrypoint strip) and stringified (the
    // envelope); the debug envelope lists its keys.
    let case = Case::new("deep", Some(&pinned()));
    std::fs::create_dir_all(case.dir.join("home/.wmux-claude-hook-test")).unwrap();
    std::fs::write(case.dir.join("home/.wmux-claude-hook-test/daemon-auth-token"), "t").unwrap();
    let in_object = format!(r#"{{"session_id":"s","x":{}}}"#, nested(9_999));
    for (env, payload) in [
        (vec![], nested(10_000)),
        (vec![("CLAUDE_CODE_ENTRYPOINT", "desktop")], in_object.clone()),
        (vec![("WMUX_BRIDGE_DEBUG", "1")], in_object.clone()),
    ] {
        let out = case.run(&["Stop"], &env, true, &payload);
        quiet(&out);
        assert_eq!(case.log().last().unwrap(), "rpc-failed", "{env:?}");
    }
    // One level more is refused before anything is sent.
    quiet(&case.run(&["Stop"], &[], true, &nested(10_001)));
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
    std::fs::write(
        &limited,
        format!(
            "#!/bin/sh\nulimit -v 49152 || exit 99\nexec '{}' \"$@\"\n",
            case.dir.join("bin/wmux-native").display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&limited, std::fs::Permissions::from_mode(0o755)).unwrap();
    let run = |env: &[(&str, &str)]| {
        let out = Command::new(&limited)
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
            .output()
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
    assert_eq!(case.log(), ["ok", "permission-gate"]);
    assert_eq!(case.node_args(), None);

    // The reader went away: the verdict is logged, then its loss; exit 0.
    let (stdout, reader) = std::os::unix::net::UnixStream::pair().unwrap();
    drop(reader);
    let child = Command::new(case.dir.join("bin/wmux-native"))
        .args(["claude-hook", "PreToolUse", "--permission-gate"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", case.dir.join("home"))
        .env("WMUX_DATA_SUFFIX", "-claude-hook-test")
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(std::os::fd::OwnedFd::from(stdout)))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    use std::io::Write;
    let mut child = child;
    child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0));
    assert_eq!(case.log()[2..], ["ok", "permission-gate", "stdout-lost"]);
    let _ = std::fs::remove_file(&socket);
}

#[test]
fn a_gate_block_is_exit_2_even_when_the_run_panics_or_stderr_is_gone() {
    let case = with_token("gate-block");
    let socket = stub_main("gate-block", r#"{"ok":true,"block":{"reason":"wait"}}"#);
    // The gate is main's: main's token.
    std::fs::write(case.dir.join("home/.wmux-claude-hook-test-auth-token"), "m").unwrap();
    let env = [("WMUX_PIPE_NAME", socket.as_str())];
    let out = case.run(&["Stop", "--gate"], &env, true, r#"{"session_id":"s1"}"#);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "wait\n");
    assert!(out.stdout.is_empty());
    assert_eq!(case.log(), ["ok", "gate-blocked"]);

    // Test-only (debug builds): a panic right after the verdict.
    let panics = [
        ("WMUX_PIPE_NAME", socket.as_str()),
        ("WMUX_CLAUDE_HOOK_PANIC_AFTER_VERDICT", "1"),
    ];
    let out = case.run(&["Stop", "--gate"], &panics, true, r#"{"session_id":"s1"}"#);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(case.log()[2..], ["ok", "gate-blocked", "uncaught"]);

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
    assert_eq!(case.log()[5..], ["ok", "gate-blocked", "stderr-lost"]);
    let _ = std::fs::remove_file(&socket);
}
