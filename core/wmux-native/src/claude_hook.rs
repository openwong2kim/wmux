//! `wmux-native claude-hook <Event> [flags…]`: the Claude hook bridge,
//! integrations/claude/bin/wmux-bridge.mjs, run natively. Unix only; on
//! Windows the Claude hooks stay on the Node bridge.
//!
//! Before anything else, and before stdin is touched, the run is handed to
//! the Node bridge beside this binary (`node <exe dir>/wmux-bridge.mjs
//! <Event> [flags…]`, exec'd so the process and its parent stay the same):
//!   1. the kill switch: WMUX_HOOK_RUNTIME=node, or a `native-disabled` file
//!      beside the binary;
//!   2. a bridge this port was not made from: its SHA-256 (CRLF read as LF)
//!      is not PORTED_FROM_SHA256 (logged `impl-fallback`,
//!      reason `bridge-sha-mismatch`);
//!   3. a decision flag: `--gate`, `--permission-gate`, or `--context` on
//!      UserPromptSubmit. Their answers (exit 2, stdout) are not ported yet.
//!
//! No bridge beside the binary: the run stays native (logged
//! `impl-native-no-bridge`), and a decision flag fails open: exit 0, empty
//! stdout, logged `decision-unported` with the flag. A failed exec (no node)
//! is logged `impl-fallback`, reason `node-missing`, and is handled the same.
//!
//! The rest is main() of the bridge, with gate, context and permission-gate
//! mode off; the exit code is always 0 and stdout is never written. Every
//! bridge.log line this binary writes ends with `"impl":"native"`.
//!
//! Where it differs from Node, on purpose (each is a characterisation case's
//! strictForPort):
//!   - argv-unknown-event, argv-missing-event: `unknown-hook-name` logs this
//!     process's argv, `[<exe>, "claude-hook", …]`.
//!   - argv-proto-key: only the hook names of HOOK_TO_KIND are hooks. Node's
//!     plain-object lookup also accepts inherited keys (`constructor`) and
//!     sends an envelope without a kind; here that is `unknown-hook-name`.
//!   - A payload nested deeper than PAYLOAD_DEPTH_MAX levels is refused at
//!     once, logged `uncaught` with V8's RangeError message, and nothing is
//!     sent. Node fails at its own stack limit (about 5 000 to 8 000 levels,
//!     by node release) and then only once a socket connects, where the
//!     exception ends the process with exit 1.

use crate::claude::{self, CLAUDE_POLICY};
use crate::claude_rpc;
use crate::claude_transcript as transcript;
use crate::claude_where::{self, WhereEnv};
use crate::hook::{now_ms, random_uuid};
use crate::js::{self, js, JsStr, Json};
use crate::paths;
use crate::rpc::Target;
use crate::sha256;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The bridge this port follows (claudeHookContract.test.ts pins the same file).
const PORTED_FROM_SHA256: &str = include_str!("../claude-hook.ported-from.sha256");
const BRIDGE_BASENAME: &str = "wmux-bridge.mjs";
const KILL_SWITCH_FILE: &str = "native-disabled";

/// MAX_STDIN_BYTES.
const MAX_STDIN_BYTES: usize = 1024 * 1024;
/// ACTIVITY_STAMP_THROTTLE_MS.
const ACTIVITY_STAMP_THROTTLE_MS: f64 = 2500.0;
/// WMUX_CLIENT_NAME.
const WMUX_CLIENT_NAME: &str = "wmux-hook-bridge";
/// The deepest payload accepted (Node 22 forwards 5 000 levels).
const PAYLOAD_DEPTH_MAX: usize = 5000;
/// The run's own stack: room for PAYLOAD_DEPTH_MAX levels of the recursive
/// clone and stringify, whatever the platform's main-thread default.
const STACK_BYTES: usize = 64 * 1024 * 1024;
const RANGE_ERROR: &str = "RangeError: Maximum call stack size exceeded";

/// HOOK_TO_KIND.
const HOOK_TO_KIND: [(&str, &str); 10] = [
    ("PreToolUse", "agent.awaiting_input"),
    ("PostToolUse", "agent.activity"),
    ("Stop", "agent.stop"),
    ("SubagentStop", "agent.subagent_stop"),
    ("SessionStart", "agent.session_start"),
    ("SessionEnd", "agent.session_end"),
    ("UserPromptSubmit", "agent.user_prompt_submit"),
    ("StopFailure", "agent.stop_failure"),
    ("PermissionRequest", "agent.awaiting_input"),
    ("Notification", "agent.awaiting_input"),
];

/// logEvent with this run's hook: `(outcome, extra)`.
type Log<'a> = &'a dyn Fn(&str, Vec<(&str, Option<Json>)>);

const INTERACTIVE_ENTRYPOINTS: [&str; 3] = ["cli", "vscode", "jetbrains"];

