//! The transcript readers of wmux-bridge.mjs: the session id from the
//! transcript's file name, token usage, the permission mode and the count of
//! background work left running. Each reads the tail of the session's JSONL
//! and is best-effort: a missing transcript is silently nothing, any other
//! failure is logged and is nothing.
//!
//! Lines are handled as Node handles them: the tail decoded as lossy UTF-8,
//! split on `\n`, blank lines (by JS trim) dropped, and when the read started
//! mid-file, everything up to the first `\n` dropped as a partial line.

use crate::fsx;
use crate::js::{self, is_space, JsStr, Json};
use std::collections::{HashMap, HashSet};

const TAIL_BYTES: u64 = 64 * 1024;
const LEFTOVER_TAIL_BYTES: u64 = 1024 * 1024;
const VALID_PERMISSION_MODES: [&str; 5] = ["bypassPermissions", "acceptEdits", "plan", "auto", "default"];
const TASK_STOP_TOOLS: [&str; 3] = ["TaskStop", "KillShell", "KillBash"];

/// How a reader reports a failure: `(outcome, error text)`.
pub type Log<'a> = &'a dyn Fn(&str, String);

/// sessionIdFromTranscript: the transcript's base name without `.jsonl`
/// (any case), else the fallback.
pub fn session_id(transcript_path: Option<&[u16]>, fallback: Option<JsStr>) -> Option<JsStr> {
    if let Some(path) = transcript_path.filter(|p| !p.is_empty()) {
        let base = path
            .rsplit(|&c| c == u16::from(b'/') || c == u16::from(b'\\'))
            .next()
            .unwrap_or(&[]);
        let suffix = js::js(".jsonl");
        let id = if base.len() >= suffix.len() && ends_with_ci(base, ".jsonl") {
            &base[..base.len() - suffix.len()]
        } else {
            base
        };
        if !id.is_empty() {
            return Some(id.to_vec());
        }
    }
    fallback
}

/// The non-blank lines of the tail; None for a transcript that is not there.
fn tail_lines(path: &str, max: u64) -> std::io::Result<Option<Vec<JsStr>>> {
    let Some((buf, offset)) = fsx::read_tail(path, max)? else {
        return Ok(None);
    };
    let tail = js::js(&String::from_utf8_lossy(&buf));
    let start = if offset > 0 {
        tail.iter().position(|&c| c == 0x0A).map_or(0, |i| i + 1)
    } else {
        0
    };
    Ok(Some(
        tail[start..]
            .split(|&c| c == 0x0A)
            .filter(|l| !js::trim(l).is_empty())
            .map(<[u16]>::to_vec)
            .collect(),
    ))
}

fn read(path: &str, max: u64, outcome: &str, log: Log) -> Option<Vec<JsStr>> {
    match tail_lines(path, max) {
        Ok(lines) => lines,
        Err(e) => {
            log(outcome, format!("Error: {e}"));
            None
        }
    }
}

fn num(v: Option<&Json>) -> f64 {
    match v {
        Some(Json::Num(n)) => *n,
        _ => 0.0,
    }
}

/// extractUsageFromTranscript: the last assistant message's usage.
pub fn usage(path: &str, log: Log) -> Option<Json> {
    let lines = read(path, TAIL_BYTES, "transcript-read-error", log)?;
    for line in lines.iter().rev() {
        let Ok(entry) = js::parse(line) else { continue };
        let message = entry.get("message");
        if str_is(entry.get("type"), "assistant") && js::truthy(message) && js::truthy(message?.get("usage")) {
            let u = message?.get("usage")?;
            let input = num(u.get("input_tokens"))
                + num(u.get("cache_creation_input_tokens"))
                + num(u.get("cache_read_input_tokens"));
            let output = num(u.get("output_tokens"));
            return Some(Json::Obj(vec![
                (js::js("inputTokens"), Json::Num(input)),
                (js::js("outputTokens"), Json::Num(output)),
                (js::js("totalTokens"), Json::Num(input + output)),
            ]));
        }
    }
    None
}

fn valid_mode(v: Option<&Json>) -> Option<JsStr> {
    let s = v?.as_str()?;
    VALID_PERMISSION_MODES
        .iter()
        .any(|m| *s == js::js(m))
        .then(|| s.clone())
}

