//! `where` for a hook outside any wmux pane (whereFromEnv, whereText,
//! queryTmuxTarget and parseTmuxTarget in wmux-bridge.mjs): which
//! multiplexer, connection or terminal the agent runs in, from env alone,
//! plus one bounded `tmux` query on SessionStart and UserPromptSubmit.
//! Unix only, like the native Claude hook; so the WSL-on-Windows rule
//! (never ask a Windows-side tmux) cannot arise here.

use crate::js::{self, JsStr, Json};
use std::time::{Duration, Instant};

const WHERE_FIELD_MAX: usize = 64;
const TMUX_QUERY_TIMEOUT: Duration = Duration::from_millis(150);

/// whereText: control characters (C0, DEL, C1) removed, trimmed, cut to 64
/// UTF-16 units (a surrogate pair may be split, as `slice` splits it),
/// trimmed again; None when nothing is left.
pub fn where_text(value: Option<&[u16]>) -> Option<JsStr> {
    let clean: JsStr = value?
        .iter()
        .copied()
        .filter(|&c| !(c <= 0x1f || (0x7f..=0x9f).contains(&c)))
        .collect();
    let trimmed = js::trim(&clean);
    let cut = js::trim(&trimmed[..trimmed.len().min(WHERE_FIELD_MAX)]);
    (!cut.is_empty()).then(|| cut.to_vec())
}

/// parseTmuxTarget: `session:window` split at the last colon, which must
/// not be the first character.
pub fn parse_tmux_target(text: &[u16]) -> Option<(JsStr, JsStr)> {
    let line = js::trim(text);
    let cut = line.iter().rposition(|&c| c == u16::from(b':'))?;
    (cut > 0).then(|| (line[..cut].to_vec(), line[cut + 1..].to_vec()))
}

/// queryTmuxTarget: `tmux display-message -p [-t <pane>] '#S:#I'`, given
/// 150 ms; tmux missing, a non-zero exit or no answer in time is None.
pub fn query_tmux(tmux_pane: Option<&std::ffi::OsStr>) -> Option<(JsStr, JsStr)> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("tmux");
    cmd.args(["display-message", "-p"]);
    if let Some(pane) = tmux_pane.filter(|p| !p.is_empty()) {
        cmd.arg("-t").arg(pane);
    }
    cmd.arg("#S:#I")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + TMUX_QUERY_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                terminate(&child);
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut child.stdout.take()?, &mut out).ok()?;
    parse_tmux_target(&js::js(&String::from_utf8_lossy(&out)))
}

/// SIGTERM, as spawnSync's timeout sends it.
fn terminate(child: &std::process::Child) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGTERM: i32 = 15;
    // SAFETY: signals our own, not yet reaped, child.
    unsafe { kill(child.id() as i32, SIGTERM) };
}

/// The env whereFromEnv reads, as UTF-16 (None when unset).
pub struct WhereEnv {
    pub tmux: Option<JsStr>,
    pub tmux_pane: Option<JsStr>,
    pub tmux_target: Option<JsStr>,
    pub sty: Option<JsStr>,
    pub zellij: Option<JsStr>,
    pub zellij_session_name: Option<JsStr>,
    pub ssh_connection: Option<JsStr>,
    pub term_program: Option<JsStr>,
    pub wsl_distro_name: Option<JsStr>,
}

fn set(v: &Option<JsStr>) -> bool {
    v.as_ref().is_some_and(|s| !s.is_empty())
}