/// The process: `args` are the arguments after `claude-hook`. Never returns.
pub fn run_process(args: Vec<OsString>) -> ! {
    let argv: Vec<JsStr> = std::env::args_os().map(|a| paths::os_to_js(&a)).collect();
    let event = args.first().map(|a| paths::os_to_js(a));
    let hook = event.clone();
    let worker = std::thread::Builder::new()
        .stack_size(STACK_BYTES)
        .spawn(move || run(&args, event.as_ref(), &argv));
    let outcome = worker
        .map_err(|e| e.to_string())
        .and_then(|w| w.join().map_err(panic_text));
    if let Err(message) = outcome {
        claude::log_event(
            hook.as_ref(),
            "uncaught",
            vec![("error", Some(Json::Str(js(&message))))],
        );
    }
    std::process::exit(0);
}

fn panic_text(panic: Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}

// ----- the hand-over to Node ---------------------------------------------------

/// What the hand-over found out so far.
struct Handover {
    bridge: Option<PathBuf>,
    node_missing: bool,
}

impl Handover {
    /// exec node with the bridge; returns only when that failed (logged).
    fn exec(&mut self, args: &[OsString], log: Log) {
        let Some(bridge) = self.bridge.as_ref().filter(|_| !self.node_missing) else {
            return;
        };
        use std::os::unix::process::CommandExt;
        let _ = std::process::Command::new("node").arg(bridge).args(args).exec();
        self.node_missing = true;
        log("impl-fallback", vec![("reason", Some(Json::Str(js("node-missing"))))]);
    }
}

fn kill_switch(exe_dir: Option<&Path>) -> bool {
    paths::env("WMUX_HOOK_RUNTIME").as_deref() == Some("node")
        || exe_dir.is_some_and(|d| d.join(KILL_SWITCH_FILE).exists())
}

/// The bridge's hash as claudeHookContract.test.ts computes it.
fn ported_from(source: &[u8]) -> bool {
    sha256::lf_hex(source) == PORTED_FROM_SHA256.trim()
}

/// The decision flag that hands this run to Node, if any: Node's own modes.
fn decision_flag<'a>(hook: &str, flags: &'a [JsStr]) -> Option<&'a JsStr> {
    flags.iter().find(|f| {
        **f == js("--gate") || **f == js("--permission-gate") || (hook == "UserPromptSubmit" && **f == js("--context"))
    })
}

// ----- main() ----------------------------------------------------------------

fn kind_of(hook: &str) -> Option<&'static str> {
    HOOK_TO_KIND.iter().find(|(h, _)| *h == hook).map(|(_, k)| *k)
}

/// A string value of a JS-style property read on the payload.
fn str_prop<'p>(payload: Option<&'p Json>, key: &str) -> Option<&'p JsStr> {
    payload?.get(key)?.as_str()
}

fn non_empty<'p>(payload: Option<&'p Json>, key: &str) -> Option<&'p JsStr> {
    str_prop(payload, key).filter(|s| !s.is_empty())
}

fn str_is(payload: Option<&Json>, key: &str, value: &str) -> bool {
    str_prop(payload, key).is_some_and(|s| *s == js(value))
}

/// `process.env.X` when set and not empty.
fn env_set(name: &str) -> Option<JsStr> {
    paths::env_js(name).filter(|v| !v.is_empty())
}

fn s(text: &str) -> Option<Json> {
    Some(Json::Str(js(text)))
}

fn jstr(text: Option<&JsStr>) -> Option<Json> {
    text.map(|t| Json::Str(t.clone()))
}

/// A server value logged whole. One nested past V8's stack ends the run the
/// way Node's RangeError does, in the `uncaught` line.
fn logged(v: Option<&Json>) -> Option<Json> {
    v.map(|v| {
        assert!(!v.deeper_than(1000), "{RANGE_ERROR}");
        v.clone()
    })
}

/// getPostToolUseKind.
fn post_tool_use_kind(payload: Option<&Json>) -> &'static str {
    if str_is(payload, "tool_name", "AskUserQuestion") {
        "agent.input_answered"
    } else {
        "agent.activity"
    }
}

