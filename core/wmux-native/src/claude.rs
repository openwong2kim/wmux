//! Core of the Claude hook bridge, integrations/claude/bin/wmux-bridge.mjs:
//! its walk policies, target resolution, stdin parsing and bridge.log.
//! The characterisation cases in #3134 pin this behaviour; they live in
//! integrations/claude/__tests__/fixtures/claude-hook/cases, and each test
//! below names the cases it mirrors.
//!
//! claude_hook.rs drives it.

use crate::fsx;
use crate::hook::{iso_time, now_ms};
use crate::js::{self, decode_utf8_trimmed, JsStr, Json};
use crate::paths;
use crate::rpc::{Target, WalkPolicy};
use crate::targets;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// Literals of wmux-bridge.mjs; `constants_match_the_bridge` reads them back.
/// BRIDGE_VERSION, stamped on every bridge.log line.
pub const BRIDGE_VERSION: &str = "0.8.1";
/// HOOK_TIMEOUT_MS: the whole walk's budget.
const HOOK_TIMEOUT: Duration = Duration::from_millis(2000);
/// GATE_PERMISSION_TIMEOUT_MS: longer than the daemon's own gate deadline.
/// The hook declares no timeout, so Claude Code's default applies; the
/// bridge's own comment puts it at 600 s, which is not verified here.
const GATE_PERMISSION_TIMEOUT: Duration = Duration::from_millis(130_000);
/// BRIDGE_LOG_MAX_BYTES.
const BRIDGE_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// sendToTargets in wmux-bridge.mjs: one deadline shared by every target,
/// never sliced, and a request that was written is never sent elsewhere.
pub const CLAUDE_POLICY: WalkPolicy = WalkPolicy {
    budget: HOOK_TIMEOUT,
    slice_per_target: false,
    resend_after_write: &[],
};

/// The same walk for `--permission-gate`, which waits for a phone's answer.
pub const PERMISSION_GATE_POLICY: WalkPolicy = WalkPolicy {
    budget: GATE_PERMISSION_TIMEOUT,
    ..CLAUDE_POLICY
};

/// resolveTargets. Without an override: the daemon then main, except in gate
/// and context mode, which talk to main only (the daemon has no brain lane).
/// WMUX_PIPE_NAME collapses the walk to that one pipe, addressed by mode:
/// to the daemon with the daemon's token first, or in gate and context mode
/// to main with main's token first.
pub fn resolve_targets(gate_mode: bool) -> Vec<Target> {
    let Some(pipe) = targets::pipe_override() else {
        return targets::default_walk(!gate_mode);
    };
    let (name, method, token) = if gate_mode {
        (
            "main",
            targets::MAIN_METHOD,
            targets::main_token().or_else(targets::daemon_token),
        )
    } else {
        (
            "daemon",
            targets::DAEMON_METHOD,
            targets::daemon_token().or_else(targets::main_token),
        )
    };
    token
        .map(|token| Target {
            name,
            pipe,
            token,
            method,
        })
        .into_iter()
        .collect()
}

/// readStdin's parse: lossy UTF-8, JS trim (a BOM goes, U+0085 stays), then
/// JSON.parse. Empty input is `None`; a literal `null` is `Some(Json::Null)`,
/// which the caller treats as empty too.
pub fn parse_stdin(bytes: &[u8]) -> Result<Option<Json>, ()> {
    let text = decode_utf8_trimmed(bytes);
    if text.is_empty() {
        return Ok(None);
    }
    js::parse(&text).map(Some)
}

