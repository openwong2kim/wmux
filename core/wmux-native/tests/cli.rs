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
    for args in [vec![], vec!["hok"], vec!["mcp-shim", "--port", "1"], vec!["-x"]] {
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

#[test]
fn version_and_help_print_to_stdout() {
    let version = run(&[std::ffi::OsStr::new("--version")]);
    assert_eq!(version.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&version.stdout).contains("wmux-managed: native-hooks"));
    let help = run(&[std::ffi::OsStr::new("--help")]);
    assert_eq!(help.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&help.stdout).contains("usage: wmux-native hook"));
}
