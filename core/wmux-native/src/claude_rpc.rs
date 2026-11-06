//! The Claude hook bridge's transport (sendRpc in wmux-bridge.mjs) over a
//! unix socket: one request line out, the reply with the same id back, as
//! an outcome object with Node's fields (`ok`, `error`, `detail`,
//! `retryable`) or the server's own reply. Unix only: on Windows the Claude
//! hooks stay on the Node bridge.
//!
//! One poll loop reads and writes, so a reply that arrives while request
//! bytes are still unwritten settles the request. The servers destroy the
//! socket after an error reply or a line over 1 MiB, and a macOS unix socket
//! buffers only a few KB, so a write-then-read client would report the write
//! failure instead of the reply it was already sent.
//!
//! Outcome mapping, as Node's socket events produce it:
//!   - connect fails                → connect-error, detail = errno name, retryable: true
//!   - `wrote` is true once connected (Node writes in its `connect` handler)
//!   - EOF after connect            → closed-without-response, retryable: false
//!   - a socket error after connect → connect-error, detail = errno name, retryable: false
//!   - the deadline                 → timeout, retryable: !wrote
//!   - a line whose `id` matches    → that line, parsed (broadcasts, other ids
//!     and unparsable lines are skipped; a partial last line is never parsed)
//!
//! Two decisions where Node itself is not deterministic, recorded by the
//! #3134 characterisation cases:
//!   (a) reply-then-close (walk-reply-early-close): Node reports `ok`, EPIPE
//!       or ENOTCONN depending on which socket event it handles first. This
//!       transport drains what it can read before it acts on a write error,
//!       so it settles `ok` on the matching-id line (that case's
//!       strictForPort).
//!   (b) accept-then-reset (walk-reset-after-accept-no-retry): Node counts the
//!       request as written once connected, so the reset is retryable:false:
//!       exactly one connect, no retry, no fallback. This transport does the same.

use crate::js::{self, Json};
use crate::rpc::{failure, transport, LineBuffer, Target, WalkPolicy};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::time::Instant;

/// sendToTargets with this transport.
pub fn send_to_targets<'t>(
    targets: &'t [Target],
    build_line: impl Fn(&Target) -> String,
    id: &[u16],
    kind: &str,
    policy: &WalkPolicy,
) -> (Json, Option<&'t Target>) {
    crate::rpc::walk(targets, build_line, id, kind, policy, send_rpc)
}

/// sendRpc: one attempt on `pipe`, bounded by `deadline`.
pub fn send_rpc(pipe: &str, line: &str, id: &[u16], deadline: Instant) -> Json {
    let stream = match open(pipe, deadline) {
        Connect::Connected(s) => s,
        Connect::Failed(e) => return failure("connect-error", Some(transport::code(&e)), Some(true)),
        Connect::TimedOut => return failure("timeout", None, Some(true)),
    };
    exchange(stream, line.as_bytes(), id, deadline)
}

// ----- the exchange ---------------------------------------------------------

/// Read and write until the reply, EOF, an error or the deadline. Reading
/// comes first in every round, and a write error waits for what is already
/// readable, so a reply the server sent before closing always wins.
fn exchange(mut stream: UnixStream, out: &[u8], id: &[u16], deadline: Instant) -> Json {
    let mut written = 0;
    let mut write_error: Option<std::io::Error> = None;
    let mut lines = LineBuffer::default();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let want_write = written < out.len() && write_error.is_none();
        let Some(timeout_ms) = remaining_ms(deadline) else {
            return failure("timeout", None, Some(false));
        };
        let revents = match poll_one(stream.as_raw_fd(), want_write, timeout_ms) {
            Ok(r) => r,
            Err(e) => return failure("connect-error", Some(transport::code(&e)), Some(false)),
        };
        if revents == 0 {
            continue; // the deadline is checked at the top
        }
        // Drain everything readable before acting on anything else.
        if revents & (POLLIN | POLLHUP | POLLERR) != 0 {
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => {
                        return match write_error {
                            Some(e) => failure("connect-error", Some(transport::code(&e)), Some(false)),
                            None => failure("closed-without-response", None, Some(false)),
                        };
                    }
                    Ok(n) => {
                        for line in lines.push(&chunk[..n]) {
                            if let Some(reply) = matching_reply(&line, id) {
                                return reply;
                            }
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) => return failure("connect-error", Some(transport::code(&e)), Some(false)),
                }
            }
        }
        if want_write && revents & POLLOUT != 0 {
            loop {
                match stream.write(&out[written..]) {
                    Ok(n) => {
                        written += n;
                        if written == out.len() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    // Keep reading: the reply may already be on its way.
                    Err(e) => {
                        write_error = Some(e);
                        break;
                    }
                }
            }
        }
    }
}

