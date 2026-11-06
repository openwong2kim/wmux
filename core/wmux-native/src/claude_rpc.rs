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
//! The shared hook bridge's transport (rpc.rs) still writes, then reads. The
//! two differ on purpose for now: changing the shared one is not part of the
//! Claude port.
//!
//! The outcome is a pure function of what the socket showed, in order
//! (`Session`): connected, data, EOF, a read error, a write error, the
//! deadline. As Node's socket events produce it:
//!   - connect fails                → connect-error, detail = errno name, retryable: true
//!   - `wrote` is true once connected (Node writes in its `connect` handler)
//!   - a line whose `id` matches    → that line, parsed (broadcasts, other ids
//!     and unparsable lines are skipped; a partial last line is never parsed)
//!   - EOF                          → closed-without-response, retryable: false;
//!     but EOF with request bytes still unwritten is connect-error/EPIPE,
//!     retryable: false: an incomplete line never reaches the server's
//!     processLine, so no waiter can exist and a Stop gate must not fail
//!     closed on it (both outcomes are among Node's, per #3134's variants)
//!   - a read error                 → connect-error, retryable: false
//!   - the deadline                 → timeout, retryable: !wrote
//!   - errors are reported by the first one's code, as Node settles on its
//!     first `error` event
//!
//! Write errors: the request may have reached the server, so a write error
//! ends the exchange at once, as Node's `error` event does: what is readable
//! right now is drained without waiting, a matching line in it settles `ok`,
//! and otherwise the outcome is connect-error with the write error's code,
//! retryable: false. It never waits for EOF: a peer that keeps the socket
//! open would otherwise turn the error into a timeout, which a Stop gate
//! reads as a lost answer and fails closed where Node fails open.
//! Only Linux shows this case: a write after the peer's shutdown(SHUT_RD)
//! fails with EPIPE while the peer keeps the socket open. macOS accepts such
//! writes, so the test for it is Linux-only.
//!
//! Two decisions where Node itself is not deterministic, recorded by the
//! #3134 characterisation cases:
//!   (a) reply-then-close (walk-reply-early-close): Node reports `ok`, EPIPE
//!       or ENOTCONN depending on which socket event it handles first. This
//!       transport reads before it writes in every round and drains before it
//!       acts on a write error, so it settles `ok` on the matching-id line
//!       (that case's strictForPort).
//!   (b) accept-then-reset (walk-reset-after-accept-no-retry): Node counts the
//!       request as written once connected, so the reset is retryable:false:
//!       exactly one connect, no retry, no fallback. This transport does the same.

use crate::js::Json;
use crate::rpc::{failure, matching_reply, LineBuffer, Target, WalkPolicy};
use crate::unix_sys::{self, PollFd, POLLERR, POLLHUP, POLLIN, POLLOUT};
use std::io::{Error, ErrorKind, Read, Write};
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
    let stream = match open(pipe) {
        Ok(s) => s,
        Err(e) => return failure("connect-error", Some(errno_name(&e)), Some(true)),
    };
    exchange(stream, line.as_bytes(), id, deadline)
}

// ----- the outcome --------------------------------------------------------

/// What the socket showed, in the order it showed it.
pub enum Event<'a> {
    Data(&'a [u8]),
    /// The last request byte went out.
    AllWritten,
    Eof,
    ReadError(Error),
    WriteError(Error),
}

/// The outcome of one connected exchange, decided from its events alone.
pub struct Session<'a> {
    id: &'a [u16],
    lines: LineBuffer,
    first_error: Option<Error>,
    all_written: bool,
}

impl<'a> Session<'a> {
    pub fn new(id: &'a [u16]) -> Self {
        Session {
            id,
            lines: LineBuffer::default(),
            first_error: None,
            all_written: false,
        }
    }

    /// Feed one event; `Some` is the settled outcome.
    pub fn on(&mut self, event: Event) -> Option<Json> {
        match event {
            Event::Data(bytes) => self.lines.push(bytes).iter().find_map(|l| matching_reply(l, self.id)),
            Event::AllWritten => {
                self.all_written = true;
                None
            }
            Event::Eof => Some(match self.first_error.take() {
                Some(e) => lost(&e),
                // The server closed before taking the whole line: it never
                // reached processLine, so nothing can be waiting on it.
                None if !self.all_written => lost(&Error::from_raw_os_error(EPIPE)),
                None => failure("closed-without-response", None, Some(false)),
            }),
            Event::ReadError(e) => Some(lost(self.first_error.as_ref().unwrap_or(&e))),
            Event::WriteError(e) => {
                self.first_error.get_or_insert(e);
                None
            }
        }
    }

