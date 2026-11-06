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
//!      reason `bridge-sha-mismatch`).
//!
//! No bridge beside the binary: the run stays native (logged
//! `impl-native-no-bridge` just before the run's first other line, so a run
//! that logs nothing adds none). A failed exec (no node) is logged
//! `impl-fallback`, reason `node-missing`, and the run stays native too, so
//! where there is no node the kill switch cannot turn native runs off.
//!
//! The rest is main() of the bridge, its decision modes included:
//! `--gate` (exit 2 and a reason on stderr), `--context` on UserPromptSubmit
//! (a block, or additionalContext on stdout) and `--permission-gate` (allow or
//! deny on stdout, always exit 0). Every other run exits 0 with an empty
//! stdout. Every bridge.log line this binary writes ends with
//! `"impl":"native"`.
//!
//! Where it differs from Node, on purpose (each is a characterisation case's
//! strictForPort):
//!   - argv-unknown-event, argv-missing-event: `unknown-hook-name` logs this
//!     process's argv, `[<exe>, "claude-hook", …]`.
//!   - argv-proto-key: only the hook names of HOOK_TO_KIND are hooks. Node's
//!     plain-object lookup also accepts inherited keys (`constructor`) and
//!     sends an envelope without a kind; here that is `unknown-hook-name`.
//!   - A payload nested deeper than PAYLOAD_DEPTH_MAX (1 500) levels is
//!     refused at once, logged `uncaught` with V8's RangeError message, and
//!     nothing is sent (exit 0): never a request the servers cannot parse.
//!     Node sends far deeper payloads (6 622 levels on node 22) and only dies,
//!     with exit 1, at its own stack limit. Between the servers' parse limit
//!     and that, the server answers `Invalid JSON` with no id, so the Node
//!     bridge waits out its deadline and a `--gate` Stop fails closed on
//!     every retry. That stuck path stays wherever the Node bridge runs
//!     (Windows, the kill switch, a stale pin).
//!   - A verdict whose stdout or stderr reader went away keeps its exit code
//!     (a block stays 2) and logs `stdout-lost` / `stderr-lost` after the
//!     verdict's line; Node dies on the write error with exit 1.
//!   - A panic after a verdict exits with that verdict's code (a block stays
//!     2); Node's catch exits 0 after any exception. With `--gate
//!     --permission-gate`, a panic between the gate's block and the
//!     permission verdict exits 2 with no permission answer on stdout, where
//!     the permission gate would have exited 0.

use crate::claude::{self, CLAUDE_POLICY, PERMISSION_GATE_POLICY};
use crate::claude_rpc;
use crate::claude_transcript as transcript;
use crate::claude_where::{self, WhereEnv};
use crate::hook::{now_ms, random_uuid};
use crate::js::{self, js, JsStr, Json};
use crate::paths;
use crate::rpc::Target;
use crate::sha256;
use crate::unix_sys;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

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
/// The deepest payload sent, the outermost value being level 0 (it sits at
/// the envelope's `params.payload`, two levels down). The servers parse a
/// request with a reviver, which recurses, so they cannot take what Node
/// can stringify. Measured on the line as sent, in a socket callback as the
/// servers parse it, 2026-11-06: main (Electron 45.1.0 main process, node
/// 24.22.1) 3 499; the daemon (Electron 45.1.0 as node) 3 530; a headless
/// daemon on system node 22.23.3 (`wmux daemon` runs it on the CLI's node)
/// 1 823. node 18 and 20, which the engines range allows, were not measured.
/// 1 500 stays under the lowest with a margin; claudeHookDepthServers.test.ts
/// holds it to both servers' parse.
const PAYLOAD_DEPTH_MAX: usize = 1_500;
/// The run's own stack: room for PAYLOAD_DEPTH_MAX levels of the recursive
/// clone and stringify, whatever the platform's main-thread default. A debug
/// build measured here gets through 40 000 levels and overflows below 80 000.
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
type Log<'a> = &'a (dyn Fn(&str, Vec<(&str, Option<Json>)>) + Sync);

