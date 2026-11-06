//! `wmux-native hook <flavour> [<Event>]`: the native twin of
//! integrations/shared/bin/wmux-hooks-bridge.mjs.
//!
//! Same contract, rule for rule: read the payload from stdin (capped), map
//! (flavour, event, payload) to the canonical AgentSignal envelope, send it
//! with `hooks.signal` to the first wmux endpoint that answers (daemon first),
//! log the outcome per flavour, write nothing to stdout and exit 0 under a
//! hard timeout. The flavour table is flavours.json, which
//! hookFlavours.lockstep.test.ts holds equal to the Node bridge's FLAVOURS and
//! to src/shared/hooks/hookFlavours.ts.
//!
//! METADATA ONLY: the envelope reads the event name, the session id, the cwd
//! and a session-start `source`. Nothing else in the payload is read, logged
//! or forwarded.

use crate::js::{self, js, JsStr, Json};
use crate::paths;
use crate::rpc::{self, Target, HOOK_TIMEOUT};
use crate::targets;
use std::io::Read;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Stamped on every log line, as BRIDGE_VERSION in the Node bridge.
const BRIDGE_VERSION: &str = "0.1.0";
const MAX_STDIN_BYTES: usize = 256 * 1024;
/// #1111: the main pipe allows exactly this clientName its one method.
const WMUX_CLIENT_NAME: &str = "wmux-hook-bridge";
const FORWARDED_SESSION_SOURCES: [&str; 3] = ["startup", "resume", "clear"];

pub const FLAVOURS_JSON: &str = include_str!("../flavours.json");

pub struct Rule {
    pub kind: String,
    pub when: Option<(JsStr, JsStr)>,
}

pub struct Flavour {
    pub id: String,
    pub agent: String,
    pub events: Vec<(JsStr, Rule)>,
    pub session_id_fields: Vec<String>,
    pub cwd_fields: Vec<String>,
    pub source_field: Option<String>,
    pub log_file: String,
    pub request_prefix: String,
}

fn text(v: Option<&Json>) -> String {
    v.and_then(Json::as_str).map(|s| js::lossy(s)).unwrap_or_default()
}

fn texts(v: Option<&Json>) -> Vec<String> {
    match v {
        Some(Json::Arr(items)) => items.iter().map(|i| text(Some(i))).collect(),
        _ => Vec::new(),
    }
}

pub fn flavours() -> &'static [Flavour] {
    static TABLE: OnceLock<Vec<Flavour>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table = js::parse(&js(FLAVOURS_JSON)).expect("flavours.json parses");
        let Json::Obj(rows) = &table else {
            panic!("flavours.json is not an object")
        };
        rows.iter()
            .map(|(id, row)| Flavour {
                id: js::lossy(id),
                agent: text(row.get("agent")),
                events: match row.get("events") {
                    Some(Json::Obj(events)) => events
                        .iter()
                        .map(|(name, rule)| {
                            let when = rule
                                .get("when")
                                .map(|w| (js(&text(w.get("field"))), js(&text(w.get("equals")))));
                            (
                                name.clone(),
                                Rule {
                                    kind: text(rule.get("kind")),
                                    when,
                                },
                            )
                        })
                        .collect(),
                    _ => Vec::new(),
                },
                session_id_fields: texts(row.get("sessionIdFields")),
                cwd_fields: texts(row.get("cwdFields")),
                source_field: row.get("sourceField").and_then(Json::as_str).map(|s| js::lossy(s)),
                log_file: text(row.get("logFile")),
                request_prefix: text(row.get("requestPrefix")),
            })
            .collect()
    })
}

pub fn flavour_for(id: Option<&[u16]>) -> Option<&'static Flavour> {
    let id = id?;
    flavours().iter().find(|f| js(&f.id) == id)
}

impl Flavour {
    fn rule(&self, event: &[u16]) -> Option<&Rule> {
        self.events.iter().find(|(name, _)| name == event).map(|(_, r)| r)
    }
}

fn non_empty(v: Option<&Json>) -> Option<&JsStr> {
    v.and_then(Json::as_str).filter(|s| !s.is_empty())
}

fn first_str<'p>(payload: &'p Json, fields: &[String]) -> Option<&'p JsStr> {
    fields.iter().find_map(|f| non_empty(payload.get(f)))
}