/// The line, parsed, when it is an object whose `id` is ours.
fn matching_reply(line: &[u8], id: &[u16]) -> Option<Json> {
    let parsed = js::parse(&js::js(&String::from_utf8_lossy(line))).ok()?;
    parsed
        .get("id")
        .and_then(Json::as_str)
        .is_some_and(|x| x == id)
        .then_some(parsed)
}

/// Milliseconds left, rounded up so a poll never wakes just short of the
/// deadline; None once it has passed.
fn remaining_ms(deadline: Instant) -> Option<i32> {
    let left = deadline.checked_duration_since(Instant::now())?;
    if left.is_zero() {
        return None;
    }
    Some(left.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32)
}

// ----- the socket -------------------------------------------------------------

const POLLIN: i16 = 0x1;
const POLLOUT: i16 = 0x4;
const POLLERR: i16 = 0x8;
const POLLHUP: i16 = 0x10;

#[repr(C)]
struct PollFd {
    fd: i32,
    events: i16,
    revents: i16,
}

#[cfg(target_os = "macos")]
type NFds = std::os::raw::c_uint;
#[cfg(not(target_os = "macos"))]
type NFds = std::os::raw::c_ulong;

extern "C" {
    fn poll(fds: *mut PollFd, nfds: NFds, timeout: i32) -> i32;
    fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
    fn connect(fd: i32, addr: *const u8, len: u32) -> i32;
    fn getsockopt(fd: i32, level: i32, name: i32, value: *mut i32, len: *mut u32) -> i32;
}

#[cfg(target_os = "macos")]
mod sys {
    pub const EINPROGRESS: i32 = 36;
    pub const ENAMETOOLONG: i32 = 63;
    pub const SOL_SOCKET: i32 = 0xffff;
    pub const SO_ERROR: i32 = 0x1007;
    /// sun_len, sun_family, the path and its NUL. A path past the 104-byte
    /// `sun_path` is allowed when sun_len says so, as libuv relies on.
    pub fn sockaddr(path: &[u8]) -> Option<Vec<u8>> {
        let len = 2 + path.len() + 1;
        if len > 255 {
            return None;
        }
        let mut addr = vec![0u8; len];
        addr[0] = len as u8;
        addr[1] = 1; // AF_UNIX
        addr[2..2 + path.len()].copy_from_slice(path);
        Some(addr)
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub const EINPROGRESS: i32 = 115;
    pub const ENAMETOOLONG: i32 = 36;
    pub const SOL_SOCKET: i32 = 1;
    pub const SO_ERROR: i32 = 4;
    /// sun_family, then the path and its NUL within the 108-byte `sun_path`.
    pub fn sockaddr(path: &[u8]) -> Option<Vec<u8>> {
        if path.len() >= 108 {
            return None;
        }
        let mut addr = vec![0u8; 2 + path.len() + 1];
        addr[..2].copy_from_slice(&1u16.to_ne_bytes()); // AF_UNIX
        addr[2..2 + path.len()].copy_from_slice(path);
        Some(addr)
    }
}

enum Connect {
    Connected(UnixStream),
    Failed(std::io::Error),
    TimedOut,
}

/// A non-blocking connect, as libuv makes it: a full backlog is an
/// immediate error (EAGAIN on Linux), never a wait, and a pending connect is
/// bounded by the deadline.
fn open(pipe: &str, deadline: Instant) -> Connect {
    use std::io::Error;
    let path = pipe.as_bytes();
    let Some(addr) = (!path.contains(&0)).then(|| sys::sockaddr(path)).flatten() else {
        return Connect::Failed(Error::from_raw_os_error(sys::ENAMETOOLONG));
    };
    // SAFETY: socket() returns a fresh fd that the UnixStream then owns and
    // closes; `addr` outlives the connect call.
    let stream = unsafe {
        let fd = socket(1, 1, 0); // AF_UNIX, SOCK_STREAM
        if fd < 0 {
            return Connect::Failed(Error::last_os_error());
        }
        UnixStream::from_raw_fd(fd)
    };
    if let Err(e) = stream.set_nonblocking(true) {
        return Connect::Failed(e);
    }
    // SAFETY: the fd is open and `addr` is a valid sockaddr_un of that length.
    if unsafe { connect(stream.as_raw_fd(), addr.as_ptr(), addr.len() as u32) } == 0 {
        return Connect::Connected(stream);
    }
    let e = Error::last_os_error();
    if e.raw_os_error() != Some(sys::EINPROGRESS) {
        return Connect::Failed(e);
    }
    loop {
        let Some(timeout_ms) = remaining_ms(deadline) else {
            return Connect::TimedOut;
        };
        match poll_one(stream.as_raw_fd(), true, timeout_ms) {
            Ok(0) => continue,
            Ok(_) => break,
            Err(e) => return Connect::Failed(e),
        }
    }
    let mut err = 0i32;
    let mut len = std::mem::size_of::<i32>() as u32;
    // SAFETY: SO_ERROR writes one int into `err`.
    if unsafe { getsockopt(stream.as_raw_fd(), sys::SOL_SOCKET, sys::SO_ERROR, &mut err, &mut len) } != 0 {
        return Connect::Failed(Error::last_os_error());
    }
    if err != 0 {
        return Connect::Failed(Error::from_raw_os_error(err));
    }
    Connect::Connected(stream)
}

/// poll(2) on one fd: always for reading, and for writing when asked.
/// Returns the revents (0 on timeout); EINTR is a timeout-free retry.
fn poll_one(fd: i32, want_write: bool, timeout_ms: i32) -> std::io::Result<i16> {
    let mut p = PollFd {
        fd,
        events: POLLIN | if want_write { POLLOUT } else { 0 },
        revents: 0,
    };
    // SAFETY: one valid pollfd for the duration of the call.
    let n = unsafe { poll(&mut p, 1, timeout_ms) };
    if n < 0 {
        let e = std::io::Error::last_os_error();
        return if e.kind() == ErrorKind::Interrupted {
            Ok(0)
        } else {
            Err(e)
        };
    }
    Ok(if n == 0 { 0 } else { p.revents })
}

#[cfg(test)]
mod tests {
    //! The transport against stubs of #3134's stub daemon modes; each test
    //! names the characterisation cases it stands for.
    use super::*;
    use crate::claude::CLAUDE_POLICY;
    use crate::rpc::{send_rpc_with_retry, WalkPolicy};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const ID: &str = "bridge-1";