/// One bridge.log line: `JSON.stringify({ts, bridge, pid, hook, outcome,
/// ...extra})`. A key in `extra` that is already there keeps its place and
/// takes the new value, as object spread does; `None` is `undefined`, which
/// JSON.stringify leaves out. The object is stringified as V8 orders it
/// (index-like keys first). `hook` is the event argument, `"?"` when absent.
/// `"impl":"native"` closes every line, so a log tells the two bridges apart.
pub fn log_line(ts_ms: u64, pid: u32, hook: Option<&[u16]>, outcome: &str, extra: Vec<(&str, Option<Json>)>) -> String {
    let mut fields: Vec<(&str, Option<Json>)> = vec![
        ("ts", Some(Json::Str(js::js(&iso_time(ts_ms))))),
        ("bridge", Some(Json::Str(js::js(BRIDGE_VERSION)))),
        ("pid", Some(Json::Num(f64::from(pid)))),
        (
            "hook",
            Some(Json::Str(hook.map_or_else(|| js::js("?"), <[u16]>::to_vec))),
        ),
        ("outcome", Some(Json::Str(js::js(outcome)))),
    ];
    for (key, value) in extra {
        match fields.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => fields.push((key, value)),
        }
    }
    // The native bridge marks its lines, after everything Node would write.
    fields.push(("impl", Some(Json::Str(js::js("native")))));
    let object = Json::Obj(
        fields
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (js::js(k), v)))
            .collect(),
    );
    let mut line = String::new();
    js::stringify(&object, &mut line);
    line
}

static LOG_ROTATION_CHECKED: AtomicBool = AtomicBool::new(false);

/// logEvent: append one line to `<wmux home>/bridge.log`, creating the home
/// (0700) when missing and rotating the log at most once per process.
/// Best-effort: nothing here fails the hook.
pub fn log_event(hook: Option<&JsStr>, outcome: &str, extra: Vec<(&str, Option<Json>)>) {
    let line = log_line(now_ms(), std::process::id(), hook.map(Vec::as_slice), outcome, extra);
    write_log(
        &paths::wmux_home_dir(),
        &line,
        &LOG_ROTATION_CHECKED,
        BRIDGE_LOG_MAX_BYTES,
    );
}

