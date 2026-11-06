//! One newline-delimited JSON request over the wmux pipe, with the Node
//! bridge's timeout, retry and target-walk rules (sendRpc, sendRpcWithRetry,
//! shouldTryNextTarget and sendToTargets in wmux-hooks-bridge.mjs).
//!
//! Every outcome is a `Json` object shaped like the Node bridge's result: the
//! server's own response, or `{ok:false, error, detail?, retryable}`. The walk
//! reads `ok`, `error`, `detail` and `retryable` off that object exactly as the
//! Node code does, including off a server response.

use crate::js::{self, Json};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const HOOK_TIMEOUT: Duration = Duration::from_millis(2000);
const CONNECT_RETRY_BACKOFFS_MS: [u64; 2] = [100, 250];
const TRANSIENT_CONNECT_CODES: [&str; 7] = [
    "EPERM",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "EBUSY",
    "EAGAIN",
];

/// Re-delivery cannot corrupt these (the router dedups); a lost one stalls a pane.
const IDEMPOTENT_KINDS: [&str; 2] = ["agent.stop", "agent.session_start"];

pub struct Target {
    pub name: &'static str,
    pub pipe: String,
    pub token: String,
    pub method: &'static str,
}

fn failure(error: &str, detail: Option<String>, retryable: Option<bool>) -> Json {
    let mut o = vec![
        (js::js("ok"), Json::Bool(false)),
        (js::js("error"), Json::Str(js::js(error))),
    ];
    if let Some(d) = detail {
        o.push((js::js("detail"), Json::Str(js::js(&d))));
    }
    if let Some(r) = retryable {
        o.push((js::js("retryable"), Json::Bool(r)));
    }
    Json::Obj(o)
}

fn is_true(v: Option<&Json>) -> bool {
    v == Some(&Json::Bool(true))
}

fn str_is(v: Option<&Json>, s: &str) -> bool {
    v.and_then(Json::as_str).is_some_and(|x| *x == js::js(s))
}

/// The write-or-abandon handshake: the connecting thread writes only while the
/// caller is still waiting, so a request is never sent after its timeout
/// (Node destroys the socket on timeout, cancelling a pending connect).
#[derive(Default)]
struct Gate {
    abandoned: bool,
    wrote: bool,
}

/// sendRpc: one attempt, bounded by `deadline`.
fn send_rpc(pipe: &str, line: &str, id: &[u16], deadline: Instant) -> Json {
    let gate = Arc::new(Mutex::new(Gate::default()));
    let (tx, rx) = mpsc::channel::<Json>();
    {
        let (gate, pipe, line, id) = (gate.clone(), pipe.to_owned(), line.to_owned(), id.to_vec());
        std::thread::spawn(move || {
            let _ = tx.send(exchange(&pipe, &line, &id, &gate));
        });
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    match rx.recv_timeout(remaining) {
        Ok(result) => result,
        Err(_) => {
            let mut g = gate.lock().unwrap_or_else(|e| e.into_inner());
            g.abandoned = true;
            failure("timeout", None, Some(!g.wrote))
        }
    }
}

fn exchange(pipe: &str, line: &str, id: &[u16], gate: &Mutex<Gate>) -> Json {
    let mut stream = match transport::connect(pipe) {
        Ok(s) => s,
        Err(e) => return failure("connect-error", Some(transport::code(&e)), Some(true)),
    };
    {
        let mut g = gate.lock().unwrap_or_else(|e| e.into_inner());
        if g.abandoned {
            return failure("timeout", None, Some(true));
        }
        // Node marks `wrote` once write() is called, whatever it returns.
        g.wrote = true;
        if let Err(e) = stream.write_all(line.as_bytes()).and_then(|_| stream.flush()) {
            return failure("connect-error", Some(transport::code(&e)), Some(false));
        }
    }
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return failure("closed-without-response", None, Some(false)),
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return failure("connect-error", Some(transport::code(&e)), Some(false)),
        }
        // Match OUR response by id: the daemon pipe broadcasts id-less events.
        while let Some(nl) = buffer.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = buffer.drain(..=nl).collect();
            let text = js::js(&String::from_utf8_lossy(&raw[..raw.len() - 1]));
            let Ok(parsed) = js::parse(&text) else { continue };
            if parsed.get("id").and_then(Json::as_str).is_some_and(|x| x == id) {
                return parsed;
            }
        }
    }
}