fn run(args: &[OsString], event: Option<&JsStr>, argv: &[JsStr]) {
    let log = |outcome: &str, extra: Vec<(&str, Option<Json>)>| claude::log_event(event, outcome, extra);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let bridge = exe_dir
        .as_ref()
        .map(|d| d.join(BRIDGE_BASENAME))
        .filter(|b| b.is_file());
    let mut handover = Handover {
        bridge,
        node_missing: false,
    };
    if kill_switch(exe_dir.as_deref()) {
        handover.exec(args, &log);
    }
    match handover.bridge.as_ref().map(std::fs::read) {
        Some(Ok(source)) if ported_from(&source) => {}
        Some(Ok(_)) => {
            log("impl-fallback", vec![("reason", s("bridge-sha-mismatch"))]);
            handover.exec(args, &log);
        }
        _ => {
            handover.bridge = None;
            log("impl-native-no-bridge", vec![]);
        }
    }

    let hook = event.map(|e| js::lossy(e)).unwrap_or_default();
    let Some(kind) = kind_of(&hook) else {
        let argv = argv.iter().map(|a| Json::Str(a.clone())).collect();
        log("unknown-hook-name", vec![("argv", Some(Json::Arr(argv)))]);
        return;
    };
    let flags: Vec<JsStr> = args.iter().skip(1).map(|a| paths::os_to_js(a)).collect();
    if let Some(flag) = decision_flag(&hook, &flags) {
        handover.exec(args, &log);
        log("decision-unported", vec![("flag", Some(Json::Str(flag.clone())))]);
        return;
    }
    let hook_field = || s(&hook);

    let raw_entrypoint = paths::env_js("CLAUDE_CODE_ENTRYPOINT");
    let interactive = |e: Option<&JsStr>| e.is_some_and(|e| INTERACTIVE_ENTRYPOINTS.iter().any(|i| *e == js(i)));
    if (hook == "PermissionRequest" || hook == "Notification") && !interactive(raw_entrypoint.as_ref()) {
        let outcome = if hook == "Notification" {
            "notification-skipped"
        } else {
            "permission-request-skipped"
        };
        let shown = raw_entrypoint.map_or(Json::Null, Json::Str);
        log(outcome, vec![("reason", s("headless")), ("entrypoint", Some(shown))]);
        return;
    }

    let entrypoint = raw_entrypoint.filter(|e| !e.is_empty());
    let class = classify_entrypoint(entrypoint.as_ref());
    if class == Entrypoint::Headless {
        log(
            "headless-skipped",
            vec![("hook", hook_field()), ("entrypoint", jstr(entrypoint.as_ref()))],
        );
        return;
    }

    let mut payload = match read_stdin(&log) {
        Ok(p) => p,
        Err(error) => {
            log("malformed-stdin", vec![("error", s(&error))]);
            return;
        }
    };
    if payload.as_ref().is_some_and(|p| p.deeper_than(PAYLOAD_DEPTH_MAX)) {
        panic!("{RANGE_ERROR}");
    }
    if payload.is_none() && hook != "SessionStart" {
        log("empty-stdin", vec![("hook", hook_field())]);
        return;
    }
    if hook == "Notification" && !str_is(payload.as_ref(), "notification_type", "permission_prompt") {
        let shown = str_prop(payload.as_ref(), "notification_type").map_or(Json::Null, |t| Json::Str(t.clone()));
        log("skip-notification", vec![("type", Some(shown))]);
        return;
    }
    if class == Entrypoint::Unknown && js::truthy(payload.as_ref()) {
        let mut entries = js::spread(payload.as_ref().unwrap_or(&Json::Null));
        entries.retain(|(k, _)| *k != js("transcript_path") && *k != js("session_id"));
        payload = Some(Json::Obj(entries));
        log(
            "unknown-entrypoint",
            vec![("hook", hook_field()), ("entrypoint", jstr(entrypoint.as_ref()))],
        );
    }
    let payload = payload.as_ref();

    // Claude Code's own forked agents: an agent_id without an agent_type.
    if hook != "PermissionRequest"
        && js::truthy(payload)
        && non_empty(payload, "agent_id").is_some()
        && non_empty(payload, "agent_type").is_none()
    {
        log("skip-internal-fork", vec![("hook", hook_field())]);
        return;
    }
    if hook == "PreToolUse" && !str_is(payload, "tool_name", "AskUserQuestion") {
        // `payload && payload.tool_name`
        let tool = if js::truthy(payload) {
            logged(payload.and_then(|p| p.get("tool_name")))
        } else {
            payload.cloned()
        };
        log("skip-pretooluse", vec![("tool", tool)]);
        return;
    }
    if hook == "PreToolUse" && paths::env("WMUX_MOA_DELEGATE_WORKER").as_deref() == Some("1") {
        log(
            "skip-pretooluse",
            vec![("tool", s("AskUserQuestion")), ("reason", s("moa-delegate-worker"))],
        );
        return;
    }
    let cwd = || {
        let dir = std::env::current_dir().expect("process.cwd()");
        paths::os_to_js(dir.as_os_str())
    };
    if hook == "PostToolUse" && post_tool_use_kind(payload) == "agent.activity" {
        let key = env_set("WMUX_PTY_ID")
            .or_else(|| non_empty(payload, "session_id").cloned())
            .or_else(|| non_empty(payload, "cwd").cloned())
            .unwrap_or_else(cwd);
        if should_throttle(&paths::wmux_home_dir(), &key, now_ms() as f64) {
            return;
        }
    }
    let pty_id = env_set("WMUX_PTY_ID");
    if hook == "SessionEnd" && pty_id.is_some() {
        log("skip-session-end-in-pane", vec![]);
        return;
    }

    let targets: Vec<Target> = claude::resolve_targets(false)
        .into_iter()
        .filter(|t| hook != "SessionEnd" || t.name == "daemon")
        .collect();
    if targets.is_empty() {
        let paths = [paths::daemon_auth_token_path(), paths::auth_token_path()];
        let paths = paths.iter().map(|p| Json::Str(js(p))).collect();
        log("no-auth-token", vec![("paths", Some(Json::Arr(paths)))]);
        return;
    }

    let payload_cwd = non_empty(payload, "cwd");
    let transcript_js = non_empty(payload, "transcript_path");
    let transcript_path = transcript_js.map(|p| js::lossy(p));
    let read_log = |outcome: &str, error: String| log(outcome, vec![("error", s(&error))]);
    let usage = match (hook.as_str(), transcript_path.as_deref()) {
        ("Stop" | "SubagentStop", Some(path)) => transcript::usage(path, &read_log),
        _ => None,
    };
    let leftover_work = match (hook.as_str(), transcript_path.as_deref()) {
        ("Stop", Some(path)) => transcript::leftover_work(path, &read_log),
        _ => 0,
    };
    let permission_mode = transcript::permission_mode(&hook, transcript_path.as_deref(), payload, &read_log);

    let workspace_id = env_set("WMUX_WORKSPACE_ID");
    let surface_id = env_set("WMUX_SURFACE_ID");
    let wsl_agent_process = env_set("WMUX_WSL_AGENT_PROC").filter(|v| v.len() <= 8192);
    let where_ = if pty_id.is_none() {
        let query = || claude_where::query_tmux(std::env::var_os("TMUX_PANE").as_deref());
        let asks = hook == "SessionStart" || hook == "UserPromptSubmit";
        claude_where::where_from_env(&where_env(), asks.then_some(&query as &dyn Fn() -> _))
    } else {
        None
    };

    let kind = if hook == "PostToolUse" {
        post_tool_use_kind(payload)
    } else {
        kind
    };
    let fallback_id = str_prop(payload, "session_id").cloned();
    let agent_session_id = transcript::session_id(transcript_js.map(Vec::as_slice), fallback_id);
    let mut body = payload.map(js::spread).unwrap_or_default();
    if let Some(usage) = usage {
        js::assign(&mut body, js("usage"), usage);
    }
    if let Some(mode) = &permission_mode {
        js::assign(&mut body, js("permissionMode"), Json::Str(mode.clone()));
    }
    if leftover_work > 0 {
        js::assign(&mut body, js("wmux_leftover_work"), Json::Num(leftover_work as f64));
    }
    let envelope_cwd = payload_cwd.cloned().unwrap_or_else(cwd);
    let ts = now_ms();
    let meta: Vec<(&str, Option<Json>)> = vec![
        ("kind", s(kind)),
        ("agent", s("claude")),
        ("agentSessionId", jstr(agent_session_id.as_ref())),
        ("workspaceId", jstr(workspace_id.as_ref())),
        ("surfaceId", jstr(surface_id.as_ref())),
        ("ptyId", jstr(pty_id.as_ref())),
        ("wslAgentProcess", jstr(wsl_agent_process.as_ref())),
        ("where", where_),
        ("entrypoint", jstr(entrypoint.as_ref())),
        ("agentPid", agent_pid()),
        ("cwd", Some(Json::Str(envelope_cwd.clone()))),
    ];
    let object = |fields: Vec<(&str, Option<Json>)>| {
        Json::Obj(fields.into_iter().filter_map(|(k, v)| v.map(|v| (js(k), v))).collect())
    };

    if paths::env("WMUX_BRIDGE_DEBUG").as_deref() == Some("1") {
        let keys = js::object_keys(&body).into_iter().map(Json::Str).collect();
        let truthy_field = |key: &str| {
            let value = body.iter().find(|(k, _)| *k == js(key)).map(|(_, v)| v);
            js::truthy(value).then(|| value.cloned()).flatten()
        };
        let mut fields = meta.clone();
        fields.push(("ts", Some(Json::Num(ts as f64))));
        fields.push(("payloadKeys", Some(Json::Arr(keys))));
        fields.push(("usage", truthy_field("usage")));
        fields.push(("permissionMode", truthy_field("permissionMode")));
        let mut line = String::from("WMUX_BRIDGE_DEBUG_ENVELOPE=");
        js::stringify(&object(fields), &mut line);
        eprintln!("{line}");
    }

    let mut fields = meta;
    fields.push(("payload", Some(Json::Obj(body))));
    fields.push(("ts", Some(Json::Num(ts as f64))));
    let mut envelope = String::new();
    js::stringify(&object(fields), &mut envelope);

    let request_id = format!("bridge-{}", random_uuid());
    let build_line = |t: &Target| {
        let mut line = String::from("{\"id\":");
        js::quote_str(&request_id, &mut line);
        line.push_str(",\"method\":");
        js::quote_str(t.method, &mut line);
        line.push_str(&format!(",\"params\":{envelope},\"token\":"));
        js::quote_str(&t.token, &mut line);
        line.push_str(",\"clientName\":");
        js::quote_str(WMUX_CLIENT_NAME, &mut line);
        line.push_str("}\n");
        line
    };
    let (result, target) = claude_rpc::send_to_targets(&targets, build_line, &js(&request_id), kind, &CLAUDE_POLICY);
    let target_field = target.map(|t| Json::Str(js(t.name)));
    let outer_ok = result.get("ok") == Some(&Json::Bool(true));
    let inner = result.get("result");
    let inner_ok = outer_ok && inner.and_then(|r| r.get("ok")) == Some(&Json::Bool(true));
    // `x ?? 'unknown'`
    let or_unknown = |v: Option<&Json>| logged(v.filter(|v| **v != Json::Null)).or_else(|| s("unknown"));
    if inner_ok {
        log("ok", vec![("hook", hook_field()), ("target", target_field)]);
    } else if outer_ok {
        log(
            "rpc-rejected",
            vec![
                ("hook", hook_field()),
                ("target", target_field),
                ("reason", or_unknown(inner.and_then(|r| r.get("reason")))),
            ],
        );
    } else {
        log(
            "rpc-failed",
            vec![
                ("hook", hook_field()),
                ("target", target_field),
                ("error", or_unknown(result.get("error"))),
                ("detail", logged(result.get("detail"))),
            ],
        );
    }

    let lifecycle = matches!(
        kind,
        "agent.session_start" | "agent.user_prompt_submit" | "agent.stop" | "agent.subagent_stop"
    );
    if let (false, true, Some(pty), Some(session)) = (
        inner_ok,
        lifecycle,
        &pty_id,
        agent_session_id.as_ref().filter(|s| !s.is_empty()),
    ) {
        let record = object(vec![
            ("ptyId", Some(Json::Str(pty.clone()))),
            ("agent", s("claude")),
            ("sessionId", Some(Json::Str(session.clone()))),
            ("cwd", Some(Json::Str(envelope_cwd))),
            ("transcriptPath", jstr(transcript_js)),
            ("permissionMode", jstr(permission_mode.as_ref())),
            ("workspaceId", jstr(workspace_id.as_ref())),
            ("ts", Some(Json::Num(ts as f64))),
        ]);
        spool_resume_binding(&paths::wmux_home_dir(), pty, session, &record, ts as f64, &log);
    }
}