/// whereFromEnv. `query` is asked only for a tmux hook, and only when
/// WMUX_TMUX_TARGET does not answer.
pub fn where_from_env(env: &WhereEnv, query: Option<&dyn Fn() -> Option<(JsStr, JsStr)>>) -> Option<Json> {
    let wsl_distro = where_text(env.wsl_distro_name.as_deref());
    let field = |k: &str, v: Option<JsStr>| v.map(|v| (js::js(k), Json::Str(v)));
    let mut fields: Vec<(JsStr, Json)> = if set(&env.tmux) || set(&env.tmux_pane) {
        let target = if set(&env.tmux_target) {
            parse_tmux_target(env.tmux_target.as_deref().unwrap_or_default())
        } else {
            query.and_then(|q| q())
        };
        let (session, window) = target.map_or((None, None), |(s, w)| (Some(s), Some(w)));
        [
            field("kind", Some(js::js("tmux"))),
            field("session", where_text(session.as_deref())),
            field("window", where_text(window.as_deref())),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else if set(&env.sty) {
        // `<pid>.<name>`; the name may itself contain dots.
        let sty = env.sty.as_deref().unwrap_or_default();
        let name = sty
            .iter()
            .position(|&c| c == u16::from(b'.'))
            .map_or(sty, |i| &sty[i + 1..]);
        [
            field("kind", Some(js::js("screen"))),
            field("session", where_text(Some(name))),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else if set(&env.zellij_session_name) || set(&env.zellij) {
        [
            field("kind", Some(js::js("zellij"))),
            field("session", where_text(env.zellij_session_name.as_deref())),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else if set(&env.ssh_connection) {
        // `<client ip> <client port> <server ip> <server port>`
        let conn = js::trim(env.ssh_connection.as_deref().unwrap_or_default());
        let first = conn.split(|&c| js::is_space(c)).next().unwrap_or_default();
        [
            field("kind", Some(js::js("ssh"))),
            field("label", where_text(Some(first))),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else if set(&env.term_program) {
        [
            field("kind", Some(js::js("terminal"))),
            field("label", where_text(env.term_program.as_deref())),
        ]
        .into_iter()
        .flatten()
        .collect()
    } else if wsl_distro.is_some() {
        vec![(js::js("kind"), Json::Str(js::js("unknown")))]
    } else {
        return None;
    };
    if let Some(distro) = wsl_distro {
        fields.push((js::js("wslDistro"), Json::Str(distro)));
    }
    Some(Json::Obj(fields))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::js;

    fn env() -> WhereEnv {
        WhereEnv {
            tmux: None,
            tmux_pane: None,
            tmux_target: None,
            sty: None,
            zellij: None,
            zellij_session_name: None,
            ssh_connection: None,
            term_program: None,
            wsl_distro_name: None,
        }
    }

    fn text(v: Option<Json>) -> String {
        let mut out = String::new();
        js::stringify(&v.unwrap_or(Json::Null), &mut out);
        out
    }

    #[test]
    fn where_text_cleans_cuts_and_splits_pairs_like_node() {
        // where-caps-and-control-chars
        let long = js(&format!("\u{1} {}", "x".repeat(70)));
        assert_eq!(where_text(Some(&long)), Some(js(&"x".repeat(64))));
        assert_eq!(where_text(Some(&js("  Ubu\u{7f}ntu  "))), Some(js("Ubuntu")));
        assert_eq!(where_text(Some(&js(" \u{85}\t "))), None);
        // 63 units then a pair: the cut keeps the high surrogate alone.
        let pair = js(&format!("{}\u{1f600}", "a".repeat(63)));
        let cut = where_text(Some(&pair)).unwrap();
        assert_eq!(cut.len(), 64);
        assert_eq!(cut[63], 0xd83d);
    }

    #[test]
    fn the_multiplexer_wins_and_a_wsl_distro_rides_along() {
        // where-tmux-target-env
        let mut e = env();
        e.tmux = Some(js("/tmp/tmux-1/default,1,0"));
        e.tmux_target = Some(js("work:sub:3"));
        e.wsl_distro_name = Some(js("Ubuntu"));
        e.term_program = Some(js("iTerm.app"));
        assert_eq!(
            text(where_from_env(&e, None)),
            r#"{"kind":"tmux","session":"work:sub","window":"3","wslDistro":"Ubuntu"}"#
        );
        // where-tmux-without-query: no answer, no fields beyond the kind.
        let mut e = env();
        e.tmux_pane = Some(js("%3"));
        assert_eq!(text(where_from_env(&e, None)), r#"{"kind":"tmux"}"#);
        let asked = || Some((js("s"), js("2")));
        assert_eq!(
            text(where_from_env(&e, Some(&asked))),
            r#"{"kind":"tmux","session":"s","window":"2"}"#
        );
    }

    #[test]
    fn the_other_kinds_follow_the_bridge_order() {
        let mut e = env();
        e.sty = Some(js("1234.my.session"));
        assert_eq!(
            text(where_from_env(&e, None)),
            r#"{"kind":"screen","session":"my.session"}"#
        );
        let mut e = env();
        e.zellij = Some(js("0"));
        e.zellij_session_name = Some(js("zz"));
        assert_eq!(text(where_from_env(&e, None)), r#"{"kind":"zellij","session":"zz"}"#);
        let mut e = env();
        e.ssh_connection = Some(js(" 10.0.0.1 50000 10.0.0.2 22"));
        e.term_program = Some(js("iTerm.app"));
        assert_eq!(text(where_from_env(&e, None)), r#"{"kind":"ssh","label":"10.0.0.1"}"#);
        let mut e = env();
        e.term_program = Some(js("iTerm.app"));
        assert_eq!(
            text(where_from_env(&e, None)),
            r#"{"kind":"terminal","label":"iTerm.app"}"#
        );
        let mut e = env();
        e.wsl_distro_name = Some(js("Debian"));
        assert_eq!(
            text(where_from_env(&e, None)),
            r#"{"kind":"unknown","wslDistro":"Debian"}"#
        );
        assert!(where_from_env(&env(), None).is_none());
        // Empty values are unset.
        let mut e = env();
        e.tmux = Some(Vec::new());
        assert!(where_from_env(&e, None).is_none());
    }

    #[test]
    fn a_tmux_target_needs_a_colon_past_the_start() {
        assert_eq!(parse_tmux_target(&js(" a:b:1\n")), Some((js("a:b"), js("1"))));
        assert_eq!(parse_tmux_target(&js(":1")), None);
        assert_eq!(parse_tmux_target(&js("none")), None);
    }

    #[test]
    fn a_tmux_query_without_tmux_is_nothing_and_quick() {
        let start = Instant::now();
        // Whatever this host has, the answer comes within the bound.
        let _ = query_tmux(None);
        assert!(start.elapsed() < Duration::from_millis(1000));
    }
}