/// sendRpcWithRetry: retry a transient connect failure inside the deadline.
fn send_rpc_with_retry(pipe: &str, line: &str, id: &[u16], deadline: Instant) -> Json {
    let mut attempt = 0;
    let mut last = failure("timeout", None, None);
    loop {
        if Instant::now() >= deadline {
            return last;
        }
        last = send_rpc(pipe, line, id, deadline);
        if !str_is(last.get("error"), "connect-error") {
            return last;
        }
        let transient = last
            .get("detail")
            .and_then(Json::as_str)
            .is_some_and(|d| TRANSIENT_CONNECT_CODES.iter().any(|c| *d == js::js(c)));
        if last.get("retryable") == Some(&Json::Bool(false)) || !transient || attempt >= CONNECT_RETRY_BACKOFFS_MS.len()
        {
            return last;
        }
        let backoff = Duration::from_millis(CONNECT_RETRY_BACKOFFS_MS[attempt]);
        attempt += 1;
        if Instant::now() + backoff >= deadline {
            return last;
        }
        std::thread::sleep(backoff);
    }
}

/// shouldTryNextTarget: advance when the request provably never reached a
/// server, or when re-sending it is harmless.
pub fn should_try_next_target(result: &Json, kind: &str) -> bool {
    if is_true(result.get("ok")) {
        return false;
    }
    if result.get("retryable") == Some(&Json::Bool(false)) {
        return IDEMPOTENT_KINDS.contains(&kind);
    }
    true
}

/// sendToTargets: one shared HOOK_TIMEOUT budget, sliced per remaining target
/// so a pipe that accepts and then hangs cannot starve the fallback.
pub fn send_to_targets<'t>(
    targets: &'t [Target],
    build_line: impl Fn(&Target) -> String,
    id: &[u16],
    kind: &str,
) -> (Json, Option<&'t Target>) {
    let start = Instant::now();
    let deadline = start + HOOK_TIMEOUT;
    let mut result = failure("no-target", None, None);
    let mut used = None;
    for (i, target) in targets.iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        used = Some(target);
        let slice_ms = ((remaining.as_millis() as u64) / (targets.len() - i) as u64).max(1);
        let slice_deadline = Instant::now() + Duration::from_millis(slice_ms);
        result = send_rpc_with_retry(&target.pipe, &build_line(target), id, slice_deadline);
        if !should_try_next_target(&result, kind) {
            break;
        }
    }
    (result, used)
}

#[cfg(unix)]
mod transport {
    use std::os::unix::net::UnixStream;

    #[cfg(not(target_os = "macos"))]
    pub fn connect(pipe: &str) -> std::io::Result<UnixStream> {
        UnixStream::connect(pipe)
    }

    /// macOS takes a sockaddr_un longer than its 104-byte `sun_path` when
    /// `sun_len` says so, and libuv (so Node, and the daemon that bound the
    /// socket) relies on that. std refuses such a path, so build the address
    /// by hand for the long case.
    #[cfg(target_os = "macos")]
    pub fn connect(pipe: &str) -> std::io::Result<UnixStream> {
        use std::io::Error;
        use std::os::fd::FromRawFd;
        extern "C" {
            fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
            fn connect(fd: i32, addr: *const u8, len: u32) -> i32;
            fn close(fd: i32) -> i32;
        }
        const AF_UNIX: u8 = 1;
        const SOCK_STREAM: i32 = 1;
        const ENAMETOOLONG: i32 = 63;
        let path = pipe.as_bytes();
        if path.len() < 104 {
            return UnixStream::connect(pipe);
        }
        // sun_len, sun_family, path, NUL — sun_len is one byte.
        let len = 2 + path.len() + 1;
        if len > 255 || path.contains(&0) {
            return Err(Error::from_raw_os_error(ENAMETOOLONG));
        }
        let mut addr = vec![0u8; len];
        addr[0] = len as u8;
        addr[1] = AF_UNIX;
        addr[2..2 + path.len()].copy_from_slice(path);
        // SAFETY: plain socket calls; `addr` outlives connect, and the fd is
        // closed on failure or owned by the returned stream.
        unsafe {
            let fd = socket(AF_UNIX as i32, SOCK_STREAM, 0);
            if fd < 0 {
                return Err(Error::last_os_error());
            }
            if connect(fd, addr.as_ptr(), len as u32) != 0 {
                let e = Error::last_os_error();
                close(fd);
                return Err(e);
            }
            Ok(UnixStream::from_raw_fd(fd))
        }
    }