/// extractPermissionModeFromTranscript: the last user or permission-mode
/// entry's valid permissionMode.
fn transcript_permission_mode(path: &str, log: Log) -> Option<JsStr> {
    let lines = read(path, TAIL_BYTES, "transcript-permission-read-error", log)?;
    lines.iter().rev().find_map(|line| {
        let entry = js::parse(line).ok()?;
        let kind = entry.get("type");
        (str_is(kind, "user") || str_is(kind, "permission-mode"))
            .then(|| valid_mode(entry.get("permissionMode")))
            .flatten()
    })
}

/// permissionModeForHook.
pub fn permission_mode(hook: &str, transcript_path: Option<&str>, payload: Option<&Json>, log: Log) -> Option<JsStr> {
    let reported = matches!(hook, "SessionStart" | "Stop" | "UserPromptSubmit")
        .then(|| payload.and_then(|p| p.get("permission_mode")))
        .flatten();
    let from_payload = valid_mode(reported);
    if hook == "UserPromptSubmit" {
        return from_payload;
    }
    if !matches!(hook, "SessionStart" | "Stop" | "SubagentStop") {
        return None;
    }
    transcript_path
        .and_then(|p| transcript_permission_mode(p, log))
        .or(from_payload)
}

fn str_is(v: Option<&Json>, s: &str) -> bool {
    v.and_then(Json::as_str).is_some_and(|x| *x == js::js(s))
}

// ----- countLeftoverBackgroundTasks -------------------------------------------

/// countLeftoverBackgroundTasks: background work the lead turn started and
/// neither saw finish nor stopped. 0 on any failure.
pub fn leftover_work(path: &str, log: Log) -> usize {
    let Some(lines) = read(path, LEFTOVER_TAIL_BYTES, "transcript-leftover-read-error", log) else {
        return 0;
    };
    // Node's Sets and Map; only the count comes out, so their order does not
    // matter here.
    let mut started: HashSet<JsStr> = HashSet::new();
    let mut result_texts: HashMap<JsStr, JsStr> = HashMap::new();
    let mut settled: HashSet<JsStr> = HashSet::new();
    let mut stopped: HashSet<JsStr> = HashSet::new();
    for line in &lines {
        if !contains(line, "\"tool_use\"")
            && !contains(line, "<task-notification>")
            && !contains(line, "\"tool_result\"")
            && !contains(line, "\"type\":\"user\"")
            && !task_stop_line(line)
        {
            continue;
        }
        let Ok(entry) = js::parse(line) else { continue };
        if !matches!(entry, Json::Obj(_) | Json::Arr(_)) {
            continue;
        }
        let message = entry.get("message");
        let content = match message.and_then(|m| m.get("content")) {
            Some(Json::Arr(items)) => Some(items),
            _ => None,
        };
        if str_is(entry.get("type"), "user")
            && entry.get("isMeta") != Some(&Json::Bool(true))
            && js::truthy(message)
            && entry.get("isCompactSummary") != Some(&Json::Bool(true))
            && !(js::truthy(entry.get("origin"))
                && str_is(entry.get("origin").and_then(|o| o.get("kind")), "task-notification"))
            && (matches!(message.and_then(|m| m.get("content")), Some(Json::Str(_)))
                || content.is_some_and(|c| {
                    !c.iter()
                        .any(|b| js::truthy(Some(b)) && str_is(b.get("type"), "tool_result"))
                }))
        {
            started.clear();
        }
        for block in content.into_iter().flatten() {
            if !matches!(block, Json::Obj(_) | Json::Arr(_)) {
                continue;
            }
            let id = block.get("id").and_then(Json::as_str);
            if str_is(block.get("type"), "tool_use") {
                if let Some(id) = id {
                    started.insert(id.clone());
                }
                let name = block.get("name").and_then(Json::as_str);
                let input = block.get("input");
                if name.is_some_and(|n| TASK_STOP_TOOLS.iter().any(|t| *n == js::js(t))) && js::truthy(input) {
                    let input = input.unwrap();
                    // `task_id ?? shell_id ?? bash_id`: null and absent fall through.
                    let task = ["task_id", "shell_id", "bash_id"]
                        .iter()
                        .map(|k| input.get(k))
                        .find(|v| !matches!(v, None | Some(Json::Null)))
                        .flatten();
                    if let Some(Json::Str(t)) = task {
                        if !t.is_empty() {
                            stopped.insert(t.clone());
                        }
                    }
                }
            }
            if str_is(block.get("type"), "tool_result") {
                if let Some(id) = block.get("tool_use_id").and_then(Json::as_str) {
                    let text = match block.get("content") {
                        Some(Json::Str(s)) => s.clone(),
                        Some(Json::Arr(parts)) => parts
                            .iter()
                            .flat_map(|c| match c.get("text") {
                                Some(Json::Str(t)) if js::truthy(Some(c)) => t.clone(),
                                _ => Vec::new(),
                            })
                            .collect(),
                        _ => Vec::new(),
                    };
                    result_texts.entry(id.clone()).or_insert(text);
                }
            }
        }
        let body = match entry.get("content") {
            Some(Json::Str(s)) => Some(s),
            _ => match entry.get("attachment") {
                Some(a) if js::truthy(Some(a)) => a.get("prompt").and_then(Json::as_str),
                _ => None,
            },
        };
        if let Some(body) = body.filter(|b| contains(b, "<task-notification>")) {
            if let Some(id) = tool_use_id(body) {
                settled.insert(id);
            }
        }
    }
    started
        .iter()
        .filter(|&id| !settled.contains(id))
        .filter_map(|id| {
            let text = result_texts.get(id).map_or(&[][..], Vec::as_slice);
            background_task_id(text)
        })
        .filter(|task| !stopped.contains(task))
        .count()
}