#[derive(PartialEq)]
enum Entrypoint {
    Absent,
    Interactive,
    Headless,
    Unknown,
}

/// classifyEntrypoint.
fn classify_entrypoint(entrypoint: Option<&JsStr>) -> Entrypoint {
    let Some(e) = entrypoint.filter(|e| !e.is_empty()) else {
        return Entrypoint::Absent;
    };
    if INTERACTIVE_ENTRYPOINTS.iter().any(|i| *e == js(i)) {
        Entrypoint::Interactive
    } else if e.starts_with(&js("sdk-")) || *e == js("mcp") {
        Entrypoint::Headless
    } else {
        Entrypoint::Unknown
    }
}

fn where_env() -> WhereEnv {
    WhereEnv {
        tmux: paths::env_js("TMUX"),
        tmux_pane: paths::env_js("TMUX_PANE"),
        tmux_target: paths::env_js("WMUX_TMUX_TARGET"),
        sty: paths::env_js("STY"),
        zellij: paths::env_js("ZELLIJ"),
        zellij_session_name: paths::env_js("ZELLIJ_SESSION_NAME"),
        ssh_connection: paths::env_js("SSH_CONNECTION"),
        term_program: paths::env_js("TERM_PROGRAM"),
        wsl_distro_name: paths::env_js("WSL_DISTRO_NAME"),
    }
}