    /// libuv's error name for an errno (what Node puts in `err.code`).
    pub fn code(e: &std::io::Error) -> String {
        let Some(n) = e.raw_os_error() else {
            return e.to_string();
        };
        let name = match n {
            1 => "EPERM",
            2 => "ENOENT",
            13 => "EACCES",
            16 => "EBUSY",
            20 => "ENOTDIR",
            22 => "EINVAL",
            32 => "EPIPE",
            #[cfg(target_os = "linux")]
            11 => "EAGAIN",
            #[cfg(target_os = "linux")]
            36 => "ENAMETOOLONG",
            #[cfg(target_os = "linux")]
            88 => "ENOTSOCK",
            #[cfg(target_os = "linux")]
            91 => "EPROTOTYPE",
            #[cfg(target_os = "linux")]
            104 => "ECONNRESET",
            #[cfg(target_os = "linux")]
            110 => "ETIMEDOUT",
            #[cfg(target_os = "linux")]
            111 => "ECONNREFUSED",
            #[cfg(target_os = "macos")]
            35 => "EAGAIN",
            #[cfg(target_os = "macos")]
            38 => "ENOTSOCK",
            #[cfg(target_os = "macos")]
            41 => "EPROTOTYPE",
            #[cfg(target_os = "macos")]
            54 => "ECONNRESET",
            #[cfg(target_os = "macos")]
            60 => "ETIMEDOUT",
            #[cfg(target_os = "macos")]
            61 => "ECONNREFUSED",
            #[cfg(target_os = "macos")]
            63 => "ENAMETOOLONG",
            _ => return e.to_string(),
        };
        name.into()
    }
}

#[cfg(windows)]
mod transport {
    use std::fs::{File, OpenOptions};
    use std::time::Duration;

    const ERROR_PIPE_BUSY: i32 = 231;

    /// Open the client end of a named pipe. libuv waits out ERROR_PIPE_BUSY
    /// (all instances taken) rather than failing, so this does too; the
    /// caller's deadline bounds the wait.
    pub fn connect(pipe: &str) -> std::io::Result<File> {
        loop {
            match OpenOptions::new().read(true).write(true).open(pipe) {
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => std::thread::sleep(Duration::from_millis(10)),
                other => return other,
            }
        }
    }

    /// libuv's translation of a Win32 error (what Node puts in `err.code`).
    pub fn code(e: &std::io::Error) -> String {
        let Some(n) = e.raw_os_error() else {
            return e.to_string();
        };
        let name = match n {
            2 | 3 => "ENOENT",
            5 => "EPERM",
            121 => "ETIMEDOUT",
            232 | 233 => "EPIPE",
            1225 => "ECONNREFUSED",
            10054 => "ECONNRESET",
            _ => return e.to_string(),
        };
        name.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(s: &str) -> Json {
        js::parse(&js::js(s)).unwrap()
    }

    #[test]
    fn next_target_rules_match_the_node_bridge() {
        assert!(!should_try_next_target(&obj(r#"{"ok":true}"#), "agent.stop"));
        assert!(should_try_next_target(
            &obj(r#"{"ok":false,"retryable":true}"#),
            "agent.user_prompt_submit"
        ));
        // Delivered maybe: only an idempotent kind is re-sent.
        assert!(should_try_next_target(
            &obj(r#"{"ok":false,"retryable":false}"#),
            "agent.stop"
        ));
        assert!(should_try_next_target(
            &obj(r#"{"ok":false,"retryable":false}"#),
            "agent.session_start"
        ));
        assert!(!should_try_next_target(
            &obj(r#"{"ok":false,"retryable":false}"#),
            "agent.awaiting_input"
        ));
        // A server's own rejection carries no `retryable`: Node moves on.
        assert!(should_try_next_target(
            &obj(r#"{"id":"x","ok":false,"error":"denied"}"#),
            "agent.awaiting_input"
        ));
    }
}
