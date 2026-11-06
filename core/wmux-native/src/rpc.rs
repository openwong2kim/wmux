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

/// How a walk over the targets spends its budget, and what it does with a
/// request that was written but never answered. Each bridge has its own.
pub struct WalkPolicy {
    /// One deadline for the whole walk.
    pub budget: Duration,
    /// Split what is left evenly over the targets still to try, so a pipe that
    /// accepts and then hangs cannot starve the fallback.
    pub slice_per_target: bool,
    /// Kinds sent on to the next target after a write that got no answer.
    pub resend_after_write: &'static [&'static str],
}

/// wmux-hooks-bridge.mjs.
pub const SHARED_POLICY: WalkPolicy = WalkPolicy {
    budget: HOOK_TIMEOUT,
    slice_per_target: true,
    resend_after_write: &IDEMPOTENT_KINDS,
};

pub struct Target {
    pub name: &'static str,
    pub pipe: String,
    pub token: String,
    pub method: &'static str,
}

pub fn failure(error: &str, detail: Option<String>, retryable: Option<bool>) -> Json {
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

pub fn is_true(v: Option<&Json>) -> bool {
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
        // Claim the write under the lock, then write without it: a peer that
        // stops reading must not hold the caller's timeout path on the lock.
        let mut g = gate.lock().unwrap_or_else(|e| e.into_inner());
        if g.abandoned {
            return failure("timeout", None, Some(true));
        }
        // Node marks `wrote` once write() is called, whatever it returns.
        g.wrote = true;
    }
    if let Err(e) = stream.write_all(line.as_bytes()).and_then(|_| stream.flush()) {
        return failure("connect-error", Some(transport::code(&e)), Some(false));
    }
    let mut lines = LineBuffer::default();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let n = match stream.read(&mut chunk) {
            Ok(0) => return failure("closed-without-response", None, Some(false)),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return failure("connect-error", Some(transport::code(&e)), Some(false)),
        };
        // Match OUR response by id: the daemon pipe broadcasts id-less events.
        for line in lines.push(&chunk[..n]) {
            let Ok(parsed) = js::parse(&js::js(&String::from_utf8_lossy(&line))) else {
                continue;
            };
            if parsed.get("id").and_then(Json::as_str).is_some_and(|x| x == id) {
                return parsed;
            }
        }
    }
}

/// Newline-delimited frames from a byte stream. Each byte is scanned once:
/// `scanned` remembers how far the unfinished tail has been searched.
#[derive(Default)]
pub struct LineBuffer {
    buffer: Vec<u8>,
    scanned: usize,
}

impl LineBuffer {
    /// Append a chunk and return the lines it completed, without their `\n`.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(at) = self.buffer[self.scanned..].iter().position(|&b| b == b'\n') {
            let end = self.scanned + at;
            lines.push(self.buffer[start..end].to_vec());
            start = end + 1;
            self.scanned = start;
        }
        if start > 0 {
            self.buffer.drain(..start);
        }
        self.scanned = self.buffer.len();
        lines
    }
}

/// One request on one pipe: `(pipe, line, id, deadline) -> outcome`.
pub type Send = fn(&str, &str, &[u16], Instant) -> Json;

/// sendRpcWithRetry: retry a transient connect failure inside the deadline.
pub fn send_rpc_with_retry(send: Send, pipe: &str, line: &str, id: &[u16], deadline: Instant) -> Json {
    let mut attempt = 0;
    let mut last = failure("timeout", None, None);
    loop {
        if Instant::now() >= deadline {
            return last;
        }
        last = send(pipe, line, id, deadline);
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
/// server, or when the policy re-sends this kind after a lost answer.
pub fn should_try_next_target(result: &Json, kind: &str, policy: &WalkPolicy) -> bool {
    if is_true(result.get("ok")) {
        return false;
    }
    if result.get("retryable") == Some(&Json::Bool(false)) {
        return policy.resend_after_write.contains(&kind);
    }
    true
}

/// sendToTargets over this module's transport.
pub fn send_to_targets<'t>(
    targets: &'t [Target],
    build_line: impl Fn(&Target) -> String,
    id: &[u16],
    kind: &str,
    policy: &WalkPolicy,
) -> (Json, Option<&'t Target>) {
    walk(targets, build_line, id, kind, policy, send_rpc)
}

/// sendToTargets: one budget for the whole walk, spent as `policy` says, each
/// request sent by `send`.
pub fn walk<'t>(
    targets: &'t [Target],
    build_line: impl Fn(&Target) -> String,
    id: &[u16],
    kind: &str,
    policy: &WalkPolicy,
    send: Send,
) -> (Json, Option<&'t Target>) {
    let deadline = Instant::now() + policy.budget;
    let mut result = failure("no-target", None, None);
    let mut used = None;
    for (i, target) in targets.iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        used = Some(target);
        let target_deadline = if policy.slice_per_target {
            let slice_ms = ((remaining.as_millis() as u64) / (targets.len() - i) as u64).max(1);
            Instant::now() + Duration::from_millis(slice_ms)
        } else {
            deadline
        };
        result = send_rpc_with_retry(send, &target.pipe, &build_line(target), id, target_deadline);
        if !should_try_next_target(&result, kind, policy) {
            break;
        }
    }
    (result, used)
}