    #[derive(Clone)]
    enum Mode {
        /// Read the whole line, then write these lines.
        Reply(Vec<String>),
        /// Answer once the id has arrived; then close, or stop reading.
        ReplyEarly {
            close: bool,
        },
        CloseAfterRead,
        Hold,
        Reset,
        OverLong,
    }

    struct Stub {
        path: String,
        dir: String,
        accepted: Arc<AtomicUsize>,
        requests: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn dir(tag: &str) -> String {
        let dir = format!("/tmp/wcr-{tag}-{}", std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ok_reply() -> String {
        format!(r#"{{"id":"{ID}","ok":true,"result":{{"ok":true}}}}"#)
    }

    fn stub(tag: &str, mode: Mode) -> Stub {
        let dir = dir(tag);
        let path = format!("{dir}/s.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (count, seen) = (Arc::clone(&accepted), Arc::clone(&requests));
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                let (mode, seen) = (mode.clone(), Arc::clone(&seen));
                std::thread::spawn(move || serve(conn, mode, seen));
            }
        });
        Stub {
            path,
            dir,
            accepted,
            requests,
        }
    }

    fn serve(mut conn: UnixStream, mode: Mode, seen: Arc<Mutex<Vec<Vec<u8>>>>) {
        if matches!(mode, Mode::Reset) {
            return; // dropped unread
        }
        let mut got = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let n = match conn.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            got.extend_from_slice(&chunk[..n]);
            match &mode {
                Mode::ReplyEarly { close } if got.starts_with(format!("{{\"id\":\"{ID}\"").as_bytes()) => {
                    let _ = conn.write_all(format!("{}\n", ok_reply()).as_bytes());
                    if !close {
                        std::thread::sleep(Duration::from_secs(30));
                    }
                    return;
                }
                Mode::OverLong if got.len() > 1024 * 1024 && !got.contains(&b'\n') => return,
                _ => {}
            }
            if let Some(nl) = got.iter().position(|&b| b == b'\n') {
                seen.lock().unwrap().push(got[..=nl].to_vec());
                match &mode {
                    Mode::Reply(lines) => {
                        for line in lines {
                            let _ = conn.write_all(line.as_bytes());
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        std::thread::sleep(Duration::from_secs(30));
                    }
                    Mode::Hold => std::thread::sleep(Duration::from_secs(30)),
                    _ => {}
                }
                return; // CloseAfterRead and the rest close here
            }
        }
    }

    fn request(blob: usize) -> String {
        format!(
            "{{\"id\":\"{ID}\",\"method\":\"m\",\"params\":{{\"blob\":\"{}\"}}}}\n",
            "a".repeat(blob)
        )
    }

    fn send(pipe: &str, line: &str, ms: u64) -> Json {
        send_rpc(pipe, line, &js::js(ID), Instant::now() + Duration::from_millis(ms))
    }

    fn with_retry(pipe: &str, line: &str, ms: u64) -> (Json, Duration) {
        let start = Instant::now();
        let result = send_rpc_with_retry(send_rpc, pipe, line, &js::js(ID), start + Duration::from_millis(ms));
        (result, start.elapsed())
    }

    fn text(v: &Json) -> String {
        let mut out = String::new();
        js::stringify(v, &mut out);
        out
    }

    #[test]
    fn the_reply_is_the_line_with_our_id() {
        // walk-skips-foreign-lines: broadcasts, junk and other ids are skipped.
        let s = stub(
            "reply",
            Mode::Reply(vec![
                "{\"type\":\"session\",\"sessionId\":\"x\",\"data\":{}}\n".into(),
                "not json\n".into(),
                format!("{{\"id\":\"other\",\"ok\":true}}\n{}", &ok_reply()[..10]),
                format!("{}\n", &ok_reply()[10..]),
            ]),
        );
        let line = request(10);
        assert_eq!(text(&send(&s.path, &line, 2000)), ok_reply());
        // The request reached the server byte for byte.
        assert_eq!(s.requests.lock().unwrap().as_slice(), [line.into_bytes()]);
    }

    #[test]
    fn a_last_line_without_a_newline_is_never_parsed() {
        let s = stub("partial", Mode::Reply(vec![ok_reply()]));
        // The stub keeps the socket open: no newline, no reply, until the deadline.
        let result = send(&s.path, &request(10), 300);
        assert_eq!(text(&result), r#"{"ok":false,"error":"timeout","retryable":false}"#);
    }

    #[test]
    fn a_reply_before_the_request_is_written_settles_it() {
        // walk-reply-early-large-request, gate-reply-early-block, perm-reply-early-deny
        let s = stub("early", Mode::ReplyEarly { close: false });
        assert_eq!(text(&send(&s.path, &request(900_000), 2000)), ok_reply());
    }

    #[test]
    fn a_reply_then_close_settles_ok_every_time() {
        // walk-reply-early-close (strictForPort): Node varies here, this does not.
        let s = stub("early-close", Mode::ReplyEarly { close: true });
        let line = request(900_000);
        for round in 0..30 {
            assert_eq!(text(&send(&s.path, &line, 2000)), ok_reply(), "round {round}");
        }
    }

    #[test]
    fn eof_after_the_write_is_closed_without_response() {
        // walk-close-after-write-stops, gate-lost-answer, context-lost-answer-open
        let s = stub("close", Mode::CloseAfterRead);
        assert_eq!(
            text(&send(&s.path, &request(10), 2000)),
            r#"{"ok":false,"error":"closed-without-response","retryable":false}"#
        );
    }

    #[test]
    fn no_answer_is_a_timeout_after_the_write() {
        // walk-hold-times-out, gate-timeout
        let s = stub("hold", Mode::Hold);
        let start = Instant::now();
        let result = send(&s.path, &request(10), 300);
        assert!(start.elapsed() >= Duration::from_millis(300));
        assert_eq!(text(&result), r#"{"ok":false,"error":"timeout","retryable":false}"#);
    }

    fn lost_after_write(v: &Json) -> bool {
        let t = text(v);
        t == r#"{"ok":false,"error":"closed-without-response","retryable":false}"#
            || ["EPIPE", "ECONNRESET", "ENOTCONN"]
                .iter()
                .any(|c| t == format!(r#"{{"ok":false,"error":"connect-error","detail":"{c}","retryable":false}}"#))
    }

    #[test]
    fn accept_then_reset_is_one_attempt() {
        // walk-reset-after-accept-no-retry: written on connect, so no retry.
        let s = stub("reset", Mode::Reset);
        let (result, _) = with_retry(&s.path, &request(10), 2000);
        assert!(lost_after_write(&result), "{}", text(&result));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_over_long_line_is_dropped_after_the_write() {
        // walk-over-long-request
        let s = stub("long", Mode::OverLong);
        let (result, _) = with_retry(&s.path, &request(1_200_000), 2000);
        assert!(lost_after_write(&result), "{}", text(&result));
        assert_eq!(s.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_missing_pipe_fails_at_once_and_is_not_retried() {
        // walk-daemon-absent-advances, gate-no-main, perm-unreachable-is-silent
        let d = dir("absent");
        let (result, took) = with_retry(&format!("{d}/none.sock"), &request(10), 2000);
        assert_eq!(
            text(&result),
            r#"{"ok":false,"error":"connect-error","detail":"ENOENT","retryable":true}"#
        );
        assert!(took < Duration::from_millis(100), "{took:?}");
        let _ = std::fs::remove_dir_all(d);
    }

    /// A socket file nobody listens on: bound, then the listener dropped.
    fn refused(tag: &str) -> (String, String) {
        let d = dir(tag);
        let path = format!("{d}/r.sock");
        drop(UnixListener::bind(&path).unwrap());
        (d, path)
    }

    #[test]
    fn a_refused_connect_is_retried_after_100_and_250_ms() {
        // walk-refused-retries-then-advances
        let (d, path) = refused("refused");
        assert_eq!(
            text(&send(&path, &request(10), 2000)),
            r#"{"ok":false,"error":"connect-error","detail":"ECONNREFUSED","retryable":true}"#
        );
        let (result, took) = with_retry(&path, &request(10), 2000);
        assert_eq!(
            text(&result),
            r#"{"ok":false,"error":"connect-error","detail":"ECONNREFUSED","retryable":true}"#
        );
        assert!(
            took >= Duration::from_millis(350) && took < Duration::from_millis(1000),
            "{took:?}"
        );
        // A backoff that would cross the deadline is not slept: one retry only.
        let (_, took) = with_retry(&path, &request(10), 200);
        assert!(
            took >= Duration::from_millis(100) && took < Duration::from_millis(200),
            "{took:?}"
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_spent_deadline_sends_nothing() {
        let s = stub("spent", Mode::Hold);
        let result = send_rpc_with_retry(send_rpc, &s.path, &request(10), &js::js(ID), Instant::now());
        assert_eq!(text(&result), r#"{"ok":false,"error":"timeout"}"#);
        assert_eq!(s.accepted.load(Ordering::SeqCst), 0);
    }

    fn target(name: &'static str, pipe: &str) -> Target {
        Target {
            name,
            pipe: pipe.into(),
            token: "t".into(),
            method: "m",
        }
    }

    /// Walk daemon then main under the Claude policy with a short budget.
    fn walk(tag: &str, daemon: Mode) -> (String, Option<&'static str>, usize) {
        let d = stub(&format!("{tag}-d"), daemon);
        let m = stub(&format!("{tag}-m"), Mode::Reply(vec![format!("{}\n", ok_reply())]));
        let targets = [target("daemon", &d.path), target("main", &m.path)];
        let policy = WalkPolicy {
            budget: Duration::from_millis(500),
            ..CLAUDE_POLICY
        };
        let line = request(10);
        let (result, used) = send_to_targets(&targets, |_| line.clone(), &js::js(ID), "agent.stop", &policy);
        std::thread::sleep(Duration::from_millis(20));
        (text(&result), used.map(|t| t.name), m.accepted.load(Ordering::SeqCst))
    }

    #[test]
    fn the_walk_moves_on_only_when_nothing_was_delivered() {
        // walk-unauthorized-advances: the server's own refusal moves on.
        let refusal = format!("{{\"id\":\"{ID}\",\"ok\":false,\"error\":\"unauthorized\"}}\n");
        assert_eq!(
            walk("unauth", Mode::Reply(vec![refusal])),
            (ok_reply(), Some("main"), 1)
        );
        // walk-reply-retryable-false-stops: a reply carrying retryable:false stops it.
        let busy = format!("{{\"id\":\"{ID}\",\"ok\":false,\"error\":\"busy\",\"retryable\":false}}\n");
        assert_eq!(
            walk("busy", Mode::Reply(vec![busy.clone()])),
            (busy.trim_end().to_string(), Some("daemon"), 0)
        );
        // walk-close-after-write-stops: even agent.stop is not sent on.
        let (result, used, main) = walk("closed", Mode::CloseAfterRead);
        assert_eq!((used, main), (Some("daemon"), 0), "{result}");
        // walk-hold-times-out: the one deadline is not sliced, so main is never tried.
        let (result, used, main) = walk("hold", Mode::Hold);
        assert_eq!(
            (result.as_str(), used, main),
            (r#"{"ok":false,"error":"timeout","retryable":false}"#, Some("daemon"), 0)
        );
    }
}