fn write_log(dir: &str, line: &str, rotation_checked: &AtomicBool, max_bytes: u64) {
    fsx::ensure_dir(dir, 0o700);
    let path = paths::join(&[dir, "bridge.log"]);
    if !rotation_checked.swap(true, Ordering::Relaxed) {
        fsx::rotate_if_over(&path, max_bytes);
    }
    let _ = fsx::append(&path, format!("{line}\n").as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::js;
    use crate::targets::{DAEMON_METHOD, MAIN_METHOD};
    use crate::testenv;

    // ----- lockstep with the bridge ------------------------------------------

    /// The right-hand side of `const <name> = …;` in wmux-bridge.mjs, which
    /// must declare it exactly once at the start of a line.
    fn bridge_literal(name: &str) -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../integrations/claude/bin/wmux-bridge.mjs"
        );
        let source = std::fs::read_to_string(path).expect("wmux-bridge.mjs");
        let prefix = format!("const {name} = ");
        let found: Vec<&str> = source.lines().filter_map(|l| l.strip_prefix(&prefix)).collect();
        assert_eq!(found.len(), 1, "{name} is declared {} times", found.len());
        found[0].split(';').next().unwrap().trim().to_string()
    }

    /// `2000`, `130_000` or `5 * 1024 * 1024`.
    fn bridge_number(name: &str) -> u64 {
        bridge_literal(name)
            .split('*')
            .map(|part| part.trim().replace('_', "").parse::<u64>().expect(name))
            .product()
    }

    #[test]
    fn constants_match_the_bridge() {
        assert_eq!(bridge_literal("BRIDGE_VERSION"), format!("'{BRIDGE_VERSION}'"));
        assert_eq!(bridge_number("HOOK_TIMEOUT_MS"), HOOK_TIMEOUT.as_millis() as u64);
        assert_eq!(
            bridge_number("GATE_PERMISSION_TIMEOUT_MS"),
            GATE_PERMISSION_TIMEOUT.as_millis() as u64
        );
        assert_eq!(bridge_number("BRIDGE_LOG_MAX_BYTES"), BRIDGE_LOG_MAX_BYTES);
    }

    // ----- stdin -------------------------------------------------------------

    fn parsed(bytes: &[u8]) -> String {
        let mut out = String::new();
        js::stringify(&parse_stdin(bytes).unwrap().unwrap(), &mut out);
        out
    }

    #[test]
    fn stdin_is_trimmed_the_js_way() {
        // stdin-empty, stdin-whitespace-only, stdin-bom-and-whitespace,
        // stdin-nel-not-trimmed, stdin-malformed, stdin-null-literal
        assert_eq!(parse_stdin(b"").unwrap(), None);
        assert_eq!(parse_stdin(b" \n\t\r\n ").unwrap(), None);
        assert_eq!(
            parsed("\u{feff} \n{\"session_id\":\"s1\"}\r\n ".as_bytes()),
            r#"{"session_id":"s1"}"#
        );
        assert!(parse_stdin("\u{85}{\"session_id\":\"s1\"}".as_bytes()).is_err());
        assert!(parse_stdin(b"{\"a\":").is_err());
        assert_eq!(parse_stdin(b"null").unwrap(), Some(Json::Null));
    }

    #[test]
    fn stdin_values_survive_as_node_reserialises_them() {
        // stdin-invalid-utf8
        let mut bad = b"{\"bad\":\"".to_vec();
        bad.extend([0xff, 0xfe, 0xc3]);
        bad.extend(b"\"}");
        assert_eq!(parsed(&bad), "{\"bad\":\"\u{fffd}\u{fffd}\u{fffd}\"}");
        // stdin-lone-surrogates
        assert_eq!(
            parsed(br#"{"hi":"\ud800","lo":"x\udc00y","pair":"\ud83d\ude00"}"#),
            "{\"hi\":\"\\ud800\",\"lo\":\"x\\udc00y\",\"pair\":\"\u{1f600}\"}"
        );
        // stdin-duplicate-keys
        assert_eq!(
            parsed(br#"{"a":1,"session_id":"s1","b":2,"a":3}"#),
            r#"{"a":3,"session_id":"s1","b":2}"#
        );
        // stdin-index-keys-first
        assert_eq!(
            parsed(br#"{"session_id":"s1","b":1,"2":"two","a":0,"1":"one","4294967295":"not-an-index","4294967294":"index","-1":"neg","01":"lead"}"#),
            r#"{"1":"one","2":"two","4294967294":"index","session_id":"s1","b":1,"a":0,"4294967295":"not-an-index","-1":"neg","01":"lead"}"#
        );
        // stdin-number-formatting
        assert_eq!(
            parsed(br#"{"a":1e21,"b":1.0,"c":-0,"d":12345678901234567890,"e":0.1,"f":1e-7,"g":123e-20,"h":5e-324,"i":1e400,"j":-1.5E+3,"k":100,"l":0.000001}"#),
            r#"{"a":1e+21,"b":1,"c":0,"d":12345678901234567000,"e":0.1,"f":1e-7,"g":1.23e-18,"h":5e-324,"i":null,"j":-1500,"k":100,"l":0.000001}"#
        );
        // stdin-deep-nesting
        let deep = format!("{{\"d\":{}{}}}", "[".repeat(2000), "]".repeat(2000));
        assert_eq!(parsed(deep.as_bytes()), deep);
    }

    // ----- bridge.log --------------------------------------------------------

    #[test]
    fn log_lines_have_the_bridge_shape() {
        // argv-missing-event: no event is "?".
        assert_eq!(
            log_line(0, 7, None, "unknown-hook-name", vec![]),
            r#"{"ts":"1970-01-01T00:00:00.000Z","bridge":"0.8.1","pid":7,"hook":"?","outcome":"unknown-hook-name","impl":"native"}"#
        );
        // spool-user-prompt-submit: an undefined detail is left out.
        assert_eq!(
            log_line(
                0,
                7,
                Some(&js("Stop")),
                "rpc-failed",
                vec![
                    ("hook", Some(Json::Str(js("Stop")))),
                    ("target", Some(Json::Str(js("main")))),
                    ("error", Some(Json::Str(js("timeout")))),
                    ("detail", None),
                ]
            ),
            r#"{"ts":"1970-01-01T00:00:00.000Z","bridge":"0.8.1","pid":7,"hook":"Stop","outcome":"rpc-failed","target":"main","error":"timeout","impl":"native"}"#
        );
    }

    #[test]
    fn log_extra_spreads_over_the_base_keys() {
        // early-headless-entrypoint passes `hook` again: it keeps its place.
        let line = log_line(
            0,
            1,
            Some(&js("argv")),
            "headless-skipped",
            vec![("hook", Some(Json::Str(js("Stop"))))],
        );
        assert!(
            line.contains(r#""pid":1,"hook":"Stop","outcome":"headless-skipped","impl":"native"}"#),
            "{line}"
        );
        // An undefined value over a base key removes the key.
        let line = log_line(0, 1, Some(&js("Stop")), "x", vec![("hook", None)]);
        assert!(!line.contains("\"hook\""), "{line}");
        // walk-no-tokens: an array value.
        let paths = Json::Arr(vec![
            Json::Str(js("/h/.wmux/daemon-auth-token")),
            Json::Str(js("/h/.wmux-auth-token")),
        ]);
        assert!(log_line(0, 1, None, "no-auth-token", vec![("paths", Some(paths))])
            .ends_with(r#""outcome":"no-auth-token","paths":["/h/.wmux/daemon-auth-token","/h/.wmux-auth-token"],"impl":"native"}"#));
    }

    #[test]
    fn log_keys_are_ordered_as_v8_orders_them() {
        // JSON.stringify puts array-index keys first, ascending.
        let line = log_line(
            0,
            1,
            Some(&js("Stop")),
            "x",
            vec![("9", Some(Json::Num(9.0))), ("1", Some(Json::Num(1.0)))],
        );
        assert_eq!(
            line,
            r#"{"1":1,"9":9,"ts":"1970-01-01T00:00:00.000Z","bridge":"0.8.1","pid":1,"hook":"Stop","outcome":"x","impl":"native"}"#
        );
    }

    #[test]
    fn the_log_is_created_appended_and_rotated_once() {
        let _env = testenv::lock();
        let root = std::env::temp_dir().join(format!("wmux-claude-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join(".wmux-x").to_string_lossy().into_owned();
        let checked = AtomicBool::new(false);
        write_log(&dir, "{\"a\":1}", &checked, 16);
        let log = paths::join(&[&dir, "bridge.log"]);
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "{\"a\":1}\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // Past the cap, but this process already checked: no rotation.
        std::fs::write(&log, b"0123456789abcdefg").unwrap();
        write_log(&dir, "{}", &checked, 16);
        assert!(!std::path::Path::new(&format!("{log}.1")).exists());
        // A fresh process rotates first, then starts the new file.
        write_log(&dir, "{\"b\":2}", &AtomicBool::new(false), 16);
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "{\"b\":2}\n");
        assert_eq!(
            std::fs::read_to_string(format!("{log}.1")).unwrap(),
            "0123456789abcdefg{}\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    // ----- targets -----------------------------------------------------------

    const VARS: [&str; 5] = [
        "HOME",
        "USERPROFILE",
        "WMUX_DATA_SUFFIX",
        "WMUX_PIPE_NAME",
        "WMUX_HOOKS_TO_MAIN",
    ];

    /// A home with the given tokens, the env pointed at it; the env is put
    /// back exactly as it was on drop. Hold `testenv::lock()` around it.
    struct Sandbox {
        root: std::path::PathBuf,
        home: String,
        wmux: String,
        _saved: testenv::SavedEnv,
    }

    fn sandbox(tag: &str, daemon: Option<&str>, main: Option<&str>) -> Sandbox {
        let saved = testenv::SavedEnv::new(&VARS);
        let root = std::env::temp_dir().join(format!("wch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let wmux = home.join(".wmux-t");
        std::fs::create_dir_all(&wmux).unwrap();
        if let Some(t) = daemon {
            std::fs::write(wmux.join("daemon-auth-token"), t).unwrap();
        }
        if let Some(t) = main {
            std::fs::write(home.join(".wmux-t-auth-token"), t).unwrap();
        }
        for var in VARS {
            std::env::remove_var(var);
        }
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("WMUX_DATA_SUFFIX", "-t");
        Sandbox {
            root,
            home: home.to_string_lossy().into_owned(),
            wmux: wmux.to_string_lossy().into_owned(),
            _saved: saved,
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn summary(targets: &[Target]) -> Vec<(String, String, String, String)> {
        targets
            .iter()
            .map(|t| (t.name.into(), t.method.into(), t.token.clone(), t.pipe.clone()))
            .collect()
    }

    /// The main pipe for a home, written out rather than derived.
    fn main_pipe(home: &str) -> String {
        #[cfg(windows)]
        {
            let _ = home;
            format!(r"\\.\pipe\wmux-t-{}", paths::username())
        }
        #[cfg(not(windows))]
        {
            format!("{home}/.wmux-t.sock")
        }
    }

    #[test]
    fn the_walk_is_daemon_then_main_each_with_its_token() {
        let _env = testenv::lock();
        let sb = sandbox("walk", Some(" daemon-token\n"), Some("main-token"));
        std::fs::write(paths::join(&[&sb.wmux, "daemon-pipe"]), "/run/d.sock\n").unwrap();
        // walk-daemon-full-envelope, walk-daemon-absent-advances
        assert_eq!(
            summary(&resolve_targets(false)),
            vec![
                (
                    "daemon".into(),
                    DAEMON_METHOD.into(),
                    "daemon-token".into(),
                    "/run/d.sock".into()
                ),
                (
                    "main".into(),
                    MAIN_METHOD.into(),
                    "main-token".into(),
                    main_pipe(&sb.home)
                ),
            ]
        );
        // walk-kill-switch-main-only; gate-* (gate and context mode are main only)
        std::env::set_var("WMUX_HOOKS_TO_MAIN", "1");
        assert_eq!(summary(&resolve_targets(false))[0].0, "main");
        std::env::remove_var("WMUX_HOOKS_TO_MAIN");
        assert_eq!(resolve_targets(true).len(), 1);
        assert_eq!(resolve_targets(true)[0].name, "main");
    }

    #[cfg(unix)]
    #[test]
    fn an_empty_home_puts_the_main_socket_in_tmp() {
        let _env = testenv::lock();
        let _sb = sandbox("tmp", None, Some("main-token"));
        // os.homedir() is '' when HOME is set but empty: `homedir() || '/tmp'`.
        std::env::set_var("HOME", "");
        assert_eq!(resolve_targets(false)[0].pipe, "/tmp/.wmux-t.sock");
    }

    #[test]
    fn tokens_must_exist_and_not_be_blank() {
        let _env = testenv::lock();
        // walk-empty-token-is-absent
        let sb = sandbox("blank", Some(" \n"), Some("main-token"));
        assert_eq!(summary(&resolve_targets(false)).len(), 1);
        drop(sb);
        // walk-no-tokens
        let _sb = sandbox("none", None, None);
        assert!(resolve_targets(false).is_empty());
        assert!(resolve_targets(true).is_empty());
    }

    #[test]
    fn the_pipe_override_is_one_target_addressed_by_mode() {
        let _env = testenv::lock();
        let _sb = sandbox("override", Some("daemon-token"), Some("main-token"));
        std::env::set_var("WMUX_PIPE_NAME", "/run/o.sock");
        // walk-pipe-override
        assert_eq!(
            summary(&resolve_targets(false)),
            vec![(
                "daemon".into(),
                DAEMON_METHOD.into(),
                "daemon-token".into(),
                "/run/o.sock".into()
            )]
        );
        // walk-pipe-override-gate
        assert_eq!(
            summary(&resolve_targets(true)),
            vec![(
                "main".into(),
                MAIN_METHOD.into(),
                "main-token".into(),
                "/run/o.sock".into()
            )]
        );
        // An empty override is no override.
        std::env::set_var("WMUX_PIPE_NAME", "");
        assert_eq!(resolve_targets(false).len(), 2);
    }

    #[test]
    fn the_override_falls_back_to_the_other_token() {
        let _env = testenv::lock();
        // walk-pipe-override-daemon-token-fallback
        let sb = sandbox("fallback", Some("daemon-token"), None);
        std::env::set_var("WMUX_PIPE_NAME", "/run/o.sock");
        assert_eq!(resolve_targets(true)[0].token, "daemon-token");
        drop(sb);
        let sb = sandbox("fallback2", None, Some("main-token"));
        std::env::set_var("WMUX_PIPE_NAME", "/run/o.sock");
        assert_eq!(resolve_targets(false)[0].token, "main-token");
        assert_eq!(resolve_targets(false)[0].name, "daemon");
        drop(sb);
        // walk-pipe-override-no-token
        let _sb = sandbox("fallback3", None, None);
        std::env::set_var("WMUX_PIPE_NAME", "/run/o.sock");
        assert!(resolve_targets(false).is_empty());
    }

    #[test]
    fn userprofile_wins_for_files_and_homedir_names_the_main_socket() {
        let _env = testenv::lock();
        let sb = sandbox("homes", Some("daemon-token"), Some("main-token"));
        let alt = sb.root.join("alt");
        std::fs::create_dir_all(alt.join(".wmux-t")).unwrap();
        std::fs::write(alt.join(".wmux-t").join("daemon-auth-token"), "decoy-daemon-token").unwrap();
        std::fs::write(alt.join(".wmux-t-auth-token"), "decoy-main-token").unwrap();
        // home-split-userprofile-wins, home-split-main-socket-follows-homedir
        std::env::set_var("HOME", &alt);
        let targets = resolve_targets(false);
        assert_eq!(targets[0].token, "daemon-token");
        assert_eq!(targets[1].token, "main-token");
        assert_eq!(paths::wmux_home_dir(), sb.wmux);
        #[cfg(unix)]
        assert_eq!(targets[1].pipe, format!("{}/.wmux-t.sock", alt.to_string_lossy()));
        // home-userprofile-empty-uses-home, home-userprofile-unset-uses-home
        std::env::set_var("HOME", &sb.home);
        std::env::set_var("USERPROFILE", "");
        assert_eq!(resolve_targets(false)[0].token, "daemon-token");
        std::env::remove_var("USERPROFILE");
        assert_eq!(resolve_targets(false)[1].token, "main-token");
    }

    #[test]
    fn the_daemon_hint_is_trimmed_and_else_derived() {
        let _env = testenv::lock();
        let sb = sandbox("hint", Some("daemon-token"), None);
        let hint = paths::join(&[&sb.wmux, "daemon-pipe"]);
        // daemon-hint-absent-derived
        #[cfg(windows)]
        let derived = format!(r"\\.\pipe\wmux-daemon-t-{}", paths::username());
        #[cfg(not(windows))]
        let derived = format!("{}/daemon.sock", sb.wmux);
        assert_eq!(resolve_targets(false)[0].pipe, derived);
        // daemon-hint-crlf, daemon-hint-blanks
        std::fs::write(&hint, "/run/d.sock\r\n").unwrap();
        assert_eq!(resolve_targets(false)[0].pipe, "/run/d.sock");
        std::fs::write(&hint, " \t/run/d.sock \r\n\n").unwrap();
        assert_eq!(resolve_targets(false)[0].pipe, "/run/d.sock");
        // A blank hint is no hint.
        std::fs::write(&hint, " \n").unwrap();
        assert_eq!(resolve_targets(false)[0].pipe, derived);
    }

    // ----- walk policy -------------------------------------------------------

    #[test]
    fn the_policies_match_the_bridge() {
        assert_eq!(CLAUDE_POLICY.budget, HOOK_TIMEOUT);
        assert_eq!(PERMISSION_GATE_POLICY.budget, GATE_PERMISSION_TIMEOUT);
        const { assert!(!CLAUDE_POLICY.slice_per_target && !PERMISSION_GATE_POLICY.slice_per_target) };
        assert!(CLAUDE_POLICY.resend_after_write.is_empty());
        // walk-close-after-write-stops, walk-reply-retryable-false-stops:
        // written-then-lost is never sent on, whatever the kind.
        let lost = js::parse(&js(r#"{"ok":false,"retryable":false}"#)).unwrap();
        for kind in ["agent.stop", "agent.session_start", "agent.awaiting_permission"] {
            assert!(!crate::rpc::should_try_next_target(&lost, kind, &CLAUDE_POLICY));
        }
        // walk-unauthorized-advances, walk-reply-timeout-value-advances
        let refused = js::parse(&js(r#"{"id":"x","ok":false,"error":"timeout"}"#)).unwrap();
        assert!(crate::rpc::should_try_next_target(
            &refused,
            "agent.stop",
            &CLAUDE_POLICY
        ));
    }
}