#[cfg(unix)]
pub mod transport {
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
            103 => "ECONNABORTED",
            #[cfg(target_os = "linux")]
            104 => "ECONNRESET",
            #[cfg(target_os = "linux")]
            107 => "ENOTCONN",
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
            53 => "ECONNABORTED",
            #[cfg(target_os = "macos")]
            54 => "ECONNRESET",
            #[cfg(target_os = "macos")]
            57 => "ENOTCONN",
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

/// libuv's uv_translate_sys_error for the Win32 errors a pipe connect, write
/// or read can return (what Node puts in `err.code`). ERROR_BROKEN_PIPE is
/// end of file, not an error, on this path.
#[cfg(any(windows, test))]
fn win32_code_name(code: i32) -> Option<&'static str> {
    Some(match code {
        1 => "EISDIR",              // ERROR_INVALID_FUNCTION
        2 | 3 => "ENOENT",          // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND
        4 => "EMFILE",              // ERROR_TOO_MANY_OPEN_FILES
        5 => "EPERM",               // ERROR_ACCESS_DENIED
        6 => "EBADF",               // ERROR_INVALID_HANDLE
        8 | 14 => "ENOMEM",         // ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY
        32 => "EBUSY",              // ERROR_SHARING_VIOLATION
        64 => "ECONNRESET",         // ERROR_NETNAME_DELETED
        87 => "EINVAL",             // ERROR_INVALID_PARAMETER
        121 => "ETIMEDOUT",         // ERROR_SEM_TIMEOUT
        123 | 161 => "ENOENT",      // ERROR_INVALID_NAME, ERROR_BAD_PATHNAME
        206 => "ENAMETOOLONG",      // ERROR_FILENAME_EXCED_RANGE
        230 | 232 | 233 => "EPIPE", // ERROR_BAD_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED
        231 => "EBUSY",             // ERROR_PIPE_BUSY
        267 => "ENOENT",            // ERROR_DIRECTORY
        995 => "ECANCELED",         // ERROR_OPERATION_ABORTED
        1225 => "ECONNREFUSED",     // ERROR_CONNECTION_REFUSED
        1314 => "EPERM",            // ERROR_PRIVILEGE_NOT_HELD
        1920 => "EACCES",           // ERROR_CANT_ACCESS_FILE
        1921 => "ELOOP",            // ERROR_CANT_RESOLVE_FILENAME
        10054 => "ECONNRESET",      // WSAECONNRESET
        _ => return None,
    })
}

#[cfg(windows)]
mod transport {
    use std::fs::{File, OpenOptions};
    use std::os::windows::io::AsRawHandle;
    use std::time::Duration;