// ----- the regexes, by hand -------------------------------------------------------

fn contains(hay: &[u16], needle: &str) -> bool {
    let needle = js::js(needle);
    hay.windows(needle.len()).any(|w| w == needle.as_slice())
}

fn ascii_ci(c: u16, lit: u8) -> bool {
    c < 128 && (c as u8).eq_ignore_ascii_case(&lit)
}

/// `t[at..]` starts with `lit`, ASCII case-insensitively (regex `/i` without
/// `u` folds nothing outside ASCII onto ASCII).
fn starts_ci(t: &[u16], at: usize, lit: &str) -> bool {
    let lit = lit.as_bytes();
    t.len() >= at + lit.len() && t[at..at + lit.len()].iter().zip(lit).all(|(&c, &l)| ascii_ci(c, l))
}

fn ends_with_ci(t: &[u16], lit: &str) -> bool {
    t.len() >= lit.len() && starts_ci(t, t.len() - lit.len(), lit)
}

fn skip_space(t: &[u16], mut at: usize) -> usize {
    while at < t.len() && is_space(t[at]) {
        at += 1;
    }
    at
}

/// `\w` (ASCII).
fn is_word(c: u16) -> bool {
    c < 128 && ((c as u8).is_ascii_alphanumeric() || c == u16::from(b'_'))
}

/// `([\w-]+)` at `at`: the end of the run, when it is not empty.
fn id_run(t: &[u16], at: usize) -> Option<usize> {
    let end = at
        + t[at..]
            .iter()
            .take_while(|&&c| is_word(c) || c == u16::from(b'-'))
            .count();
    (end > at).then_some(end)
}

/// TASK_STOP_LINE_RE: `"name"\s*:\s*"(?:TaskStop|KillShell|KillBash)"` anywhere.
fn task_stop_line(line: &[u16]) -> bool {
    let key = js::js("\"name\"");
    (0..line.len()).any(|p| {
        if !line[p..].starts_with(&key) {
            return false;
        }
        let mut i = skip_space(line, p + key.len());
        if line.get(i) != Some(&u16::from(b':')) {
            return false;
        }
        i = skip_space(line, i + 1);
        TASK_STOP_TOOLS
            .iter()
            .any(|name| line[i..].starts_with(&js::js(&format!("\"{name}\""))))
    })
}

