//! The process contract of the binary itself: whatever argv a host passes, a
//! hook command never blocks the agent. Exit 2 means "block" to Claude Code,
//! Gemini CLI and Qwen Code, so no argv may produce it.

use std::process::{Command, Stdio};

fn run(args: &[&std::ffi::OsStr]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_wmux-native"))
        .args(args)
        .env("HOME", env!("CARGO_TARGET_TMPDIR"))
        .env("USERPROFILE", env!("CARGO_TARGET_TMPDIR"))
        .env("WMUX_DATA_SUFFIX", "-cli-test")
        .env_remove("WMUX_PIPE_NAME")
        .stdin(Stdio::null())
        .output()
        .expect("spawn wmux-native")
}

#[test]
fn an_unknown_argv_exits_0_with_usage_on_stderr() {
    for args in [vec![], vec!["hok"], vec!["mcp-shimx", "--port", "1"], vec!["-x"]] {
        let args: Vec<&std::ffi::OsStr> = args.iter().map(std::ffi::OsStr::new).collect();
        let out = run(&args);
        assert_eq!(out.status.code(), Some(0), "{args:?}");
        assert!(out.stdout.is_empty(), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("usage: wmux-native hook"),
            "{args:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_non_utf8_subcommand_exits_0() {
    use std::os::unix::ffi::OsStrExt;
    let out = run(&[std::ffi::OsStr::from_bytes(b"h\xffook")]);
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty());
}

// The installer writes `<wmux-native> <bridge path> <flavour> <Event>`, the
// Node form's argv with the binary in front, so older wmux builds still
// recognise the entry. That argv runs the hook subcommand.
#[test]
fn a_bridge_path_in_place_of_the_subcommand_runs_the_hook() {
    let home = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-bridge-path");
    let _ = std::fs::create_dir_all(&home);
    let log = home.join(".wmux-cli-test").join("qwen-hooks.log");
    for bridge in [
        "/home/u/.wmux/hooks/wmux-hooks-bridge.mjs",
        r"C:\Users\u\.wmux\hooks\wmux-hooks-bridge.mjs",
    ] {
        let _ = std::fs::remove_file(&log);
        let out = Command::new(env!("CARGO_BIN_EXE_wmux-native"))
            .args([bridge, "qwen", "Stop"])
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("WMUX_DATA_SUFFIX", "-cli-test")
            .env("WMUX_PTY_ID", "pty-1")
            .env_remove("WMUX_PIPE_NAME")
            .stdin(Stdio::null())
            .output()
            .expect("spawn wmux-native");
        assert_eq!(out.status.code(), Some(0), "{bridge}");
        assert!(out.stdout.is_empty() && out.stderr.is_empty(), "{bridge}");
        let line = std::fs::read_to_string(&log).unwrap_or_default();
        assert!(
            line.contains(r#""flavour":"qwen""#) && line.contains(r#""runtime":"native""#),
            "{bridge}: {line}"
        );
    }
}

#[test]
fn version_and_help_print_to_stdout() {
    let version = run(&[std::ffi::OsStr::new("--version")]);
    assert_eq!(version.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&version.stdout).contains("wmux-managed: native-hooks"));
    let help = run(&[std::ffi::OsStr::new("--help")]);
    assert_eq!(help.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&help.stdout).contains("usage: wmux-native hook"));
}