const INTERACTIVE_ENTRYPOINTS: [&str; 3] = ["cli", "vscode", "jetbrains"];

/// What `wmux-native --self-test` prints: the hook installer names this copy
/// in Claude Code's settings only after reading it. Reads no stdin, writes no
/// log.
pub fn self_test_line() -> String {
    format!("wmux-claude-hook protocol 1 pin {}", PORTED_FROM_SHA256.trim())
}

/// The process: `args` are the arguments after `claude-hook`, or after the
/// bridge path a settings entry names (`named_bridge`). Never returns. The
/// hand-over runs here, on the main thread, before any other thread exists;
/// the rest of the run gets a thread with its own large stack.
pub fn run_process(args: Vec<OsString>, named_bridge: Option<PathBuf>) -> ! {
    let argv: Vec<JsStr> = std::env::args_os().map(|a| paths::os_to_js(&a)).collect();
    let event = args.first().map(|a| paths::os_to_js(a));
    // A missing bridge is logged with the run's first line, not on its own:
    // a run that logs nothing (a throttled PostToolUse) adds no line for it.
    let no_bridge = AtomicBool::new(false);
    let log = |outcome: &str, extra: Vec<(&str, Option<Json>)>| {
        if no_bridge.swap(false, Ordering::Relaxed) {
            claude::log_event(event.as_ref(), "impl-native-no-bridge", vec![]);
        }
        claude::log_event(event.as_ref(), outcome, extra)
    };
    let mut code = 0;
    if let Some(start) = hand_over(&args, named_bridge.as_deref(), event.as_ref(), &argv, &no_bridge, &log) {
        code = finish(on_own_stack(STACK_BYTES, || run(start, &log)), &log);
    }
    std::process::exit(code);
}

/// The exit code of the verdict this run reached: 0 until a decision sets
/// it (set_exit_code). Every way out reads it, a panic after the verdict
/// included, so a block stays a block.
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

fn set_exit_code(code: i32) {
    EXIT_CODE.store(code, Ordering::SeqCst);
}

/// How the run ended: a panic is logged `uncaught`, as Node's catch logs
/// it; the exit code is the verdict's either way.
fn finish(outcome: Result<(), String>, log: Log) -> i32 {
    if let Err(message) = outcome {
        log("uncaught", vec![("error", s(&message))]);
    }
    EXIT_CODE.load(Ordering::SeqCst)
}

/// All of `bytes` to `fd` (stdout or stderr). An inherited non-blocking
/// descriptor is waited on until it takes more, with no deadline: a reader
/// that never reads holds the run, as it holds Node's stream. False when the
/// write failed or the wait cannot go on (the reader went away, poll fails or
/// cannot watch the descriptor); the caller logs the loss and keeps its exit
/// code.
fn write_out(fd: i32, bytes: &[u8]) -> bool {
    write_waiting(fd, bytes, |fd| crate::claude_rpc::poll_fd(fd, unix_sys::POLLOUT, -1))
}

/// write_out with its wait for writability given: the revents, or poll's error.
fn write_waiting(fd: i32, bytes: &[u8], wait: impl Fn(i32) -> std::io::Result<i16>) -> bool {
    use std::os::fd::FromRawFd;
    // SAFETY: fd 1 and 2 stay open for the whole process, and ManuallyDrop
    // never closes them.
    let mut out = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(fd) });
    let mut written = 0;
    while written < bytes.len() {
        match out.write(&bytes[written..]) {
            Ok(0) => return false,
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => match wait(fd) {
                Ok(revents) if revents & (unix_sys::POLLNVAL | unix_sys::POLLERR) == 0 => {}
                _ => return false,
            },
            Err(_) => return false,
        }
    }
    true
}

