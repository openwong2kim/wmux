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
    quiet(&case.run(&["Stop", "--gate"], &[("WMUX_HOOK_RUNTIME", "node")], false, "{}"));
    assert_eq!(
        case.log(),
        [
            "impl-fallback node-missing",
            "impl-fallback bridge-sha-mismatch",
            "decision-unported --gate"
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
    for args in [
        vec!["Stop", "--gate"],
        vec!["PreToolUse", "--permission-gate"],
        vec!["UserPromptSubmit", "--context"],
    ] {
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
    // Exit 0 and an empty stdout: the gate allows, the prompt runs, the tool
    // goes through the session's own permission flow.
    let no_bridge = Case::new("decision-no-bridge", None);
    for (args, flag) in [
        (["Stop", "--gate"], "--gate"),
        (["PreToolUse", "--permission-gate"], "--permission-gate"),
        (["UserPromptSubmit", "--context"], "--context"),
    ] {
        let out = no_bridge.run(&args, &[], true, "{}");
        quiet(&out);
        assert!(out.stderr.is_empty());
        assert_eq!(no_bridge.log().last().unwrap(), &format!("decision-unported {flag}"));
    }
    assert_eq!(no_bridge.node_args(), None);

    let no_node = Case::new("decision-no-node", Some(&pinned()));
    quiet(&no_node.run(&["Stop", "--gate"], &[], false, "{}"));
    assert_eq!(
        no_node.log(),
        ["impl-fallback node-missing", "decision-unported --gate"]
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

#[test]
fn a_payload_deeper_than_the_limit_is_refused_and_exits_0() {
    let case = Case::new("deep", Some(&pinned()));
    std::fs::create_dir_all(case.dir.join("home/.wmux-claude-hook-test")).unwrap();
    std::fs::write(case.dir.join("home/.wmux-claude-hook-test/daemon-auth-token"), "t").unwrap();
    let ok = format!("{}{}", "[".repeat(5000), "]".repeat(5000));
    quiet(&case.run(&["Stop"], &[], true, &ok));
    assert_eq!(case.log().last().unwrap(), "rpc-failed");
    let deep = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
    quiet(&case.run(&["Stop"], &[], true, &deep));
    let log = std::fs::read_to_string(case.dir.join("home/.wmux-claude-hook-test/bridge.log")).unwrap();
    assert!(
        log.lines()
            .last()
            .unwrap()
            .contains(r#""outcome":"uncaught","error":"RangeError: Maximum call stack size exceeded""#),
        "{log}"
    );
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