/// SESSION_ID_RE: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
fn is_session_id(s: &[u16]) -> bool {
    let alnum = |c: u16| c < 0x80 && (c as u8).is_ascii_alphanumeric();
    !s.is_empty()
        && s.len() <= 128
        && alnum(s[0])
        && s[1..]
            .iter()
            .all(|&c| alnum(c) || matches!(c, 0x2E | 0x5F | 0x3A | 0x2D))
}

/// resolveEventName: the argv name, else the payload's `hook_event_name`.
pub fn resolve_event_name(payload: Option<&Json>, argv_event: Option<&[u16]>) -> Option<JsStr> {
    if let Some(e) = argv_event.filter(|e| !e.is_empty()) {
        return Some(e.to_vec());
    }
    match payload {
        Some(p @ Json::Obj(_)) => non_empty(p.get("hook_event_name")).cloned(),
        _ => None,
    }
}

/// What the envelope reads from the process: the env vars and the cwd.
pub struct Context {
    pub pty_id: Option<JsStr>,
    pub workspace_id: Option<JsStr>,
    pub surface_id: Option<JsStr>,
    /// None when the process cwd is unreadable (deleted): read only if the
    /// payload names no cwd, as `?? process.cwd()` is.
    pub cwd: Option<JsStr>,
    pub now_ms: u64,
}

/// buildHookEnvelope, serialised as JSON.stringify would. None when the event
/// is not one wmux acts on, its `when` does not hold, or no pane is named.
pub fn build_envelope(
    flavour: &Flavour,
    payload: Option<&Json>,
    argv_event: Option<&[u16]>,
    ctx: &Context,
) -> Option<(String, String)> {
    let payload @ Json::Obj(_) = payload? else { return None };
    let event = resolve_event_name(Some(payload), argv_event)?;
    let rule = flavour.rule(&event)?;
    if let Some((field, equals)) = &rule.when {
        if payload.get(&js::lossy(field)).and_then(Json::as_str) != Some(equals) {
            return None;
        }
    }
    let pty_id = ctx.pty_id.as_ref().filter(|s| !s.is_empty())?;
    let session_id = first_str(payload, &flavour.session_id_fields).filter(|s| is_session_id(s));
    let source = match (&flavour.source_field, rule.kind == "agent.session_start") {
        (Some(field), true) => first_str(payload, std::slice::from_ref(field)),
        _ => None,
    }
    .filter(|s| FORWARDED_SESSION_SOURCES.iter().any(|f| js(f) == **s));

    let mut o = String::from("{\"kind\":");
    js::quote_str(&rule.kind, &mut o);
    o.push_str(",\"agent\":");
    js::quote_str(&flavour.agent, &mut o);
    if let Some(s) = session_id {
        o.push_str(",\"agentSessionId\":");
        js::quote(s, &mut o);
    }
    o.push_str(",\"ptyId\":");
    js::quote(pty_id, &mut o);
    for (key, value) in [("workspaceId", &ctx.workspace_id), ("surfaceId", &ctx.surface_id)] {
        if let Some(v) = value.as_ref().filter(|v| !v.is_empty()) {
            o.push_str(&format!(",\"{key}\":"));
            js::quote(v, &mut o);
        }
    }
    o.push_str(",\"cwd\":");
    let cwd = first_str(payload, &flavour.cwd_fields).or(ctx.cwd.as_ref());
    // process.cwd() throws here in Node, which ends in the `uncaught` log line.
    js::quote(cwd.expect("process.cwd() failed"), &mut o);
    o.push_str(",\"payload\":{");
    if let Some(s) = source {
        o.push_str("\"source\":");
        js::quote(s, &mut o);
    }
    o.push_str(&format!("}},\"ts\":{}}}", ctx.now_ms));
    Some((rule.kind.clone(), o))
}

// ----- Log -----------------------------------------------------------------