/// `process.ppid`, sent on macOS only.
fn agent_pid() -> Option<Json> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    extern "C" {
        fn getppid() -> i32;
    }
    // SAFETY: getppid takes nothing and cannot fail.
    Some(Json::Num(f64::from(unsafe { getppid() })))
}

// ----- stdin -------------------------------------------------------------------

/// readStdin: at most MAX_STDIN_BYTES are kept; past that the rest is never
/// read (Node destroys stdin) and `stdin-truncated` is logged. Err is the
/// text Node logs, `<class>: <message>`.
fn read_stdin(log: Log) -> Result<Option<Json>, String> {
    let held = read_capped(std::io::stdin().lock()).map_err(|e| format!("Error: {e}"))?;
    let truncated = held.len() > MAX_STDIN_BYTES;
    let held = &held[..held.len().min(MAX_STDIN_BYTES)];
    if truncated {
        log(
            "stdin-truncated",
            vec![("totalBytes", Some(Json::Num(MAX_STDIN_BYTES as f64)))],
        );
    }
    match claude::parse_stdin(held) {
        Ok(Some(Json::Null)) | Ok(None) => Ok(None),
        Ok(payload) => Ok(payload),
        Err(()) => Err("SyntaxError: Unexpected token in JSON".into()),
    }
}

/// Up to one byte past the cap, or to EOF.
fn read_capped(input: impl Read) -> std::io::Result<Vec<u8>> {
    let mut input = input.take(MAX_STDIN_BYTES as u64 + 1);
    let mut held = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match input.read(&mut chunk) {
            Ok(0) => return Ok(held),
            Ok(n) => held.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            // An inherited non-blocking stdin: wait for data as Node does.
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            Err(e) => return Err(e),
        }
    }
}

// ----- files -------------------------------------------------------------------

/// `String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)`, per UTF-16 unit.
fn safe_name(key: &[u16]) -> String {
    key.iter()
        .take(80)
        .map(|&c| match char::from_u32(u32::from(c)) {
            Some(ch) if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' => ch,
            _ => '_',
        })
        .collect()
}