    /// The drain after a write error found nothing more: the write error.
    /// (Only a write error leads here; without one the outcome is still the
    /// connection lost, never a timeout.)
    pub fn drained(&mut self) -> Json {
        lost(
            &self
                .first_error
                .take()
                .unwrap_or_else(|| Error::from_raw_os_error(EPIPE)),
        )
    }

    /// The deadline passed after the connect: the request counts as written.
    pub fn deadline(&self) -> Json {
        failure("timeout", None, Some(false))
    }
}

const EPIPE: i32 = 32;

/// A socket error once connected: Node's `error` event after the write, so
/// the request may have been delivered and is never sent again.
fn lost(e: &Error) -> Json {
    failure("connect-error", Some(errno_name(e)), Some(false))
}

// ----- the exchange ---------------------------------------------------------

/// Read and write until the session settles. Each round reads first; a write
/// error is followed by a drain of what is readable now, then settles.
fn exchange(mut stream: UnixStream, out: &[u8], id: &[u16], deadline: Instant) -> Json {
    let mut session = Session::new(id);
    let mut written = 0;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let want_write = written < out.len();
        let Some(timeout_ms) = remaining_ms(deadline) else {
            return session.deadline();
        };
        let revents = match poll_one(stream.as_raw_fd(), want_write, timeout_ms) {
            Ok(r) => r,
            Err(e) => return lost(&e),
        };
        let ready = match classify(revents) {
            Ok(ready) => ready,
            Err(e) => return lost(&e),
        };
        if ready.read {
            if let Some(outcome) = drain(&mut stream, &mut chunk, &mut session, deadline) {
                return outcome;
            }
        }
        if want_write && ready.write {
            match write_some(&mut stream, &out[written..]) {
                Ok(n) => {
                    written += n;
                    if written == out.len() {
                        session.on(Event::AllWritten);
                    }
                }
                Err(e) => {
                    session.on(Event::WriteError(e));
                    if let Some(outcome) = drain(&mut stream, &mut chunk, &mut session, deadline) {
                        return outcome;
                    }
                    return session.drained();
                }
            }
        }
    }
}