/// `/<tool-use-id>([^<]+)<\/tool-use-id>/`: the first id so delimited.
fn tool_use_id(body: &[u16]) -> Option<JsStr> {
    let open = js::js("<tool-use-id>");
    let close = js::js("</tool-use-id>");
    (0..body.len()).find_map(|p| {
        if !body[p..].starts_with(&open) {
            return None;
        }
        let start = p + open.len();
        let end = start + body[start..].iter().take_while(|&&c| c != u16::from(b'<')).count();
        (end > start && body[end..].starts_with(&close)).then(|| body[start..end].to_vec())
    })
}

/// BACKGROUND_TASK_ID_RE (case-insensitive, anchored at the start): the task
/// id of the first alternative that matches.
pub fn background_task_id(t: &[u16]) -> Option<JsStr> {
    let i = skip_space(t, 0);
    // ^\s*Command running in background with ID:\s*([\w-]+)
    let lit = "Command running in background with ID:";
    if starts_ci(t, i, lit) {
        let s = skip_space(t, i + lit.len());
        if let Some(e) = id_run(t, s) {
            return Some(t[s..e].to_vec());
        }
    }
    // ^\s*Command\b[^\n]*?moved to the background \(ID:\s*([\w-]+)\)
    if starts_ci(t, i, "Command") && t.get(i + 7).is_none_or(|&c| !is_word(c)) {
        let lit = "moved to the background (ID:";
        let mut p = i + 7;
        while p <= t.len() {
            if starts_ci(t, p, lit) {
                let s = skip_space(t, p + lit.len());
                if let Some(e) = id_run(t, s) {
                    if t.get(e) == Some(&u16::from(b')')) {
                        return Some(t[s..e].to_vec());
                    }
                }
            }
            if p == t.len() || t[p] == 0x0A {
                break;
            }
            p += 1;
        }
    }
    // ^\s*Monitor started \(task\s+([\w-]+)
    let lit = "Monitor started (task";
    if starts_ci(t, i, lit) {
        let s = skip_space(t, i + lit.len());
        if s > i + lit.len() {
            if let Some(e) = id_run(t, s) {
                return Some(t[s..e].to_vec());
            }
        }
    }
    // ^\s*Async agent launched successfully[\s\S]*?agentId:\s*([\w-]+)
    let lit = "Async agent launched successfully";
    if starts_ci(t, i, lit) {
        for p in i + lit.len()..t.len() {
            if starts_ci(t, p, "agentId:") {
                let s = skip_space(t, p + 8);
                if let Some(e) = id_run(t, s) {
                    return Some(t[s..e].to_vec());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testenv;
    use std::time::{Duration, Instant};

    /// A transcript in a fresh file; std::env::temp_dir reads TMPDIR, so hold
    /// testenv::lock().
    fn transcript(tag: &str, body: &str) -> String {
        let dir = std::env::temp_dir().join(format!("wmux-transcript-{tag}-{}", crate::hook::random_uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        std::fs::write(&path, body).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn remove(path: &str) {
        std::fs::remove_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
    }

    fn unlogged(outcome: &str, error: String) {
        panic!("{outcome}: {error}");
    }

    #[test]
    fn leftover_work_over_a_tail_of_many_dispatches_stays_fast() {
        let _env = testenv::lock();
        // As many tool_use ids as a 1 MiB tail holds; the first 4 000 left a
        // background task running.
        let uses: Vec<String> = (0..16_000)
            .map(|n| format!(r#"{{"type":"tool_use","id":"t{n}"}}"#))
            .collect();
        let results: Vec<String> = (0..4_000)
            .map(|n| {
                format!(
                    r#"{{"type":"tool_result","tool_use_id":"t{n}","content":"Command running in background with ID: b{n}"}}"#
                )
            })
            .collect();
        let body = format!(
            "{}\n{}\n",
            format_args!(r#"{{"type":"assistant","message":{{"content":[{}]}}}}"#, uses.join(",")),
            format_args!(r#"{{"type":"user","message":{{"content":[{}]}}}}"#, results.join(","))
        );
        assert!(body.len() < LEFTOVER_TAIL_BYTES as usize);
        let path = transcript("many", &body);
        let started = Instant::now();
        assert_eq!(leftover_work(&path, &unlogged), 4_000);
        let took = started.elapsed();
        remove(&path);
        // Linear: about 0.1 s in a debug build here; the list scans it
        // replaced took over 1 s.
        assert!(took < Duration::from_millis(750), "{took:?}");
    }
}