/// shouldThrottleActivity: true (skip the send) when this key sent within
/// the window; otherwise the stamp is written now, before the send, and the
/// answer is false. Any filesystem error fails open.
fn should_throttle(wmux_home: &str, key: &[u16], now: f64) -> bool {
    let dir = paths::join(&[wmux_home, "activity-stamps"]);
    crate::fsx::ensure_dir(&dir, 0o700);
    let name = safe_name(key);
    let file = paths::join(&[&dir, if name.is_empty() { "default" } else { &name }]);
    if let Ok(mtime) = crate::fsx::mtime_ms(&file) {
        if now - mtime < ACTIVITY_STAMP_THROTTLE_MS {
            return true;
        }
    }
    let _ = crate::fsx::write_file(&file, b"", 0o600);
    false
}

/// spoolResumeBinding: `<wmux home>/resume-spool/<safe ptyId>.json`, written
/// through a unique temp file and a rename, unless the file there already
/// holds a newer `ts`.
fn spool_resume_binding(wmux_home: &str, pty_id: &[u16], session_id: &[u16], record: &Json, ts: f64, log: Log) {
    let safe = safe_name(pty_id);
    if safe.is_empty() {
        return;
    }
    let dir = paths::join(&[wmux_home, "resume-spool"]);
    crate::fsx::ensure_dir(&dir, 0o700);
    let file = paths::join(&[&dir, &format!("{safe}.json")]);
    let tmp = paths::join(&[
        &dir,
        &format!("{safe}.{}.{}.json.tmp", std::process::id(), random_uuid()),
    ]);
    let mut text = String::new();
    js::stringify(record, &mut text);
    let written = crate::fsx::write_file(&tmp, text.as_bytes(), 0o600).and_then(|()| {
        if let Ok(existing) = std::fs::read(&file) {
            let existing = js::js(&String::from_utf8_lossy(&existing));
            if let Ok(Json::Num(existing_ts)) = js::parse(&existing).map(|e| e.get("ts").cloned().unwrap_or(Json::Null))
            {
                if existing_ts > ts {
                    let _ = std::fs::remove_file(&tmp);
                    return Ok(false);
                }
            }
        }
        std::fs::rename(&tmp, &file).map(|()| true)
    });
    match written {
        Ok(true) => log(
            "resume-spooled",
            vec![
                ("ptyId", Some(Json::Str(pty_id.to_vec()))),
                ("sessionId", Some(Json::Str(session_id.to_vec()))),
            ],
        ),
        Ok(false) => {}
        Err(e) => log("resume-spool-error", vec![("error", s(&format!("Error: {e}")))]),
    }
}