/// `f` on a thread with a `stack`-byte stack. Err is a panic's text, or why
/// the thread could not start (then `f` never runs: the run fails open).
fn on_own_stack(stack: usize, f: impl FnOnce() + Send) -> Result<(), String> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .stack_size(stack)
            .spawn_scoped(scope, f)
            .map_err(|e| e.to_string())?
            .join()
            .map_err(panic_text)
    })
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
        crate::unix_sys::ignore_sigpipe();
        self.node_missing = true;
        log("impl-fallback", vec![("reason", Some(Json::Str(js("node-missing"))))]);
    }
}

/// A settings entry names the bridge in argv[1], but the run uses the one
/// beside this binary, as every other run does. A name that is not that file
/// (once both are resolved) is noted, and the run goes on.
fn note_named_bridge(named: &Path, beside: Option<&Path>, log: Log) {
    let resolved = |p: &Path| std::fs::canonicalize(p).ok();
    let same = resolved(named).is_some_and(|n| beside.and_then(resolved) == Some(n));
    if !same {
        let text = |p: &Path| Json::Str(paths::os_to_js(p.as_os_str()));
        log(
            "bridge-path-differs",
            vec![("named", Some(text(named))), ("used", beside.map(text))],
        );
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

/// main()'s modes: any argv token after the event.
#[derive(Clone, Copy, Default)]
struct Modes {
    /// `--gate`: the orchestrator's Stop gate, answered with exit 2.
    gate: bool,
    /// `--context`, on UserPromptSubmit only: the HQ brain's prompt, which
    /// main can refuse (exit 2) or add context to (stdout).
    context: bool,
    /// `--permission-gate`: the PreToolUse permission gate, answered on stdout.
    permission_gate: bool,
}

impl Modes {
    fn of(hook: &str, flags: &[JsStr]) -> Modes {
        let has = |flag: &str| flags.iter().any(|f| *f == js(flag));
        Modes {
            gate: has("--gate"),
            context: hook == "UserPromptSubmit" && has("--context"),
            permission_gate: has("--permission-gate"),
        }
    }
}

/// A hook's JSON answer on stdout, as outputPromptContext and
/// outputPermissionDecision write it: `{"hookSpecificOutput":{…}}` and a newline.
fn hook_output_line(fields: Vec<(&str, Json)>) -> String {
    let fields = fields.into_iter().map(|(k, v)| (js(k), v)).collect();
    let mut line = String::new();
    js::stringify(
        &Json::Obj(vec![(js("hookSpecificOutput"), Json::Obj(fields))]),
        &mut line,
    );
    line.push('\n');
    line
}

/// What the gate writes when the answer was lost after the request reached
/// main (mjs main()).
const GATE_LOST_TEXT: &str = "wmux could not confirm this Stop with the orchestrator (the reply was lost in flight). \
                              Do not end the turn on this attempt \u{2014} check the fleet and stop again.\n";

/// Test-only, and absent from release builds: WMUX_CLAUDE_HOOK_PANIC_AFTER_VERDICT=1
/// panics right after a verdict, to prove its exit code outlives a panic.
fn panic_after_verdict_for_tests() {
    #[cfg(debug_assertions)]
    if paths::env("WMUX_CLAUDE_HOOK_PANIC_AFTER_VERDICT").as_deref() == Some("1") {
        panic!("WMUX_CLAUDE_HOOK_PANIC_AFTER_VERDICT");
    }
}

/// The deny's reason, so the model reads who refused (mjs main()).
const DENY_REASON: &str = "denied from the wmux remote approval";

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

/// What the run goes on with once it stays native.
struct Start {
    hook: String,
    kind: &'static str,
    modes: Modes,
}

/// Everything before stdin: hands the process to Node when it should (and
/// does not return then), or logs why the run ends here (None).
fn hand_over(
    args: &[OsString],
    named_bridge: Option<&Path>,
    event: Option<&JsStr>,
    argv: &[JsStr],
    no_bridge: &AtomicBool,
    log: Log,
) -> Option<Start> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let beside = exe_dir.as_ref().map(|d| d.join(BRIDGE_BASENAME));
    let mut handover = Handover {
        bridge: beside.clone().filter(|b| b.is_file()),
        node_missing: false,
    };
    if kill_switch(exe_dir.as_deref()) {
        handover.exec(args, log);
    }
    if let Some(named) = named_bridge {
        note_named_bridge(named, beside.as_deref(), log);
    }
    match handover.bridge.as_ref().map(std::fs::read) {
        Some(Ok(source)) if ported_from(&source) => {}
        Some(Ok(_)) => {
            log("impl-fallback", vec![("reason", s("bridge-sha-mismatch"))]);
            handover.exec(args, log);
        }
        _ => {
            handover.bridge = None;
            no_bridge.store(true, Ordering::Relaxed);
        }
    }

    let hook = event.map(|e| js::lossy(e)).unwrap_or_default();
    let Some(kind) = kind_of(&hook) else {
        let argv = argv.iter().map(|a| Json::Str(a.clone())).collect();
        log("unknown-hook-name", vec![("argv", Some(Json::Arr(argv)))]);
        return None;
    };
    let flags: Vec<JsStr> = args.iter().skip(1).map(|a| paths::os_to_js(a)).collect();
    let modes = Modes::of(&hook, &flags);
    Some(Start { hook, kind, modes })
}

fn run(start: Start, log: Log) {
    let Start { hook, kind, modes } = start;
    let hook_field = || s(&hook);

    let raw_entrypoint = paths::env_js("CLAUDE_CODE_ENTRYPOINT");
    let interactive = |e: Option<&JsStr>| e.is_some_and(|e| INTERACTIVE_ENTRYPOINTS.iter().any(|i| *e == js(i)));
    // The permission gate's fast ways out, before stdin: no opinion, so an
    // empty stdout.
    if modes.permission_gate {
        if paths::env("WMUX_GATE").as_deref() == Some("0") {
            log("permission-gate-skipped", vec![("reason", s("gate-disabled"))]);
            return;
        }
        if env_set("WMUX_PTY_ID").is_none() || !interactive(raw_entrypoint.as_ref()) {
            let shown = raw_entrypoint.map_or(Json::Null, Json::Str);
            log(
                "permission-gate-skipped",
                vec![("reason", s("headless-or-outside-wmux")), ("entrypoint", Some(shown))],
            );
            return;
        }
    }
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

    let mut payload = match read_stdin(log) {
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
    if !modes.permission_gate
        && hook != "PermissionRequest"
        && js::truthy(payload)
        && non_empty(payload, "agent_id").is_some()
        && non_empty(payload, "agent_type").is_none()
    {
        log("skip-internal-fork", vec![("hook", hook_field())]);
        return;
    }
    if hook == "PreToolUse" && !modes.permission_gate && !str_is(payload, "tool_name", "AskUserQuestion") {
        // `payload && payload.tool_name`
        let tool = if js::truthy(payload) {
            logged(payload.and_then(|p| p.get("tool_name")))
        } else {
            payload.cloned()
        };
        log("skip-pretooluse", vec![("tool", tool)]);
        return;
    }
    if hook == "PreToolUse" && !modes.permission_gate && paths::env("WMUX_MOA_DELEGATE_WORKER").as_deref() == Some("1")
    {
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

    // The gate and the context are main's alone: the daemon has neither a
    // gate nor a brain lane to consult.
    let targets: Vec<Target> = claude::resolve_targets(modes.gate || modes.context)
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
    let tail = transcript_path
        .as_deref()
        .and_then(|p| transcript::Tail::for_hook(&hook, p));
    let usage = match (hook.as_str(), &tail) {
        ("Stop" | "SubagentStop", Some(tail)) => transcript::usage(tail, &read_log),
        _ => None,
    };
    let leftover_work = match (hook.as_str(), &tail) {
        ("Stop", Some(tail)) => transcript::leftover_work(tail, &read_log),
        _ => 0,
    };
    let permission_mode = transcript::permission_mode(&hook, tail.as_ref(), payload, &read_log);

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

    let kind = if modes.permission_gate {
        "agent.awaiting_permission"
    } else if hook == "PostToolUse" {
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
        // Best effort, as Node's console.error: a broken stderr is not an error.
        let _ = writeln!(std::io::stderr(), "{line}");
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
    // The permission gate waits for the phone's answer.
    let policy = if modes.permission_gate {
        &PERMISSION_GATE_POLICY
    } else {
        &CLAUDE_POLICY
    };
    let (result, target) = claude_rpc::send_to_targets(&targets, build_line, &js(&request_id), kind, policy);
    let target_field = target.map(|t| Json::Str(js(t.name)));
    let outer_ok = result.get("ok") == Some(&Json::Bool(true));
    let inner = result.get("result");
    let inner_ok = outer_ok && inner.and_then(|r| r.get("ok")) == Some(&Json::Bool(true));
    // `x ?? 'unknown'`
    let or_unknown = |v: Option<&Json>| logged(v.filter(|v| **v != Json::Null)).or_else(|| s("unknown"));
    if inner_ok {
        log("ok", vec![("hook", hook_field()), ("target", target_field.clone())]);
    } else if outer_ok {
        log(
            "rpc-rejected",
            vec![
                ("hook", hook_field()),
                ("target", target_field.clone()),
                ("reason", or_unknown(inner.and_then(|r| r.get("reason")))),
            ],
        );
    } else {
        log(
            "rpc-failed",
            vec![
                ("hook", hook_field()),
                ("target", target_field.clone()),
                ("error", or_unknown(result.get("error"))),
                ("detail", logged(result.get("detail"))),
            ],
        );
    }

    // The Stop gate: an explicit refusal, or an answer lost after the request
    // provably reached main, ends in exit 2 with the reason on stderr; all
    // else allows. The exit code is stored before anything is written.
    let fields = || vec![("hook", hook_field()), ("target", target_field.clone())];
    // A verdict's text goes out right before its log line, and its loss, when
    // the reader went away, is logged after it; the exit code stays.
    let answer = |fd: i32, text: &str, outcome: &str, extra: Vec<(&'static str, Option<Json>)>| {
        let written = text.is_empty() || write_out(fd, text.as_bytes());
        let mut line = fields();
        line.extend(extra);
        log(outcome, line);
        if !written {
            log(if fd == 1 { "stdout-lost" } else { "stderr-lost" }, fields());
        }
        panic_after_verdict_for_tests();
    };
    // A refusal: exit 2, stored before anything is written, and its reason
    // on stderr.
    let refuse = |outcome: &str, text: &str, extra: Vec<(&'static str, Option<Json>)>| {
        set_exit_code(2);
        answer(2, text, outcome, extra);
    };
    let block_reason = |r: Option<&Json>| {
        r.and_then(|r| r.get("block"))
            .filter(|b| js::truthy(Some(b)))
            .and_then(|b| b.get("reason"))
            .and_then(Json::as_str)
            .filter(|reason| !reason.is_empty())
            .map(|reason| js::lossy(reason) + "\n")
    };

    // The Stop gate: an explicit refusal, or an answer lost after the request
    // provably reached main, ends in exit 2 with the reason on stderr; all
    // else allows.
    if modes.gate && inner_ok {
        if let Some(reason) = block_reason(inner) {
            refuse("gate-blocked", &reason, vec![]);
        }
    } else if modes.gate && is_gate_answer_lost(&result) {
        refuse(
            "gate-fail-closed",
            GATE_LOST_TEXT,
            vec![("error", logged(result.get("error")))],
        );
    }

    // The HQ brain's prompt: only an explicit refusal blocks it (a lost
    // answer lets it run); else main's additionalContext goes to stdout.
    if modes.context && inner_ok {
        let context = inner
            .and_then(|r| r.get("additionalContext"))
            .and_then(Json::as_str)
            .filter(|t| !t.is_empty());
        if let Some(reason) = block_reason(inner) {
            refuse("prompt-blocked", &reason, vec![]);
        } else if let Some(context) = context {
            let line = hook_output_line(vec![
                ("hookEventName", Json::Str(js("UserPromptSubmit"))),
                ("additionalContext", Json::Str(context.clone())),
            ]);
            answer(1, &line, "prompt-context", vec![]);
        }
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
        spool_resume_binding(&paths::wmux_home_dir(), pty, session, &record, ts as f64, log);
    }

    // The permission gate's verdict: only `allow` or `deny` is written, right
    // before its log line; anything else is no opinion. Always exit 0, over
    // any other mode's code.
    if modes.permission_gate {
        let decision = inner.and_then(|r| r.get("permissionDecision")).filter(|_| inner_ok);
        let verdict = match decision {
            Some(Json::Str(d)) if *d == js("allow") => "allow",
            Some(Json::Str(d)) if *d == js("deny") => "deny",
            _ => "no-opinion",
        };
        set_exit_code(0);
        let mut line = String::new();
        if verdict != "no-opinion" {
            let mut fields = vec![
                ("hookEventName", Json::Str(js("PreToolUse"))),
                ("permissionDecision", Json::Str(js(verdict))),
            ];
            if verdict == "deny" {
                fields.push(("permissionDecisionReason", Json::Str(js(DENY_REASON))));
            }
            line = hook_output_line(fields);
        }
        answer(1, &line, "permission-gate", vec![("verdict", s(verdict))]);
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
/// (retryable: false); a connect error, written or not, fails open. One such
/// connect error is this transport's own: a poll(2) failure after the write
/// (claude_rpc's `lost`) has no Node twin, and it fails open too.
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
    fn no_source_can_log_an_unported_decision() {
        // Every decision mode runs here, so no outcome says one did not; log
        // outcomes are literals, so a source without it cannot write it.
        let unported = concat!("decision", "-unported");
        let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut read = 0;
        for entry in std::fs::read_dir(src).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                assert!(!text.contains(unported), "{}", path.display());
                read += 1;
            }
        }
        assert!(read > 10);
    }

    #[test]
    fn every_flag_the_bridge_reads_is_a_mode_here() {
        // main() reads its modes as `process.argv.slice(3).includes('--x')`: a
        // flag added there and not here would run as a plain hook.
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../integrations/claude/bin/wmux-bridge.mjs"
        );
        let source = std::fs::read_to_string(path).unwrap();
        let mut flags: Vec<&str> = source
            .split("argv.slice(3).includes('")
            .skip(1)
            .map(|rest| rest.split('\'').next().unwrap())
            .collect();
        flags.sort();
        assert_eq!(flags, ["--context", "--gate", "--permission-gate"]);
        for flag in flags {
            let m = Modes::of("UserPromptSubmit", &[js(flag)]);
            let set = [m.gate, m.context, m.permission_gate].iter().filter(|b| **b).count();
            assert_eq!(set, 1, "{flag}");
        }
    }

    #[test]
    fn the_decision_texts_are_the_bridges() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../integrations/claude/bin/wmux-bridge.mjs"
        );
        let source = std::fs::read_to_string(path).unwrap();
        let (first, second) = GATE_LOST_TEXT.split_at(GATE_LOST_TEXT.find("Do not").unwrap());
        let second = second.strip_suffix('\n').unwrap();
        assert!(
            source.contains(&format!("'{first}'\n        + '{second}\\n'")),
            "{GATE_LOST_TEXT}"
        );
        assert!(source.contains(&format!("'{DENY_REASON}'")));
    }

    #[test]
    fn a_panic_after_the_verdict_keeps_its_exit_code() {
        // The uncaught path reads the stored code: what a release build does
        // when anything panics after a gate block.
        let logged = std::sync::Mutex::new(Vec::new());
        let log = |outcome: &str, _: Vec<(&str, Option<Json>)>| logged.lock().unwrap().push(outcome.to_string());
        let outcome = on_own_stack(STACK_BYTES, || {
            set_exit_code(2);
            panic!("after the verdict");
        });
        assert_eq!(finish(outcome, &log), 2);
        assert_eq!(*logged.lock().unwrap(), ["uncaught"]);
        set_exit_code(0);
        assert_eq!(finish(Ok(()), &log), 0);
    }

    #[test]
    fn output_stops_when_the_wait_cannot_go_on() {
        // A full non-blocking descriptor whose poll fails, or cannot watch it
        // (POLLNVAL, as macOS poll(2) answers for some devices), or reports an
        // error: the write ends after that one wait, it does not spin.
        use std::os::fd::AsRawFd;
        let (writer, _reader) = std::os::unix::net::UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        let big = vec![b'x'; 4 * 1024 * 1024];
        for answer in [
            Ok(unix_sys::POLLNVAL),
            Ok(unix_sys::POLLERR | unix_sys::POLLOUT),
            Err(std::io::Error::from_raw_os_error(22)),
        ] {
            let waits = std::cell::Cell::new(0);
            let wait = |_: i32| {
                waits.set(waits.get() + 1);
                match &answer {
                    Ok(revents) => Ok(*revents),
                    Err(e) => Err(std::io::Error::from_raw_os_error(e.raw_os_error().unwrap())),
                }
            };
            assert!(!write_waiting(writer.as_raw_fd(), &big, wait), "{answer:?}");
            assert_eq!(waits.get(), 1, "{answer:?}");
        }
    }

    #[test]
    fn output_waits_on_a_full_non_blocking_reader_and_reports_a_gone_one() {
        use std::io::Read;
        use std::os::fd::AsRawFd;
        let (writer, mut reader) = std::os::unix::net::UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        let big = vec![b'x'; 4 * 1024 * 1024];
        let drain = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let mut got = Vec::new();
            reader.read_to_end(&mut got).unwrap();
            got.len()
        });
        assert!(write_out(writer.as_raw_fd(), &big));
        drop(writer);
        assert_eq!(drain.join().unwrap(), big.len());
        let (writer, reader) = std::os::unix::net::UnixStream::pair().unwrap();
        drop(reader);
        assert!(!write_out(writer.as_raw_fd(), b"lost\n"));
    }

    #[test]
    fn a_run_whose_thread_cannot_start_fails_open() {
        use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
        let ran = AtomicBool::new(false);
        // No such stack can be mapped: the spawn fails and nothing runs.
        assert!(on_own_stack(1 << 60, || ran.store(true, SeqCst)).is_err());
        assert!(!ran.load(SeqCst));
        assert_eq!(on_own_stack(STACK_BYTES, || ran.store(true, SeqCst)), Ok(()));
        assert!(ran.load(SeqCst));
        assert_eq!(
            on_own_stack(STACK_BYTES, || panic!("{RANGE_ERROR}")),
            Err(RANGE_ERROR.to_string())
        );
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
        let logged = std::sync::Mutex::new(Vec::new());
        let log = |outcome: &str, _: Vec<(&str, Option<Json>)>| logged.lock().unwrap().push(outcome.to_string());
        let record = Json::Obj(vec![(js("ptyId"), Json::Str(js("p/1"))), (js("ts"), Json::Num(ts))]);
        spool_resume_binding(home, &js("p/1"), &js("s1"), &record, ts, &log);
        logged.into_inner().unwrap()
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
    fn the_modes_are_read_as_main_reads_them() {
        let modes = |hook: &str, f: &[&str]| Modes::of(hook, &f.iter().map(|x| js(x)).collect::<Vec<_>>());
        // argv-flags-any-position, gate-with-permission-gate
        let both = modes("Stop", &["--unknown", "--gate", "--permission-gate"]);
        assert!(both.gate && both.permission_gate && !both.context);
        // argv-context-needs-user-prompt-submit: --context elsewhere is ignored.
        assert!(!modes("Stop", &["--context"]).context);
        assert!(modes("UserPromptSubmit", &["--context"]).context);
        let none = modes("Stop", &["--gated", "gate", "--permission-gated"]);
        assert!(!none.gate && !none.context && !none.permission_gate);
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