/// Read until the socket would block, feeding the session; a peer that
/// never stops sending still ends at the deadline.
fn drain(stream: &mut UnixStream, chunk: &mut [u8], session: &mut Session, deadline: Instant) -> Option<Json> {
    loop {
        if Instant::now() >= deadline {
            return Some(session.deadline());
        }
        let event = match stream.read(chunk) {
            Ok(0) => Event::Eof,
            Ok(n) => Event::Data(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == ErrorKind::WouldBlock => return None,
            Err(e) => Event::ReadError(e),
        };
        if let Some(outcome) = session.on(event) {
            return Some(outcome);
        }
    }
}

/// Write until done or the socket would block; the count written.
fn write_some(stream: &mut UnixStream, out: &[u8]) -> std::io::Result<usize> {
    let mut written = 0;
    while written < out.len() {
        match stream.write(&out[written..]) {
            Ok(n) => written += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == ErrorKind::WouldBlock => break,
            Err(e) => return Err(e),
        }
    }
    Ok(written)
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

#[derive(Debug, PartialEq)]
pub struct Ready {
    pub read: bool,
    pub write: bool,
}

/// What a poll result allows. POLLERR and POLLHUP mean "read to find out";
/// POLLNVAL, or any bit this loop never asked about, is a dead descriptor:
/// fail now rather than spin on it.
pub fn classify(revents: i16) -> Result<Ready, Error> {
    if revents & !(POLLIN | POLLOUT | POLLERR | POLLHUP) != 0 {
        return Err(Error::from_raw_os_error(unix_sys::EBADF));
    }
    Ok(Ready {
        read: revents & (POLLIN | POLLHUP | POLLERR) != 0,
        write: revents & POLLOUT != 0,
    })
}

/// A non-blocking, close-on-exec unix socket connected to `pipe`, as libuv
/// makes it: a full backlog is an immediate error (EAGAIN on Linux,
/// ECONNREFUSED on macOS), never a wait, and EINTR retries the connect.
fn open(pipe: &str) -> std::io::Result<UnixStream> {
    let Some(addr) = unix_sys::sockaddr_un(pipe.as_bytes()) else {
        return Err(Error::from_raw_os_error(unix_sys::ENAMETOOLONG));
    };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let kind = unix_sys::SOCK_STREAM | unix_sys::SOCK_CLOEXEC;
    #[cfg(target_os = "macos")]
    let kind = unix_sys::SOCK_STREAM;
    // SAFETY: socket() returns a fresh fd that the UnixStream then owns.
    let stream = unsafe {
        let fd = unix_sys::socket(unix_sys::AF_UNIX, kind, 0);
        if fd < 0 {
            return Err(Error::last_os_error());
        }
        UnixStream::from_raw_fd(fd)
    };
    #[cfg(target_os = "macos")]
    // SAFETY: F_SETFD on an fd this function owns.
    if unsafe { unix_sys::fcntl(stream.as_raw_fd(), unix_sys::F_SETFD, unix_sys::FD_CLOEXEC) } != 0 {
        return Err(Error::last_os_error());
    }
    stream.set_nonblocking(true)?;
    loop {
        // SAFETY: the fd is open and `addr` is a sockaddr_un of that length.
        if unsafe { unix_sys::connect(stream.as_raw_fd(), addr.as_ptr(), addr.len() as u32) } == 0 {
            return Ok(stream);
        }
        let e = Error::last_os_error();
        if e.raw_os_error() != Some(unix_sys::EINTR) {
            return Err(e);
        }
    }
}

/// poll(2) on one fd: always for reading, and for writing when asked.
/// Returns the revents (0 on timeout or EINTR).
fn poll_one(fd: i32, want_write: bool, timeout_ms: i32) -> std::io::Result<i16> {
    let mut p = PollFd {
        fd,
        events: POLLIN | if want_write { POLLOUT } else { 0 },
        revents: 0,
    };
    // SAFETY: one valid pollfd for the duration of the call.
    let n = unsafe { unix_sys::poll(&mut p, 1, timeout_ms) };
    if n < 0 {
        let e = Error::last_os_error();
        return if e.kind() == ErrorKind::Interrupted {
            Ok(0)
        } else {
            Err(e)
        };
    }
    Ok(if n == 0 { 0 } else { p.revents })
}

/// libuv's name for an errno, as Node puts it in `err.code`. This table is
/// the Claude transport's own; the shared bridge keeps its shorter one.
pub fn errno_name(e: &Error) -> String {
    let Some(n) = e.raw_os_error() else {
        return e.to_string();
    };
    let common = match n {
        1 => Some("EPERM"),
        2 => Some("ENOENT"),
        4 => Some("EINTR"),
        9 => Some("EBADF"),
        12 => Some("ENOMEM"),
        13 => Some("EACCES"),
        16 => Some("EBUSY"),
        20 => Some("ENOTDIR"),
        22 => Some("EINVAL"),
        23 => Some("ENFILE"),
        24 => Some("EMFILE"),
        32 => Some("EPIPE"),
        _ => None,
    };
    #[cfg(target_os = "macos")]
    let specific = match n {
        35 => Some("EAGAIN"),
        38 => Some("ENOTSOCK"),
        41 => Some("EPROTOTYPE"),
        53 => Some("ECONNABORTED"),
        54 => Some("ECONNRESET"),
        55 => Some("ENOBUFS"),
        57 => Some("ENOTCONN"),
        60 => Some("ETIMEDOUT"),
        61 => Some("ECONNREFUSED"),
        63 => Some("ENAMETOOLONG"),
        _ => None,
    };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let specific = match n {
        11 => Some("EAGAIN"),
        36 => Some("ENAMETOOLONG"),
        88 => Some("ENOTSOCK"),
        91 => Some("EPROTOTYPE"),
        103 => Some("ECONNABORTED"),
        104 => Some("ECONNRESET"),
        105 => Some("ENOBUFS"),
        107 => Some("ENOTCONN"),
        110 => Some("ETIMEDOUT"),
        111 => Some("ECONNREFUSED"),
        _ => None,
    };
    // uv_err_name for an errno libuv does not know.
    common
        .or(specific)
        .map_or_else(|| format!("Unknown system error -{n}"), str::to_string)
}

#[cfg(test)]
mod tests {
    //! The transport against stubs of #3134's stub daemon modes; each test
    //! names the characterisation cases it stands for.
    use super::*;
    use crate::claude::CLAUDE_POLICY;
    use crate::js;
    use crate::rpc::{send_rpc_with_retry, WalkPolicy};
    use crate::unix_sys::POLLNVAL;
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

    thread_local! {
        /// Connect attempts on this test's thread (each test has its own).
        static ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

    fn counted(pipe: &str, line: &str, id: &[u16], deadline: Instant) -> Json {
        ATTEMPTS.with(|a| a.set(a.get() + 1));
        send_rpc(pipe, line, id, deadline)
    }

    /// With the connect retry: the outcome, the time taken and the attempts.
    fn with_retry(pipe: &str, line: &str, ms: u64) -> (Json, Duration, usize) {
        ATTEMPTS.with(|a| a.set(0));
        let start = Instant::now();
        let result = send_rpc_with_retry(counted, pipe, line, &js::js(ID), start + Duration::from_millis(ms));
        (result, start.elapsed(), ATTEMPTS.with(std::cell::Cell::get))
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

    /// After a write, a lost answer a Stop gate fails CLOSED on.
    fn fails_closed(v: &Json) -> bool {
        let t = text(v);
        t == r#"{"ok":false,"error":"closed-without-response","retryable":false}"#
            || t == r#"{"ok":false,"error":"timeout","retryable":false}"#
    }

    /// After a write, a socket error a Stop gate fails OPEN on.
    fn fails_open(v: &Json) -> bool {
        let t = text(v);
        ["EPIPE", "ECONNRESET", "ENOTCONN"]
            .iter()
            .any(|c| t == format!(r#"{{"ok":false,"error":"connect-error","detail":"{c}","retryable":false}}"#))
    }

    // ----- the outcome, from event sequences alone -------------------------

    fn errno(name: &str) -> Error {
        let n = match name {
            "EPIPE" => 32,
            "ECONNRESET" if cfg!(target_os = "macos") => 54,
            "ECONNRESET" => 104,
            _ => unreachable!(),
        };
        Error::from_raw_os_error(n)
    }

    /// Feed events until one settles; None when none did.
    fn outcome(events: Vec<Event>) -> Option<String> {
        outcome_then(events, |_| None)
    }

    /// The same, then `end` when nothing settled (a drain, the deadline).
    fn outcome_then(events: Vec<Event>, end: fn(&mut Session) -> Option<Json>) -> Option<String> {
        let id = js::js(ID);
        let mut session = Session::new(&id);
        let settled = events.into_iter().find_map(|e| session.on(e));
        settled.or_else(|| end(&mut session)).map(|o| text(&o))
    }

    fn connect_error(code: &str) -> Option<String> {
        Some(format!(
            r#"{{"ok":false,"error":"connect-error","detail":"{code}","retryable":false}}"#
        ))
    }

    #[test]
    fn a_write_error_settles_by_its_own_code() {
        // Then EOF: the write error, not closed-without-response.
        assert_eq!(
            outcome(vec![Event::WriteError(errno("EPIPE")), Event::Eof]),
            connect_error("EPIPE")
        );
        // Nothing readable after it: settled at once, never a wait for EOF.
        assert_eq!(
            outcome_then(vec![Event::WriteError(errno("EPIPE"))], |s| Some(s.drained())),
            connect_error("EPIPE")
        );
        // Then a read error: the first error's code, as Node's first `error` event.
        assert_eq!(
            outcome(vec![
                Event::WriteError(errno("EPIPE")),
                Event::ReadError(errno("ECONNRESET"))
            ]),
            connect_error("EPIPE")
        );
        // A write error is never an outcome by itself.
        assert_eq!(outcome(vec![Event::WriteError(errno("EPIPE"))]), None);
    }

    #[test]
    fn a_matching_reply_wins_over_a_write_error() {
        let reply = format!("{}\n", ok_reply());
        assert_eq!(
            outcome(vec![Event::Data(reply.as_bytes()), Event::WriteError(errno("EPIPE"))]),
            Some(ok_reply())
        );
        assert_eq!(
            outcome_then(
                vec![Event::WriteError(errno("EPIPE")), Event::Data(reply.as_bytes())],
                |s| Some(s.drained())
            ),
            Some(ok_reply())
        );
    }

    #[test]
    fn a_drain_stops_at_the_deadline_even_with_data_waiting() {
        let (mut ours, mut theirs) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        theirs.write_all(b"{\"id\":\"other\"}\n").unwrap();
        let id = js::js(ID);
        let mut session = Session::new(&id);
        let outcome = drain(&mut ours, &mut [0u8; 64], &mut session, Instant::now());
        assert_eq!(
            outcome.map(|o| text(&o)).as_deref(),
            Some(r#"{"ok":false,"error":"timeout","retryable":false}"#)
        );
    }

    #[test]
    fn eof_before_the_whole_request_went_out_is_epipe() {
        // walk-over-long-request, walk-reset-after-accept-no-retry: the server
        // closed on a partial line, which no handler ever saw. Fail open.
        assert_eq!(outcome(vec![Event::Eof]), connect_error("EPIPE"));
        assert_eq!(
            outcome(vec![Event::Data(b"{\"type\":\"x\"}\n"), Event::Eof]),
            connect_error("EPIPE")
        );
        // The whole line went out, then EOF: the answer was lost. Fail closed.
        assert_eq!(
            outcome(vec![Event::AllWritten, Event::Eof]).as_deref(),
            Some(r#"{"ok":false,"error":"closed-without-response","retryable":false}"#)
        );
    }

    #[test]
    fn the_other_events_map_as_node_does() {
        assert_eq!(
            outcome(vec![Event::ReadError(errno("ECONNRESET"))]),
            connect_error("ECONNRESET")
        );
        assert_eq!(
            outcome_then(vec![Event::AllWritten], |s| Some(s.deadline())).as_deref(),
            Some(r#"{"ok":false,"error":"timeout","retryable":false}"#)
        );
        // Foreign lines and a partial last line settle nothing; EOF does.
        let partial = format!("{{\"id\":\"other\"}}\nnot json\n{}", ok_reply());
        assert_eq!(
            outcome(vec![Event::AllWritten, Event::Data(partial.as_bytes()), Event::Eof]).as_deref(),
            Some(r#"{"ok":false,"error":"closed-without-response","retryable":false}"#)
        );
    }

    // ----- the socket ----------------------------------------------------------

    #[test]
    fn a_dead_descriptor_fails_instead_of_spinning() {
        assert_eq!(
            classify(POLLIN | POLLHUP).unwrap(),
            Ready {
                read: true,
                write: false
            }
        );
        assert_eq!(
            classify(POLLOUT | POLLERR).unwrap(),
            Ready {
                read: true,
                write: true
            }
        );
        assert_eq!(classify(POLLNVAL).unwrap_err().raw_os_error(), Some(unix_sys::EBADF));
        assert!(classify(0x40).is_err(), "an unasked-for bit");
        // A descriptor that is not open polls as POLLNVAL.
        let revents = poll_one(1_000_000, true, 100).unwrap();
        assert!(classify(revents).is_err(), "revents {revents:#x}");
    }

    #[test]
    fn the_socket_is_close_on_exec() {
        let s = stub("cloexec", Mode::Hold);
        let stream = open(&s.path).unwrap();
        // SAFETY: F_GETFD on an open fd.
        let flags = unsafe { unix_sys::fcntl(stream.as_raw_fd(), unix_sys::F_GETFD) };
        assert!(flags >= 0 && flags & unix_sys::FD_CLOEXEC != 0, "flags {flags}");
    }

    #[test]
    fn errno_names_are_libuv_names() {
        let name = |n| errno_name(&Error::from_raw_os_error(n));
        for (n, expected) in [
            (4, "EINTR"),
            (23, "ENFILE"),
            (24, "EMFILE"),
            (12, "ENOMEM"),
            (9, "EBADF"),
        ] {
            assert_eq!(name(n), expected);
        }
        #[cfg(target_os = "macos")]
        let specific = [(35, "EAGAIN"), (53, "ECONNABORTED"), (55, "ENOBUFS"), (57, "ENOTCONN")];
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let specific = [
            (11, "EAGAIN"),
            (103, "ECONNABORTED"),
            (105, "ENOBUFS"),
            (107, "ENOTCONN"),
        ];
        for (n, expected) in specific {
            assert_eq!(name(n), expected);
        }
        assert_eq!(name(9999), "Unknown system error -9999");
    }

    /// A server that has stopped reading for good but keeps the socket open.
    /// On Linux a write issued AFTER the peer's shutdown(SHUT_RD) fails with
    /// EPIPE at once (unix_stream_sendmsg checks the writer's SEND_SHUTDOWN,
    /// which the peer's shutdown sets), and the outcome must come then, not at
    /// the deadline (a Stop gate would read a timeout as a lost answer).
    ///
    /// The order is forced: connect, wait for the server's shutdown, then
    /// write. Writes that land before the shutdown fill the buffer of a peer
    /// that never reads; the socket then never turns writable again (Linux
    /// unix_writable counts only the sender's queued bytes), no later write is
    /// ever issued, and Node and this transport both time out, correctly.
    /// macOS does not fail such writes at all, so this is Linux only.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn a_write_after_the_peer_stopped_reading_settles_at_once() {
        let d = dir("shut-read");
        let path = format!("{d}/s.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (shut, after_shut) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            conn.shutdown(std::net::Shutdown::Read).unwrap();
            shut.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(10));
            drop(conn);
        });
        let stream = open(&path).unwrap();
        after_shut.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        let id = js::js(ID);
        let result = exchange(stream, request(10).as_bytes(), &id, start + Duration::from_secs(20));
        // "At once" against a 20 s deadline: a generous ceiling.
        assert!(start.elapsed() < Duration::from_secs(5), "{:?}", start.elapsed());
        assert_eq!(Some(text(&result)), connect_error("EPIPE"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn an_error_after_connect_is_not_retryable() {
        for (errno, name) in [
            (32, "EPIPE"),
            (if cfg!(target_os = "macos") { 54 } else { 104 }, "ECONNRESET"),
        ] {
            assert_eq!(
                text(&lost(&std::io::Error::from_raw_os_error(errno))),
                format!(r#"{{"ok":false,"error":"connect-error","detail":"{name}","retryable":false}}"#)
            );
        }
    }

    #[test]
    fn accept_then_reset_is_one_attempt() {
        // walk-reset-after-accept-no-retry: written on connect, so no retry.
        // The small request may or may not have gone out before the reset:
        // all of it then EOF fails closed, a part of it fails open. Either
        // way, one attempt and no retry.
        let s = stub("reset", Mode::Reset);
        let (result, _, attempts) = with_retry(&s.path, &request(10), 2000);
        assert!(fails_closed(&result) || fails_open(&result), "{}", text(&result));
        assert_eq!(attempts, 1);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_over_long_line_is_dropped_after_the_write() {
        // walk-over-long-request
        // The server drops the line before the client finished it: fail open.
        let s = stub("long", Mode::OverLong);
        let (result, _, attempts) = with_retry(&s.path, &request(1_200_000), 2000);
        assert!(fails_open(&result), "{}", text(&result));
        assert_eq!(attempts, 1);
        assert_eq!(s.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_missing_pipe_fails_at_once_and_is_not_retried() {
        // walk-daemon-absent-advances, gate-no-main, perm-unreachable-is-silent
        let d = dir("absent");
        let (result, took, attempts) = with_retry(&format!("{d}/none.sock"), &request(10), 2000);
        assert_eq!(
            text(&result),
            r#"{"ok":false,"error":"connect-error","detail":"ENOENT","retryable":true}"#
        );
        assert_eq!(attempts, 1);
        assert!(took < Duration::from_millis(1500), "{took:?}");
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
        let (result, took, attempts) = with_retry(&path, &request(10), 2000);
        assert_eq!(
            text(&result),
            r#"{"ok":false,"error":"connect-error","detail":"ECONNREFUSED","retryable":true}"#
        );
        // Three attempts with 100 and 250 ms slept between them.
        assert_eq!(attempts, 3);
        assert!(took >= Duration::from_millis(350), "{took:?}");
        // A backoff that would cross the deadline is not slept: one retry only.
        let (_, took, attempts) = with_retry(&path, &request(10), 200);
        assert_eq!(attempts, 2);
        assert!(took >= Duration::from_millis(100), "{took:?}");
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