/// `new Date(ms).toISOString()`.
pub fn iso_time(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A log field value: a string this file built, or a value off an RPC reply.
pub enum Field {
    Str(JsStr),
    Json(Json),
    Strs(Vec<String>),
}

/// logEvent. Never logs a payload field; `extra` is built here only. The
/// `runtime` key is an addition, so a log shows which bridge ran. Equivalent
/// to the Node line, not byte-for-byte: see the parity suite's header.
pub fn log_event(flavour: Option<&Flavour>, outcome: &str, extra: Vec<(&str, Option<Field>)>) {
    let mut line = String::from("{\"ts\":");
    js::quote_str(&iso_time(now_ms()), &mut line);
    line.push_str(",\"bridge\":");
    js::quote_str(BRIDGE_VERSION, &mut line);
    // `flavour` keeps its position when `extra` supplies it (object spread).
    let mut extra = extra;
    let flavour_value = match flavour {
        Some(f) => Some(Field::Str(js(&f.id))),
        None => extra
            .iter_mut()
            .find(|(k, _)| *k == "flavour")
            .and_then(|(_, v)| v.take()),
    };
    extra.retain(|(k, _)| *k != "flavour");
    let mut fields: Vec<(&str, Option<Field>)> = vec![("flavour", flavour_value)];
    fields.push(("pid", Some(Field::Json(Json::Num(std::process::id() as f64)))));
    fields.push(("outcome", Some(Field::Str(js(outcome)))));
    fields.push(("runtime", Some(Field::Str(js("native")))));
    fields.extend(extra);
    for (key, value) in fields {
        let Some(value) = value else { continue };
        line.push_str(&format!(",\"{key}\":"));
        match value {
            Field::Str(s) => js::quote(&s, &mut line),
            Field::Json(v) => js::stringify(&v, &mut line),
            Field::Strs(list) => {
                line.push('[');
                for (i, s) in list.iter().enumerate() {
                    if i > 0 {
                        line.push(',');
                    }
                    js::quote_str(s, &mut line);
                }
                line.push(']');
            }
        }
    }
    line.push_str("}\n");
    append_log(flavour, &line);
}

fn append_log(flavour: Option<&Flavour>, line: &str) {
    let dir = paths::wmux_home_dir();
    crate::fsx::ensure_dir(&dir, 0o700);
    let file = flavour.map_or("hooks-bridge.log", |f| f.log_file.as_str());
    let _ = crate::fsx::append(&paths::join(&[&dir, file]), line.as_bytes());
}

/// `String(x).slice(0, n)` on UTF-16 units.
fn slice_units(s: &[u16], n: usize) -> JsStr {
    s[..s.len().min(n)].to_vec()
}

// ----- stdin -----------------------------------------------------------------

/// readStdin: Ok(None) for an empty body, Err for one JSON.parse rejects.
fn read_stdin() -> Result<Option<Json>, ()> {
    let held = read_capped(std::io::stdin().lock())?;
    let text = js::decode_utf8_trimmed(&held);
    if text.is_empty() {
        return Ok(None);
    }
    js::parse(&text).map(Some)
}

/// The bytes the Node reader keeps. Node takes stdin in 64 KiB chunks and
/// keeps whole chunks while it holds less than the cap, then drains to EOF, so
/// the cut falls on a 64 KiB boundary. A pipe hands bytes over in whatever
/// sizes it likes (smaller on Linux than on macOS), so blocks are filled to
/// 64 KiB here before the cap is applied; otherwise the cut, and with it
/// whether an over-cap payload parses, would depend on the pipe.
fn read_capped(mut input: impl Read) -> Result<Vec<u8>, ()> {
    const BLOCK: usize = 64 * 1024;
    let mut held: Vec<u8> = Vec::new();
    let mut block = vec![0u8; BLOCK];
    let mut filled = 0;
    loop {
        match input.read(&mut block[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // An inherited non-blocking stdin: wait for data as Node's reader does.
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }
            Err(_) => return Err(()),
        }
        if filled == BLOCK {
            if held.len() < MAX_STDIN_BYTES {
                held.extend_from_slice(&block);
            }
            filled = 0;
        }
    }
    if held.len() < MAX_STDIN_BYTES {
        held.extend_from_slice(&block[..filled]);
    }
    Ok(held)
}

// ----- Main ----------------------------------------------------------------

/// resolveTargets: the override is one target addressed to main, with main's
/// token; otherwise the daemon, then main.
fn resolve_targets() -> Vec<Target> {
    match targets::pipe_override() {
        Some(pipe) => targets::main_token()
            .map(|token| Target {
                name: "main",
                pipe,
                token,
                method: targets::MAIN_METHOD,
            })
            .into_iter()
            .collect(),
        None => targets::default_walk(true),
    }
}

/// A v4 UUID from the OS generator, as crypto.randomUUID() formats it.
fn random_uuid() -> String {
    let mut b = crate::os_random::bytes16();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn current_context() -> Context {
    Context {
        pty_id: paths::env_js("WMUX_PTY_ID"),
        workspace_id: paths::env_js("WMUX_WORKSPACE_ID"),
        surface_id: paths::env_js("WMUX_SURFACE_ID"),
        cwd: std::env::current_dir().ok().map(|c| paths::os_to_js(c.as_os_str())),
        now_ms: now_ms(),
    }
}

/// runHook.
pub fn run_hook(flavour_id: Option<&[u16]>, argv_event: Option<&[u16]>) {
    let Some(flavour) = flavour_for(flavour_id) else {
        let shown = slice_units(flavour_id.unwrap_or_default(), 32);
        log_event(None, "unknown-flavour", vec![("flavour", Some(Field::Str(shown)))]);
        return;
    };
    let Ok(payload) = read_stdin() else {
        // Parse diagnostics can quote the input; never copy them to the log.
        log_event(Some(flavour), "malformed-stdin", vec![]);
        return;
    };
    let ctx = current_context();
    let Some((kind, envelope)) = build_envelope(flavour, payload.as_ref(), argv_event, &ctx) else {
        let event = resolve_event_name(payload.as_ref(), argv_event);
        let known = event.as_ref().is_some_and(|e| flavour.rule(e).is_some());
        let event_field = event.map(|e| Field::Str(slice_units(&e, 64)));
        log_event(
            Some(flavour),
            if known { "not-forwarded" } else { "ignored-event" },
            vec![("event", event_field)],
        );
        return;
    };

    let targets = resolve_targets();
    if targets.is_empty() {
        let paths = vec![paths::daemon_auth_token_path(), paths::auth_token_path()];
        log_event(
            Some(flavour),
            "no-auth-token",
            vec![("paths", Some(Field::Strs(paths)))],
        );
        return;
    }

    let request_id = format!("{}-{}", flavour.request_prefix, random_uuid());
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
    let (result, target) = rpc::send_to_targets(&targets, build_line, &js(&request_id), &kind, &rpc::SHARED_POLICY);
    let outer_ok = result.get("ok") == Some(&Json::Bool(true));
    let inner = result.get("result");
    let inner_ok = outer_ok && inner.and_then(|r| r.get("ok")) == Some(&Json::Bool(true));
    let target_field = target.map(|t| Field::Str(js(t.name)));
    let kind_field = Some(Field::Str(js(&kind)));
    if inner_ok {
        log_event(
            Some(flavour),
            "ok",
            vec![("kind", kind_field), ("target", target_field)],
        );
    } else {
        // A reply value is logged whole, as JSON.stringify would. One nested
        // past V8's stack ends the run the way Node's RangeError does: in the
        // `uncaught` line, never in a stack overflow.
        let take = |v: Option<&Json>| {
            v.map(|v| {
                assert!(!v.deeper_than(1000), "RangeError: Maximum call stack size exceeded");
                Field::Json(v.clone())
            })
        };
        log_event(
            Some(flavour),
            if outer_ok { "rpc-rejected" } else { "rpc-failed" },
            vec![
                ("kind", kind_field),
                ("target", target_field),
                ("reason", take(inner.and_then(|r| r.get("reason")))),
                ("error", take(result.get("error"))),
                ("detail", take(result.get("detail"))),
            ],
        );
    }
}

/// runHookProcess: a self-enforced hard stop at twice the send budget (a stdin
/// that never reaches EOF would hang before the send), then exit 0 always.
pub fn run_hook_process(flavour_id: Option<JsStr>, argv_event: Option<JsStr>) -> ! {
    {
        let flavour = flavour_for(flavour_id.as_deref()).map(|f| f.id.clone());
        std::thread::spawn(move || {
            std::thread::sleep(HOOK_TIMEOUT * 2);
            let flavour = flavour.as_deref().and_then(|id| flavour_for(Some(&js(id))));
            log_event(flavour, "watchdog-exit", vec![]);
            std::process::exit(0);
        });
    }
    let outcome = std::panic::catch_unwind(|| run_hook(flavour_id.as_deref(), argv_event.as_deref()));
    if let Err(panic) = outcome {
        let message = panic
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        log_event(
            flavour_for(flavour_id.as_deref()),
            "uncaught",
            vec![("error", Some(Field::Str(js(&message))))],
        );
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context {
            pty_id: Some(js("pty-1")),
            workspace_id: None,
            surface_id: Some(js("s-1")),
            cwd: Some(js("/proc/cwd")),
            now_ms: 42,
        }
    }

    fn env(flavour: &str, payload: &str, event: Option<&str>) -> Option<String> {
        let f = flavour_for(Some(&js(flavour))).expect(flavour);
        let p = js::parse(&js(payload)).ok();
        build_envelope(f, p.as_ref(), event.map(js).as_deref(), &ctx()).map(|(_, e)| e)
    }

    #[test]
    fn builds_the_canonical_envelope() {
        assert_eq!(
            env(
                "copilot",
                r#"{"sessionId":"abc-1","cwd":"/w","source":"resume"}"#,
                Some("SessionStart")
            )
            .unwrap(),
            r#"{"kind":"agent.session_start","agent":"copilot","agentSessionId":"abc-1","ptyId":"pty-1","surfaceId":"s-1","cwd":"/w","payload":{"source":"resume"},"ts":42}"#
        );
        // Non-forwarded source, invalid session id, cwd falls back to the process.
        assert_eq!(
            env(
                "qwen",
                r#"{"hook_event_name":"SessionStart","session_id":"a b","source":"new"}"#,
                None
            )
            .unwrap(),
            r#"{"kind":"agent.session_start","agent":"qwen","ptyId":"pty-1","surfaceId":"s-1","cwd":"/proc/cwd","payload":{},"ts":42}"#
        );
    }

    #[test]
    fn drops_what_the_node_bridge_drops() {
        assert_eq!(
            env("gemini", r#"{"notification_type":"Other"}"#, Some("Notification")),
            None
        );
        assert!(env(
            "gemini",
            r#"{"notification_type":"ToolPermission"}"#,
            Some("Notification")
        )
        .is_some());
        assert_eq!(env("copilot", r#"{}"#, Some("PreToolUse")), None);
        assert_eq!(env("copilot", r#"[1]"#, Some("Stop")), None);
        assert_eq!(env("copilot", r#"{"hook_event_name":""}"#, None), None);
    }

    #[test]
    fn session_id_pattern() {
        assert!(is_session_id(&js("a")));
        assert!(is_session_id(&js(&format!("a{}", "b".repeat(127)))));
        assert!(!is_session_id(&js(&format!("a{}", "b".repeat(128)))));
        assert!(!is_session_id(&js("-a")));
        assert!(!is_session_id(&js("a/b")));
    }

    /// Hands out its bytes in the given chunk sizes, as a pipe can.
    struct Chunked(Vec<u8>, Vec<usize>);

    impl std::io::Read for Chunked {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let want = if self.1.is_empty() {
                self.0.len()
            } else {
                self.1.remove(0)
            };
            let n = want.min(buf.len()).min(self.0.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0.drain(..n);
            Ok(n)
        }
    }

    #[test]
    fn the_stdin_cap_falls_on_64k_blocks_whatever_the_pipe_hands_over() {
        // Node reads stdin in 64 KiB chunks and keeps whole chunks until the
        // cap is reached: 307 200 bytes keep 4 x 64 KiB = the cap, the rest is
        // dropped. A pipe that hands over 100 000 then 207 200 bytes must not
        // let the whole payload through.
        let payload = vec![b'x'; 307_200];
        for chunks in [
            vec![100_000, 207_200],
            vec![65_536; 5],
            vec![4096; 75],
            vec![262_143, 1, 45_056],
        ] {
            let held = read_capped(Chunked(payload.clone(), chunks.clone())).unwrap();
            assert_eq!(held.len(), MAX_STDIN_BYTES, "{chunks:?}");
        }
        // Under the cap, everything is kept.
        assert_eq!(
            read_capped(Chunked(vec![b'y'; 1000], vec![7, 993])).unwrap().len(),
            1000
        );
    }

    #[test]
    fn iso_time_matches_date() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_793_938_457_016), "2026-11-06T04:14:17.016Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