    const ERROR_PIPE_BUSY: i32 = 231;
    const ERROR_INVALID_FUNCTION: i32 = 1;
    const FILE_TYPE_PIPE: u32 = 3;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileType(handle: *mut core::ffi::c_void) -> u32;
    }

    /// Open the client end of a named pipe. libuv waits out ERROR_PIPE_BUSY
    /// (all instances taken) rather than failing, so this does too; the
    /// caller's deadline bounds the wait.
    ///
    /// Only a pipe is accepted: a pipe name that resolves to a plain file is
    /// refused before anything is written (libuv fails it the same way, when
    /// it sets the pipe mode), so the request and its token never land in a file.
    pub fn connect(pipe: &str) -> std::io::Result<File> {
        loop {
            match OpenOptions::new().read(true).write(true).open(pipe) {
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => std::thread::sleep(Duration::from_millis(10)),
                Ok(file) => {
                    // SAFETY: the handle is owned by `file` and valid for this call.
                    let kind = unsafe { GetFileType(file.as_raw_handle()) };
                    if kind != FILE_TYPE_PIPE {
                        return Err(std::io::Error::from_raw_os_error(ERROR_INVALID_FUNCTION));
                    }
                    return Ok(file);
                }
                other => return other,
            }
        }
    }

    /// libuv's translation of a Win32 error (what Node puts in `err.code`).
    pub fn code(e: &std::io::Error) -> String {
        match e.raw_os_error().and_then(super::win32_code_name) {
            Some(name) => name.into(),
            None => e.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_buffer_slices_lines_across_chunks() {
        let mut lines = LineBuffer::default();
        assert!(lines.push(b"{\"a\"").is_empty());
        assert!(lines.push(b":1}").is_empty());
        assert_eq!(
            lines.push(b"\nx\n{\"b\":2}\r\n{\"c"),
            vec![b"{\"a\":1}".to_vec(), b"x".to_vec(), b"{\"b\":2}\r".to_vec()]
        );
        assert_eq!(lines.push(b"\"}\n"), vec![b"{\"c\"}".to_vec()]);
    }

    #[test]
    fn line_buffer_scans_each_byte_once() {
        let mut lines = LineBuffer::default();
        let chunk = vec![b'x'; 16 * 1024];
        for _ in 0..64 {
            assert!(lines.push(&chunk).is_empty());
        }
        // Everything was scanned once, nothing twice.
        assert_eq!(lines.scanned, 64 * 16 * 1024);
        assert_eq!(lines.push(b"\n").len(), 1);
        assert_eq!(lines.scanned, 0);
    }

    #[test]
    fn win32_codes_match_libuv() {
        for (code, name) in [
            (2, "ENOENT"),
            (3, "ENOENT"),
            (5, "EPERM"),
            (64, "ECONNRESET"),
            (121, "ETIMEDOUT"),
            (123, "ENOENT"),
            (161, "ENOENT"),
            (206, "ENAMETOOLONG"),
            (231, "EBUSY"),
            (232, "EPIPE"),
            (233, "EPIPE"),
            (1, "EISDIR"),
            (1225, "ECONNREFUSED"),
            (995, "ECANCELED"),
        ] {
            assert_eq!(win32_code_name(code), Some(name), "{code}");
        }
        assert_eq!(win32_code_name(99999), None);
    }

    fn obj(s: &str) -> Json {
        js::parse(&js::js(s)).unwrap()
    }

    /// One target that reads the request and never answers, then one that
    /// answers ok. Returns the targets, how many connections the second saw,
    /// and the directory holding the sockets.
    #[cfg(unix)]
    fn hold_then_answer(tag: &str) -> (Vec<Target>, Arc<Mutex<usize>>, String) {
        use std::os::unix::net::UnixListener;
        let dir = format!("/tmp/wnw-{tag}-{}", std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (hold, answer) = (format!("{dir}/h.sock"), format!("{dir}/a.sock"));
        let hold_listener = UnixListener::bind(&hold).unwrap();
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            for mut conn in hold_listener.incoming().flatten() {
                let mut buf = [0u8; 1024];
                let _ = conn.read(&mut buf);
                kept.push(conn);
            }
        });
        let answered = Arc::new(Mutex::new(0));
        let seen = Arc::clone(&answered);
        let answer_listener = UnixListener::bind(&answer).unwrap();
        std::thread::spawn(move || {
            for mut conn in answer_listener.incoming().flatten() {
                *seen.lock().unwrap() += 1;
                let mut buf = [0u8; 1024];
                let _ = conn.read(&mut buf);
                let _ = conn.write_all(b"{\"id\":\"r1\",\"ok\":true}\n");
            }
        });
        let target = |name, pipe| Target {
            name,
            pipe,
            token: "t".into(),
            method: "m",
        };
        (vec![target("daemon", hold), target("main", answer)], answered, dir)
    }

    #[cfg(unix)]
    #[test]
    fn a_walk_slices_and_resends_only_as_its_policy_says() {
        let line = |_: &Target| "{\"id\":\"r1\"}\n".to_string();
        let walk = |tag: &str, slice_per_target, resend_after_write: &'static [&'static str]| {
            let (targets, answered, dir) = hold_then_answer(tag);
            let policy = WalkPolicy {
                budget: Duration::from_millis(600),
                slice_per_target,
                resend_after_write,
            };
            let (result, used) = send_to_targets(&targets, line, &js::js("r1"), "agent.stop", &policy);
            let answered = *answered.lock().unwrap();
            let _ = std::fs::remove_dir_all(dir);
            (is_true(result.get("ok")), used.map(|t| t.name), answered)
        };
        // Sliced and re-sending: the hung target gets half, the next answers.
        assert_eq!(walk("sr", true, &["agent.stop"]), (true, Some("main"), 1));
        // One unsliced deadline: the hung target spends it all.
        assert_eq!(walk("ur", false, &["agent.stop"]), (false, Some("daemon"), 0));
        // Sliced, but a written request is never sent on (the Claude rule).
        assert_eq!(walk("sn", true, &[]), (false, Some("daemon"), 0));
    }

    #[test]
    fn next_target_rules_match_the_node_bridge() {
        assert!(!should_try_next_target(
            &obj(r#"{"ok":true}"#),
            "agent.stop",
            &SHARED_POLICY
        ));
        assert!(should_try_next_target(
            &obj(r#"{"ok":false,"retryable":true}"#),
            "agent.user_prompt_submit",
            &SHARED_POLICY
        ));
        // Delivered maybe: only an idempotent kind is re-sent.
        assert!(should_try_next_target(
            &obj(r#"{"ok":false,"retryable":false}"#),
            "agent.stop",
            &SHARED_POLICY
        ));
        assert!(should_try_next_target(
            &obj(r#"{"ok":false,"retryable":false}"#),
            "agent.session_start",
            &SHARED_POLICY
        ));
        assert!(!should_try_next_target(
            &obj(r#"{"ok":false,"retryable":false}"#),
            "agent.awaiting_input",
            &SHARED_POLICY
        ));
        // A server's own rejection carries no `retryable`: Node moves on.
        assert!(should_try_next_target(
            &obj(r#"{"id":"x","ok":false,"error":"denied"}"#),
            "agent.awaiting_input",
            &SHARED_POLICY
        ));
    }
}