/// isGateAnswerLost: a Stop gate's request that provably reached main and
/// then lost its answer. True only for a timeout or a close after the write
/// (retryable: false); a connect error, written or not, fails open. The
/// Stop gate itself still runs on the Node bridge; this is its verdict, held
/// to the transport's outcomes before the gate is ported.
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_gate_answer_lost(result: &Json) -> bool {
    if result.get("ok") == Some(&Json::Bool(true)) || result.get("retryable") != Some(&Json::Bool(false)) {
        return false;
    }
    let error = result.get("error");
    error == Some(&Json::Str(js("timeout"))) || error == Some(&Json::Str(js("closed-without-response")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_rpc::{Event, Session};
    use crate::testenv;
    use std::cell::RefCell;

    /// A fresh directory; std::env::temp_dir reads TMPDIR, so hold testenv::lock().
    fn scratch(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("wmux-claude-hook-{tag}-{}", random_uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn text(v: &Json) -> String {
        let mut out = String::new();
        js::stringify(v, &mut out);
        out
    }

    #[test]
    fn safe_names_follow_the_bridge_regex_per_utf16_unit() {
        assert_eq!(safe_name(&js("pty-1_A")), "pty-1_A");
        assert_eq!(safe_name(&js("a/b c.d")), "a_b_c_d");
        // An astral character is two units, so two underscores.
        assert_eq!(safe_name(&js("x😀")), "x__");
        assert_eq!(safe_name(&js("é")), "_");
        assert_eq!(safe_name(&js(&"a".repeat(100))).len(), 80);
        assert_eq!(safe_name(&[]), "");
    }

    #[test]
    fn the_throttle_stamps_before_the_send_and_skips_inside_the_window() {
        let _env = testenv::lock();
        // throttle-post-tool-use, throttle-key-from-session
        let home = scratch("throttle");
        let stamp = format!("{home}/activity-stamps/pty-1");
        let now = crate::hook::now_ms() as f64;
        assert!(!should_throttle(&home, &js("pty-1"), now), "first send");
        assert!(std::fs::metadata(&stamp).unwrap().len() == 0);
        let written = crate::fsx::mtime_ms(&stamp).unwrap();
        assert!(should_throttle(&home, &js("pty-1"), written + 2499.0));
        assert!(!should_throttle(&home, &js("pty-1"), written + 2500.0));
        // A stamp from the future still holds the key off.
        assert!(should_throttle(&home, &js("pty-1"), written - 10_000.0));
        // An empty key is `default`.
        assert!(!should_throttle(&home, &[], now));
        assert!(std::path::Path::new(&format!("{home}/activity-stamps/default")).exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_throttle_fails_open() {
        let _env = testenv::lock();
        // A home that cannot hold the stamp directory: always send.
        let home = scratch("throttle-open");
        std::fs::write(format!("{home}/activity-stamps"), b"a file").unwrap();
        let now = crate::hook::now_ms() as f64;
        assert!(!should_throttle(&home, &js("k"), now));
        assert!(!should_throttle(&home, &js("k"), now));
        std::fs::remove_dir_all(&home).unwrap();
    }

    fn spool(home: &str, ts: f64) -> Vec<String> {
        let logged = RefCell::new(Vec::new());
        let log = |outcome: &str, _: Vec<(&str, Option<Json>)>| logged.borrow_mut().push(outcome.to_string());
        let record = Json::Obj(vec![(js("ptyId"), Json::Str(js("p/1"))), (js("ts"), Json::Num(ts))]);
        spool_resume_binding(home, &js("p/1"), &js("s1"), &record, ts, &log);
        logged.into_inner()
    }

    fn spooled(home: &str) -> String {
        std::fs::read_to_string(format!("{home}/resume-spool/p_1.json")).unwrap()
    }

    fn leftovers(home: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(format!("{home}/resume-spool"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_spool_keeps_the_newest_record() {
        let _env = testenv::lock();
        // spool-user-prompt-submit, walk-daemon-rejects-spools
        let home = scratch("spool");
        assert_eq!(spool(&home, 10.0), ["resume-spooled"]);
        assert_eq!(spooled(&home), r#"{"ptyId":"p/1","ts":10}"#);
        // An older capture is dropped silently and leaves no temp file.
        assert!(spool(&home, 5.0).is_empty());
        assert_eq!(spooled(&home), r#"{"ptyId":"p/1","ts":10}"#);
        assert_eq!(leftovers(&home), ["p_1.json"]);
        // The same ts replaces it; so does anything over a corrupt file.
        assert_eq!(spool(&home, 10.0), ["resume-spooled"]);
        std::fs::write(format!("{home}/resume-spool/p_1.json"), "{not json").unwrap();
        assert_eq!(spool(&home, 1.0), ["resume-spooled"]);
        assert_eq!(spooled(&home), r#"{"ptyId":"p/1","ts":1}"#);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_spool_that_cannot_be_written_is_logged() {
        let _env = testenv::lock();
        let home = scratch("spool-error");
        std::fs::write(format!("{home}/resume-spool"), b"a file").unwrap();
        assert_eq!(spool(&home, 1.0), ["resume-spool-error"]);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn only_nodes_decision_modes_hand_over() {
        let flags = |f: &[&str]| f.iter().map(|x| js(x)).collect::<Vec<_>>();
        // argv-flags-any-position, gate-with-permission-gate
        assert_eq!(
            decision_flag("Stop", &flags(&["--unknown", "--gate"])),
            Some(&js("--gate"))
        );
        assert_eq!(
            decision_flag("PreToolUse", &flags(&["--permission-gate"])),
            Some(&js("--permission-gate"))
        );
        // argv-context-needs-user-prompt-submit: --context elsewhere is ignored.
        assert_eq!(decision_flag("Stop", &flags(&["--context"])), None);
        assert_eq!(
            decision_flag("UserPromptSubmit", &flags(&["--context"])),
            Some(&js("--context"))
        );
        assert_eq!(decision_flag("Stop", &flags(&["--gated", "gate"])), None);
    }

    #[test]
    fn entrypoints_are_classified_as_the_daemon_does() {
        let class = |e: &str| classify_entrypoint(Some(&js(e)));
        assert!(class("cli") == Entrypoint::Interactive);
        assert!(class("jetbrains") == Entrypoint::Interactive);
        assert!(class("sdk-cli") == Entrypoint::Headless);
        assert!(class("mcp") == Entrypoint::Headless);
        assert!(class("desktop") == Entrypoint::Unknown);
        assert!(class("") == Entrypoint::Absent);
        assert!(classify_entrypoint(None) == Entrypoint::Absent);
    }

    #[test]
    fn hook_names_are_the_tables_own_keys_only() {
        // argv-proto-key: an inherited object key is not a hook here.
        for hook in ["constructor", "toString", "__proto__", "stop", ""] {
            assert_eq!(kind_of(hook), None, "{hook}");
        }
        assert_eq!(kind_of("PermissionRequest"), Some("agent.awaiting_input"));
        assert_eq!(kind_of("StopFailure"), Some("agent.stop_failure"));
    }

    #[test]
    fn stdin_is_cut_one_byte_past_the_cap() {
        // stdin-exactly-cap, stdin-over-cap-keeps-first-mib
        let exact = vec![b' '; MAX_STDIN_BYTES];
        assert_eq!(read_capped(&exact[..]).unwrap().len(), MAX_STDIN_BYTES);
        let over = vec![b' '; MAX_STDIN_BYTES + 4096];
        assert_eq!(read_capped(&over[..]).unwrap().len(), MAX_STDIN_BYTES + 1);
    }

    #[test]
    fn the_pinned_bridge_is_the_one_in_the_tree() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../integrations/claude/bin/wmux-bridge.mjs"
        );
        let source = std::fs::read(path).unwrap();
        assert!(ported_from(&source));
        // A Windows checkout's CRLF hashes the same; any other change does not.
        let crlf: Vec<u8> = source
            .iter()
            .flat_map(|&b| if b == b'\n' { vec![b'\r', b'\n'] } else { vec![b] })
            .collect();
        assert!(ported_from(&crlf));
        let mut changed = source.clone();
        changed.push(b'\n');
        assert!(!ported_from(&changed));
    }

    #[test]
    fn the_kill_switch_is_the_env_or_a_file_beside_the_binary() {
        let _env = testenv::lock();
        let _saved = testenv::SavedEnv::new(&["WMUX_HOOK_RUNTIME"]);
        let dir = scratch("kill-switch");
        let dir = Path::new(&dir);
        std::env::remove_var("WMUX_HOOK_RUNTIME");
        assert!(!kill_switch(Some(dir)));
        assert!(!kill_switch(None));
        std::env::set_var("WMUX_HOOK_RUNTIME", "native");
        assert!(!kill_switch(Some(dir)));
        std::env::set_var("WMUX_HOOK_RUNTIME", "node");
        assert!(kill_switch(None));
        std::env::remove_var("WMUX_HOOK_RUNTIME");
        std::fs::write(dir.join(KILL_SWITCH_FILE), b"").unwrap();
        assert!(kill_switch(Some(dir)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The outcome a session settles on for these events.
    fn settle(events: Vec<Event>, end: fn(&mut Session) -> Json) -> Json {
        let id = js("bridge-1");
        let mut session = Session::new(&id);
        let settled = events.into_iter().find_map(|e| session.on(e));
        settled.unwrap_or_else(|| end(&mut session))
    }

    #[test]
    fn a_lost_gate_answer_is_a_timeout_or_a_close_after_the_write() {
        // gate-lost-answer, gate-timeout, gate-no-main
        let lost = |t: &str| is_gate_answer_lost(&js::parse(&js(t)).unwrap());
        assert!(lost(r#"{"ok":false,"error":"timeout","retryable":false}"#));
        assert!(lost(
            r#"{"ok":false,"error":"closed-without-response","retryable":false}"#
        ));
        assert!(!lost(r#"{"ok":false,"error":"timeout","retryable":true}"#));
        assert!(!lost(r#"{"ok":false,"error":"closed-without-response"}"#));
        assert!(!lost(
            r#"{"ok":false,"error":"connect-error","detail":"EPIPE","retryable":false}"#
        ));
        assert!(!lost(
            r#"{"ok":false,"error":"connect-error","detail":"ENOENT","retryable":true}"#
        ));
        assert!(!lost(r#"{"ok":false,"error":"no-target"}"#));
        assert!(!lost(r#"{"id":"x","ok":true,"result":{"ok":false}}"#));
        assert!(!lost(r#"{"ok":true,"error":"timeout","retryable":false}"#));
        assert!(!lost("null"));
        assert!(!lost(r#""timeout""#));
    }

    #[test]
    fn the_stop_gate_verdict_on_each_transport_outcome() {
        // The verdict on what the full-duplex transport settles, per stub:
        let epipe = || Event::WriteError(std::io::Error::from_raw_os_error(32));
        let reply = br#"{"id":"bridge-1","ok":true,"result":{"ok":true}}
"#;
        // over-long: the server drops a partial line, so nothing waits: open.
        let over_long = settle(vec![Event::Data(b""), Event::Eof], |s| s.drained());
        assert_eq!(
            text(&over_long),
            r#"{"ok":false,"error":"connect-error","detail":"EPIPE","retryable":false}"#
        );
        assert!(!is_gate_answer_lost(&over_long));
        let over_long_write = settle(vec![epipe()], |s| s.drained());
        assert!(!is_gate_answer_lost(&over_long_write));
        // reset after the whole line went out: the answer was lost: closed.
        let reset_after = settle(vec![Event::AllWritten, Event::Eof], |s| s.drained());
        assert!(is_gate_answer_lost(&reset_after));
        // reset reported as an error: open, as Node's `error` event.
        let econnreset = if cfg!(target_os = "macos") { 54 } else { 104 };
        let reset_error = settle(
            vec![
                Event::AllWritten,
                Event::ReadError(std::io::Error::from_raw_os_error(econnreset)),
            ],
            |s| s.drained(),
        );
        assert!(!is_gate_answer_lost(&reset_error));
        // reply-early-close: the reply settles first, whatever follows.
        let early = settle(vec![Event::Data(reply), epipe(), Event::Eof], |s| s.drained());
        assert_eq!(text(&early), r#"{"id":"bridge-1","ok":true,"result":{"ok":true}}"#);
        assert!(!is_gate_answer_lost(&early));
        // hold: the deadline, after the write: closed.
        let hold = settle(vec![Event::AllWritten], |s| s.deadline());
        assert!(is_gate_answer_lost(&hold));
    }
}
