//! `wmux-native mcp-shim`: the per-agent MCP process under the broker
//! topology, with the contract of src/mcp/shim.ts.
//!
//! It asserts who it is to the broker in one JSON handshake line (its pid and
//! ppid, the pane env hints, the pipe auth token and the surface flags), then
//! pumps raw bytes: stdin to the broker pipe, the broker pipe to stdout.
//! stdout carries only broker bytes; diagnostics go to stderr.
//!
//! It runs as the host's direct child (no wrapper, no re-exec), so the broker's
//! identity walk from `callerPid` sees the same ancestry as with the Node shim.
//!
//! Exit codes, as shim.ts: 0 when the host ends the session (stdin EOF or a
//! read error, SIGTERM/SIGINT, Ctrl+C on Windows); 1 when there is no token,
//! the broker cannot be reached, or the connection drops mid-session. A dropped
//! session is never resumed: MCP servers keep per-session state, so the host
//! must see the server die and restart it. As in shim.ts, the signal handlers
//! are installed once the handshake is written; before that a signal kills the
//! process by its default disposition.
//!
//! One intentional divergence from shim.ts: a failed stdout write exits 0.
//! The host stopped reading, which is a normal shutdown, and node's exit 1
//! there is an unhandled-error accident, not a contract.
//!
//! EAGAIN on an inherited non-blocking stdin or stdout is waited out, not
//! taken as the end of the session.

use crate::js::{decode_utf8_trimmed, stringify, JsStr, Json};
use crate::paths::{env, env_js, os_to_js};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// The `wmuxShim` handshake version the broker checks for.
pub const PROTOCOL_VERSION: u32 = 1;
const CONNECT_RETRIES: u32 = 10;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(300);
const COMMANDER_MODE_ARG: &str = "--commander";
const CORE_MODE_ARG: &str = "--core";
const ROLE_MODE_ARG_PREFIX: &str = "--role=";
const SELF_TEST_ARG: &str = "--self-test";
const PREFIX: &str = "[wmux-mcp-shim]";

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub commander: bool,
    pub core: bool,
    /// The last `--role=` value, unvalidated (the broker judges it).
    pub role: Option<JsStr>,
    pub self_test: bool,
}

/// `process.argv.includes(...)` and `roleArgValue`: exact flags, the last
/// `--role=` wins, anything else is ignored.
pub fn parse_args(args: &[OsString]) -> Args {
    let prefix = crate::js::js(ROLE_MODE_ARG_PREFIX);
    let mut out = Args::default();
    for arg in args {
        let a = os_to_js(arg);
        if a == crate::js::js(COMMANDER_MODE_ARG) {
            out.commander = true;
        } else if a == crate::js::js(CORE_MODE_ARG) {
            out.core = true;
        } else if a == crate::js::js(SELF_TEST_ARG) {
            out.self_test = true;
        }
        if a.starts_with(&prefix) {
            out.role = Some(a[prefix.len()..].to_vec());
        }
    }
    out
}

/// How a session ended, and the exit code each end maps to.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    StdinEnd,
    StdinError,
    Signal,
    StdoutClosed,
    NoToken,
    Unreachable { pipe: String, error: String },
    BrokerClosed,
    BrokerError(String),
}

impl Outcome {
    pub const fn code(&self) -> i32 {
        match self {
            Outcome::StdinEnd | Outcome::StdinError | Outcome::Signal | Outcome::StdoutClosed => 0,
            Outcome::NoToken | Outcome::Unreachable { .. } | Outcome::BrokerClosed | Outcome::BrokerError(_) => 1,
        }
    }

    /// The stderr line, as shim.ts words it; None for a quiet end.
    pub fn message(&self) -> Option<String> {
        match self {
            Outcome::NoToken => Some(format!("{PREFIX} auth token not found. Is wmux running?")),
            Outcome::Unreachable { pipe, error } => Some(format!("{PREFIX} cannot reach broker at {pipe}: {error}")),
            Outcome::BrokerClosed => Some(format!("{PREFIX} broker connection closed")),
            Outcome::BrokerError(e) => Some(format!("{PREFIX} broker connection error: {e}")),
            _ => None,
        }
    }
}

// ----- token and endpoint ----------------------------------------------------
//
// The private helpers from here to the end of the Windows transport mirror
// shared ones on purpose, so this module stays independent of the parallel
// reshaping of paths.rs and rpc.rs: data_suffix and the homedir fallback mirror
// paths::data_suffix and paths::os_homedir; sys::username mirrors
// paths::username; sys::connect (the macOS sun_path form, and on Windows the
// PIPE_BUSY wait and the GetFileType check) mirrors rpc::transport::connect;
// errno_name mirrors rpc::transport::code and rpc::win32_code_name.

fn data_suffix() -> String {
    env("WMUX_DATA_SUFFIX").unwrap_or_default()
}

/// getAuthTokenPath: a template string, so an empty home yields `/.wmux…`.
pub fn token_path_from(userprofile: Option<String>, home: Option<String>, suffix: &str) -> String {
    let home = userprofile
        .filter(|v| !v.is_empty())
        .or(home.filter(|v| !v.is_empty()))
        .unwrap_or_default();
    format!("{home}/.wmux{suffix}-auth-token")
}

/// readAuthToken: the trimmed file if non-empty, else a non-empty
/// WMUX_AUTH_TOKEN (not trimmed), else None.
pub fn resolve_token(file: Option<&[u8]>, env_token: Option<JsStr>) -> Option<JsStr> {
    if let Some(token) = file.map(decode_utf8_trimmed).filter(|t| !t.is_empty()) {
        return Some(token);
    }
    env_token.filter(|t| !t.is_empty())
}

fn read_auth_token() -> Option<JsStr> {
    let path = token_path_from(env("USERPROFILE"), env("HOME"), &data_suffix());
    let file = std::fs::read(path).ok();
    resolve_token(file.as_deref(), env_js("WMUX_AUTH_TOKEN"))
}

/// getMcpBrokerPipeName on Unix: `os.homedir() || '/tmp'`, where homedir is
/// HOME whenever it is set (even empty) and the account database otherwise.
#[cfg(any(unix, test))]
pub fn unix_pipe_from(home_var: Option<String>, account: impl FnOnce() -> String, suffix: &str) -> String {
    let home = home_var.unwrap_or_else(account);
    let home = if home.is_empty() { "/tmp".to_string() } else { home };
    format!("{home}/.wmux-mcpb{suffix}.sock")
}

/// getMcpBrokerPipeName on Windows.
#[cfg(any(windows, test))]
pub fn windows_pipe_from(username: &str, suffix: &str) -> String {
    let user = if username.is_empty() { "default" } else { username };
    format!(r"\\.\pipe\wmux-mcpb{suffix}-{user}")
}

#[cfg(unix)]
fn broker_pipe_name() -> String {
    unix_pipe_from(
        env("HOME"),
        || {
            #[allow(deprecated)]
            std::env::home_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default()
        },
        &data_suffix(),
    )
}

#[cfg(windows)]
fn broker_pipe_name() -> String {
    windows_pipe_from(&sys::username(), &data_suffix())
}

// ----- handshake -------------------------------------------------------------

pub struct Handshake {
    pub token: JsStr,
    pub pid: u32,
    pub ppid: i64,
    pub env_workspace_hint: JsStr,
    pub env_pty_hint: JsStr,
    /// WMUX_COMMANDER_TOKEN as set, "" included; None when unset.
    pub commander_token: Option<JsStr>,
    pub args: Args,
}

/// The handshake line, newline included, with shim.ts's key order. An
/// undefined value (commanderToken, roleSurface) is left out, as
/// JSON.stringify does.
pub fn handshake_line(h: &Handshake) -> String {
    let key = crate::js::js;
    let mut entries: Vec<(JsStr, Json)> = vec![
        (key("wmuxShim"), Json::Num(f64::from(PROTOCOL_VERSION))),
        (key("authToken"), Json::Str(h.token.clone())),
        (key("callerPid"), Json::Num(f64::from(h.pid))),
        (key("callerPpid"), Json::Num(h.ppid as f64)),
        (key("envWorkspaceHint"), Json::Str(h.env_workspace_hint.clone())),
        (key("envPtyHint"), Json::Str(h.env_pty_hint.clone())),
    ];
    if let Some(t) = &h.commander_token {
        entries.push((key("commanderToken"), Json::Str(t.clone())));
    }
    entries.push((key("commanderMode"), Json::Bool(h.args.commander)));
    entries.push((key("coreMode"), Json::Bool(h.args.core)));
    if let Some(role) = &h.args.role {
        entries.push((key("roleSurface"), Json::Str(role.clone())));
    }
    let mut out = String::new();
    stringify(&Json::Obj(entries), &mut out);
    out.push('\n');
    out
}

// ----- process ---------------------------------------------------------------

/// Claimed once by whichever end of the session comes first.
struct ExitClaim(AtomicBool);

impl ExitClaim {
    const fn new() -> Self {
        ExitClaim(AtomicBool::new(false))
    }

    /// True for the first caller only.
    fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

static EXITING: ExitClaim = ExitClaim::new();

/// First end wins: a stdin EOF racing a broker close must not report both,
/// and a broker read error reports itself, as node's 'error' comes before
/// its 'close'.
fn claim_exit() -> bool {
    EXITING.claim()
}

/// Best effort: a broken stderr must not stop the exit (eprintln! panics).
fn say(msg: &str) {
    let _ = writeln!(std::io::stderr(), "{msg}");
}

fn exit_with(outcome: Outcome) -> ! {
    let code = outcome.code();
    if let Some(msg) = outcome.message() {
        say(&msg);
    }
    std::process::exit(code)
}

/// End the process with `outcome` unless another thread already is.
fn finish(outcome: Outcome) -> ! {
    if claim_exit() {
        exit_with(outcome);
    }
    loop {
        std::thread::park();
    }
}

/// libuv's error name for an OS error, as Node puts it in `err.code`.
#[cfg(unix)]
fn errno_name(e: &std::io::Error) -> String {
    let Some(n) = e.raw_os_error() else {
        return e.to_string();
    };
    #[cfg(target_os = "linux")]
    const NAMES: &[(i32, &str)] = &[
        (1, "EPERM"),
        (2, "ENOENT"),
        (4, "EINTR"),
        (5, "EIO"),
        (9, "EBADF"),
        (11, "EAGAIN"),
        (12, "ENOMEM"),
        (13, "EACCES"),
        (20, "ENOTDIR"),
        (21, "EISDIR"),
        (22, "EINVAL"),
        (23, "ENFILE"),
        (24, "EMFILE"),
        (32, "EPIPE"),
        (36, "ENAMETOOLONG"),
        (40, "ELOOP"),
        (88, "ENOTSOCK"),
        (91, "EPROTOTYPE"),
        (98, "EADDRINUSE"),
        (99, "EADDRNOTAVAIL"),
        (104, "ECONNRESET"),
        (110, "ETIMEDOUT"),
        (111, "ECONNREFUSED"),
    ];
    #[cfg(not(target_os = "linux"))]
    const NAMES: &[(i32, &str)] = &[
        (1, "EPERM"),
        (2, "ENOENT"),
        (4, "EINTR"),
        (5, "EIO"),
        (9, "EBADF"),
        (12, "ENOMEM"),
        (13, "EACCES"),
        (20, "ENOTDIR"),
        (21, "EISDIR"),
        (22, "EINVAL"),
        (23, "ENFILE"),
        (24, "EMFILE"),
        (32, "EPIPE"),
        (35, "EAGAIN"),
        (38, "ENOTSOCK"),
        (41, "EPROTOTYPE"),
        (48, "EADDRINUSE"),
        (49, "EADDRNOTAVAIL"),
        (54, "ECONNRESET"),
        (60, "ETIMEDOUT"),
        (61, "ECONNREFUSED"),
        (62, "ELOOP"),
        (63, "ENAMETOOLONG"),
    ];
    match NAMES.iter().find(|(code, _)| *code == n) {
        Some((_, name)) => (*name).into(),
        None => format!("Unknown system error -{n}"),
    }
}

/// libuv's uv_translate_sys_error for a Win32 error, then its name.
#[cfg(windows)]
fn errno_name(e: &std::io::Error) -> String {
    let Some(n) = e.raw_os_error() else {
        return e.to_string();
    };
    match n {
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
        _ => "UNKNOWN",
    }
    .into()
}

/// Node's err.message for a failed socket read or write mid-session:
/// `<syscall> <code>`, e.g. `read ECONNRESET` (no address, unlike connect).
fn socket_error(syscall: &str, e: &std::io::Error) -> String {
    format!("{syscall} {}", errno_name(e))
}

/// Node's err.message for a failed pipe connect: `connect <code> <pipe>`.
fn connect_error(e: &std::io::Error, pipe: &str) -> String {
    format!("connect {} {pipe}", errno_name(e))
}

fn connect_with_retry(pipe: &str) -> Result<sys::Conn, std::io::Error> {
    let mut last = None;
    for _ in 0..CONNECT_RETRIES {
        match sys::connect(pipe) {
            Ok(conn) => return Ok(conn),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(CONNECT_RETRY_DELAY);
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no attempt")))
}

/// Which of the host's stdio streams an operation is on.
#[derive(Clone, Copy)]
enum HostStream {
    Stdin,
    Stdout,
}

/// What to do after a failed stdio read or write.
#[derive(PartialEq)]
enum Next {
    Retry,
    /// The stream ended (EOF for stdin, gone for stdout).
    Ended,
    Fail,
}

/// Interrupted is retried at once. WouldBlock (an inherited non-blocking
/// stdio) waits until the stream is ready, as Node's stream would, and is
/// retried, unless the wait finds the stream ended.
fn after_error(e: &std::io::Error, stream: HostStream) -> Next {
    match e.kind() {
        std::io::ErrorKind::Interrupted => Next::Retry,
        std::io::ErrorKind::WouldBlock => {
            if sys::wait_ready(stream) {
                Next::Retry
            } else {
                Next::Ended
            }
        }
        _ => Next::Fail,
    }
}

/// write_all and flush, waiting out WouldBlock instead of failing on it.
fn write_patiently(out: &mut impl Write, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        match out.write(bytes) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if after_error(&e, HostStream::Stdout) == Next::Retry => {}
            Err(e) => return Err(e),
        }
    }
    loop {
        match out.flush() {
            Ok(()) => return Ok(()),
            Err(e) if after_error(&e, HostStream::Stdout) == Next::Retry => {}
            Err(e) => return Err(e),
        }
    }
}

/// What one read from the broker means for the session.
#[derive(Debug, PartialEq)]
enum ReadStep {
    Data(usize),
    Retry,
    End(Outcome),
}

/// A read error ends the session as that error (`read ECONNRESET`), never as
/// a plain close: only a read of 0 bytes is the broker closing.
fn read_step(r: std::io::Result<usize>) -> ReadStep {
    match r {
        Ok(0) => ReadStep::End(Outcome::BrokerClosed),
        Ok(n) => ReadStep::Data(n),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => ReadStep::Retry,
        Err(e) => ReadStep::End(Outcome::BrokerError(socket_error("read", &e))),
    }
}

/// Broker to stdout until either side ends.
fn pump_to_stdout(mut read: impl FnMut(&mut [u8]) -> std::io::Result<usize>) -> ! {
    let mut buf = vec![0u8; 64 * 1024];
    let stdout = std::io::stdout();
    loop {
        let n = match read_step(read(&mut buf)) {
            ReadStep::Data(n) => n,
            ReadStep::Retry => continue,
            ReadStep::End(outcome) => finish(outcome),
        };
        // A write failure means the host stopped reading: its session is over
        // (exit 0, the divergence the module doc states).
        if write_patiently(&mut stdout.lock(), &buf[..n]).is_err() {
            finish(Outcome::StdoutClosed);
        }
    }
}

/// stdin to the broker; returns on stdin EOF, ends the process otherwise.
fn pump_from_stdin(mut write: impl FnMut(&[u8]) -> std::io::Result<()>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut stdin = std::io::stdin().lock();
    loop {
        let n = match stdin.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e) => match after_error(&e, HostStream::Stdin) {
                Next::Retry => continue,
                Next::Ended => return,
                Next::Fail => finish(Outcome::StdinError),
            },
        };
        if let Err(e) = write(&buf[..n]) {
            finish(Outcome::BrokerError(socket_error("write", &e)));
        }
    }
}

pub fn run(args: &[OsString]) -> ! {
    let args = parse_args(args);
    if args.self_test {
        let _ = writeln!(std::io::stdout(), "wmux-mcp-shim protocol {PROTOCOL_VERSION}");
        std::process::exit(0);
    }
    let Some(token) = read_auth_token() else {
        exit_with(Outcome::NoToken);
    };
    let pipe = broker_pipe_name();
    let conn = match connect_with_retry(&pipe) {
        Ok(conn) => conn,
        Err(e) => exit_with(Outcome::Unreachable {
            error: connect_error(&e, &pipe),
            pipe,
        }),
    };
    let line = handshake_line(&Handshake {
        token,
        pid: std::process::id(),
        ppid: sys::parent_pid(),
        env_workspace_hint: env_js("WMUX_WORKSPACE_ID").unwrap_or_default(),
        env_pty_hint: env_js("WMUX_PTY_ID").unwrap_or_default(),
        commander_token: env_js("WMUX_COMMANDER_TOKEN"),
        args,
    });
    sys::session(conn, line.as_bytes())
}

// ----- Unix transport --------------------------------------------------------

#[cfg(unix)]
mod sys {
    use super::{finish, pump_from_stdin, pump_to_stdout, Outcome};
    use std::io::{Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    pub type Conn = UnixStream;

    /// A path past `sun_path` fails with the errno libuv reports for it
    /// (std's own error for it carries none).
    #[cfg(not(target_os = "macos"))]
    pub fn connect(pipe: &str) -> std::io::Result<UnixStream> {
        const SUN_PATH_LEN: usize = 108;
        const ENAMETOOLONG: i32 = 36;
        if pipe.len() >= SUN_PATH_LEN {
            return Err(std::io::Error::from_raw_os_error(ENAMETOOLONG));
        }
        UnixStream::connect(pipe)
    }

    /// macOS takes a sockaddr_un longer than its 104-byte `sun_path` when
    /// `sun_len` says so, and libuv (so the Node shim and the broker that
    /// bound the socket) relies on that. std refuses such a path, so build the
    /// address by hand for the long case.
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
        // sun_len, sun_family, path, NUL; sun_len is one byte.
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

    pub fn parent_pid() -> i64 {
        i64::from(std::os::unix::process::parent_id())
    }

    /// Block in poll(2) until the host's stdin is readable or its stdout
    /// writable. False when poll reports the stream ended instead (HUP, ERR or
    /// NVAL without the readiness asked for) or fails: what a read or write
    /// would then report, end of input for stdin and a gone reader for stdout.
    pub fn wait_ready(stream: super::HostStream) -> bool {
        #[repr(C)]
        struct PollFd {
            fd: i32,
            events: i16,
            revents: i16,
        }
        #[cfg(target_os = "linux")]
        type NFds = std::ffi::c_ulong;
        #[cfg(not(target_os = "linux"))]
        type NFds = std::ffi::c_uint;
        extern "C" {
            fn poll(fds: *mut PollFd, nfds: NFds, timeout: i32) -> i32;
        }
        const POLLIN: i16 = 0x1;
        const POLLOUT: i16 = 0x4;
        const POLLERR: i16 = 0x8;
        const POLLHUP: i16 = 0x10;
        const POLLNVAL: i16 = 0x20;
        let (fd, want) = match stream {
            super::HostStream::Stdin => (0, POLLIN),
            super::HostStream::Stdout => (1, POLLOUT),
        };
        loop {
            let mut pfd = PollFd {
                fd,
                events: want,
                revents: 0,
            };
            // SAFETY: one valid pollfd; no timeout.
            if unsafe { poll(&mut pfd, 1, -1) } < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return false;
            }
            if pfd.revents & want != 0 {
                return true;
            }
            if pfd.revents & (POLLERR | POLLHUP | POLLNVAL) != 0 {
                return false;
            }
        }
    }

    extern "C" fn on_signal(_: i32) {
        extern "C" {
            fn _exit(code: i32) -> !;
        }
        // SAFETY: _exit is async-signal-safe; the kernel closes the socket.
        unsafe { _exit(Outcome::Signal.code()) }
    }

    /// SIGTERM and SIGINT end the session cleanly (exit 0), as in shim.ts.
    fn install_exit_handlers() {
        extern "C" {
            fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
        }
        const SIGINT: i32 = 2;
        const SIGTERM: i32 = 15;
        // SAFETY: the handler only calls _exit.
        unsafe {
            signal(SIGTERM, on_signal);
            signal(SIGINT, on_signal);
        }
    }

    pub fn session(mut conn: UnixStream, handshake: &[u8]) -> ! {
        if let Err(e) = conn.write_all(handshake) {
            finish(Outcome::BrokerError(super::socket_error("write", &e)));
        }
        install_exit_handlers();
        let mut reader = match conn.try_clone() {
            Ok(r) => r,
            Err(e) => finish(Outcome::BrokerError(e.to_string())),
        };
        std::thread::spawn(move || pump_to_stdout(|buf| reader.read(buf)));
        pump_from_stdin(|bytes| (&conn).write_all(bytes));
        // Host closed stdin: end of session. Half-close first, as
        // socket.end() does, so the broker sees an orderly end.
        if super::claim_exit() {
            let _ = conn.shutdown(Shutdown::Write);
            std::process::exit(Outcome::StdinEnd.code());
        }
        loop {
            std::thread::park();
        }
    }
}

// ----- Windows transport -----------------------------------------------------

#[cfg(windows)]
mod sys {
    use super::{finish, pump_from_stdin, pump_to_stdout, Outcome};
    use crate::js::lossy;
    use core::ffi::c_void;
    use std::io::Error;
    use std::sync::Arc;

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
    const SECURITY_IDENTIFICATION: u32 = 1 << 16;
    const FILE_TYPE_PIPE: u32 = 3;
    const ERROR_INVALID_FUNCTION: i32 = 1;
    const ERROR_BROKEN_PIPE: i32 = 109;
    const ERROR_PIPE_BUSY: i32 = 231;
    const ERROR_IO_PENDING: i32 = 997;
    const PIPE_BUSY_WAIT_MS: u32 = 30_000;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: i32,
        peb_base_address: *mut c_void,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn WaitNamedPipeW(name: *const u16, timeout_ms: u32) -> i32;
        fn GetFileType(handle: Handle) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateEventW(security: *mut c_void, manual_reset: i32, initial_state: i32, name: *const u16) -> Handle;
        fn ResetEvent(event: Handle) -> i32;
        fn ReadFile(handle: Handle, buf: *mut u8, len: u32, read: *mut u32, ov: *mut Overlapped) -> i32;
        fn WriteFile(handle: Handle, buf: *const u8, len: u32, written: *mut u32, ov: *mut Overlapped) -> i32;
        fn GetOverlappedResult(handle: Handle, ov: *mut Overlapped, transferred: *mut u32, wait: i32) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process: Handle,
            class: u32,
            info: *mut c_void,
            len: u32,
            returned: *mut u32,
        ) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn GetUserNameW(buffer: *mut u16, size: *mut u32) -> i32;
    }

    /// One manual-reset event per pump thread, reset before each operation.
    pub struct Event(Handle);

    impl Event {
        pub fn new() -> std::io::Result<Event> {
            // SAFETY: a fresh unnamed manual-reset event, owned by the result.
            let h = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
            if h.is_null() {
                return Err(Error::last_os_error());
            }
            Ok(Event(h))
        }
    }

    impl Drop for Event {
        fn drop(&mut self) {
            // SAFETY: the event is owned and closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// The pipe handle, opened for overlapped I/O so one thread's pending read
    /// does not hold up the other's write (a synchronous handle serialises
    /// them, and the session deadlocks).
    pub struct Conn(Handle);
    // SAFETY: a file HANDLE may be used from any thread; each operation brings
    // its own OVERLAPPED, and each thread its own event.
    unsafe impl Send for Conn {}
    unsafe impl Sync for Conn {}

    impl Drop for Conn {
        fn drop(&mut self) {
            // SAFETY: the handle is owned and closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Conn {
        /// One overlapped read or write, waited for on the calling thread's event.
        fn io(&self, event: &Event, buf: *mut u8, len: usize, write: bool) -> std::io::Result<usize> {
            let len = len.min(u32::MAX as usize) as u32;
            let mut ov = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: event.0,
            };
            let mut n = 0u32;
            // SAFETY: `buf` is valid for `len` bytes and, with `ov`, outlives the
            // operation: GetOverlappedResult waits for it to complete. The event
            // belongs to this thread, so no other operation waits on it.
            unsafe {
                ResetEvent(event.0);
                let started = if write {
                    WriteFile(self.0, buf, len, &mut n, &mut ov)
                } else {
                    ReadFile(self.0, buf, len, &mut n, &mut ov)
                };
                if started == 0 && Error::last_os_error().raw_os_error() != Some(ERROR_IO_PENDING) {
                    return Err(Error::last_os_error());
                }
                if GetOverlappedResult(self.0, &mut ov, &mut n, 1) == 0 {
                    return Err(Error::last_os_error());
                }
            }
            Ok(n as usize)
        }

        /// Ok(0) only at the end of the stream. libuv takes ERROR_BROKEN_PIPE
        /// as the end; a read that succeeds with 0 bytes (the server wrote a
        /// zero-length message) is not, so it reads again.
        fn read(&self, event: &Event, buf: &mut [u8]) -> std::io::Result<usize> {
            loop {
                match self.io(event, buf.as_mut_ptr(), buf.len(), false) {
                    Ok(0) => continue,
                    Err(e) if e.raw_os_error() == Some(ERROR_BROKEN_PIPE) => return Ok(0),
                    other => return other,
                }
            }
        }

        fn write_all(&self, event: &Event, mut bytes: &[u8]) -> std::io::Result<()> {
            while !bytes.is_empty() {
                let n = self.io(event, bytes.as_ptr() as *mut u8, bytes.len(), true)?;
                if n == 0 {
                    return Err(Error::from(std::io::ErrorKind::WriteZero));
                }
                bytes = &bytes[n..];
            }
            Ok(())
        }
    }

    fn open(wide: &[u16]) -> Handle {
        // SAFETY: `wide` is NUL-terminated; the returned handle is checked.
        unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        }
    }

    /// Open the client end of the broker pipe. All instances busy is waited
    /// out with WaitNamedPipeW and retried, as libuv does; a name that resolves
    /// to anything but a pipe is refused before the token is written.
    pub fn connect(pipe: &str) -> std::io::Result<Conn> {
        let wide: Vec<u16> = pipe.encode_utf16().chain(Some(0)).collect();
        let handle = loop {
            let handle = open(&wide);
            if handle != INVALID_HANDLE_VALUE {
                break handle;
            }
            let e = Error::last_os_error();
            if e.raw_os_error() != Some(ERROR_PIPE_BUSY) {
                return Err(e);
            }
            // SAFETY: `wide` is NUL-terminated.
            if unsafe { WaitNamedPipeW(wide.as_ptr(), PIPE_BUSY_WAIT_MS) } == 0 {
                return Err(Error::last_os_error());
            }
        };
        let conn = Conn(handle);
        // SAFETY: the handle is valid and owned by `conn`.
        if unsafe { GetFileType(conn.0) } != FILE_TYPE_PIPE {
            return Err(Error::from_raw_os_error(ERROR_INVALID_FUNCTION));
        }
        Ok(conn)
    }

    /// A non-blocking stdio is a Unix notion; a pipe handle that reports one
    /// anyway is retried after a short sleep.
    pub fn wait_ready(_: super::HostStream) -> bool {
        std::thread::sleep(std::time::Duration::from_millis(2));
        true
    }

    /// `process.ppid`: libuv reads InheritedFromUniqueProcessId, -1 on failure.
    pub fn parent_pid() -> i64 {
        let mut info = std::mem::MaybeUninit::<ProcessBasicInformation>::zeroed();
        // SAFETY: class 0 is ProcessBasicInformation, and `info` is its size.
        let status = unsafe {
            NtQueryInformationProcess(
                GetCurrentProcess(),
                0,
                info.as_mut_ptr().cast(),
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                std::ptr::null_mut(),
            )
        };
        if status < 0 {
            return -1;
        }
        // SAFETY: initialised by the successful call.
        unsafe { info.assume_init() }.inherited_from_unique_process_id as i64
    }

    /// `os.userInfo().username` (empty on failure; the caller supplies the default).
    pub fn username() -> String {
        let mut buf = [0u16; 257];
        let mut len = buf.len() as u32;
        // SAFETY: buf is valid for `len` units; len receives the count incl. NUL.
        let ok = unsafe { GetUserNameW(buf.as_mut_ptr(), &mut len) } != 0;
        if ok && len > 0 {
            lossy(&buf[..len as usize - 1])
        } else {
            String::new()
        }
    }

    const CTRL_C_EVENT: u32 = 0;

    /// Ctrl+C is libuv's SIGINT and ends the session cleanly (exit 0). Every
    /// other event (Ctrl+Break, close, logoff, shutdown) goes on to the default
    /// handling, as it does for the Node shim, which listens for SIGINT only.
    unsafe extern "system" fn on_ctrl(event: u32) -> i32 {
        if event != CTRL_C_EVENT {
            return 0;
        }
        if super::claim_exit() {
            std::process::exit(Outcome::Signal.code());
        }
        1
    }

    fn install_exit_handlers() {
        // SAFETY: registers a handler that only exits the process.
        unsafe { SetConsoleCtrlHandler(Some(on_ctrl), 1) };
    }

    pub fn session(conn: Conn, handshake: &[u8]) -> ! {
        let conn = Arc::new(conn);
        let writer_event = match Event::new() {
            Ok(e) => e,
            Err(e) => finish(Outcome::BrokerError(e.to_string())),
        };
        if let Err(e) = conn.write_all(&writer_event, handshake) {
            finish(Outcome::BrokerError(super::socket_error("write", &e)));
        }
        install_exit_handlers();
        let reader = Arc::clone(&conn);
        std::thread::spawn(move || {
            let event = match Event::new() {
                Ok(e) => e,
                Err(e) => finish(Outcome::BrokerError(e.to_string())),
            };
            pump_to_stdout(|buf| reader.read(&event, buf))
        });
        pump_from_stdin(|bytes| conn.write_all(&writer_event, bytes));
        // Host closed stdin: end the session. The handle is not closed here:
        // the reader thread may have an overlapped read pending on it, and
        // closing under it races that read. The process exit right after
        // cancels the read and closes the handle.
        if super::claim_exit() {
            std::process::exit(Outcome::StdinEnd.code());
        }
        loop {
            std::thread::park();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::js;

    fn argv(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    #[test]
    fn flags_are_exact_and_the_last_role_wins() {
        let a = parse_args(&argv(&[
            "--commander",
            "--core",
            "--role=a",
            "x",
            "--role=b",
            "--port",
            "1",
        ]));
        assert!(a.commander && a.core && !a.self_test);
        assert_eq!(a.role, Some(js("b")));
        let b = parse_args(&argv(&["--commander=1", "--cored", "-core", "--role"]));
        assert_eq!(b, Args::default());
        assert_eq!(parse_args(&argv(&["--role="])).role, Some(js("")));
        assert!(parse_args(&argv(&["--self-test"])).self_test);
    }

    #[test]
    fn the_token_file_wins_over_the_env_and_blank_counts_as_absent() {
        assert_eq!(
            resolve_token(Some(b"\xEF\xBB\xBF file \n"), Some(js("env"))),
            Some(js("file"))
        );
        assert_eq!(resolve_token(Some(b" \r\n\t"), Some(js("env"))), Some(js("env")));
        assert_eq!(resolve_token(None, Some(js(" env "))), Some(js(" env ")));
        assert_eq!(resolve_token(None, Some(js(""))), None);
        assert_eq!(resolve_token(Some(b""), None), None);
    }

    #[test]
    fn the_token_path_is_a_template_over_userprofile_then_home() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(token_path_from(s("C:\\U"), s("/h"), "-x"), "C:\\U/.wmux-x-auth-token");
        assert_eq!(token_path_from(s(""), s("/h"), ""), "/h/.wmux-auth-token");
        assert_eq!(token_path_from(None, s(""), "-x"), "/.wmux-x-auth-token");
    }

    #[test]
    fn the_pipe_name_follows_homedir_and_the_suffix() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(unix_pipe_from(s("/h"), || "/acct".into(), "-x"), "/h/.wmux-mcpb-x.sock");
        // Set but empty is kept (os.homedir), then `|| '/tmp'` applies.
        assert_eq!(unix_pipe_from(s(""), || "/acct".into(), ""), "/tmp/.wmux-mcpb.sock");
        assert_eq!(unix_pipe_from(None, || "/acct".into(), ""), "/acct/.wmux-mcpb.sock");
        assert_eq!(unix_pipe_from(None, String::new, ""), "/tmp/.wmux-mcpb.sock");
        assert_eq!(windows_pipe_from("u", "-x"), r"\\.\pipe\wmux-mcpb-x-u");
        assert_eq!(windows_pipe_from("", ""), r"\\.\pipe\wmux-mcpb-default");
    }

    fn sample(commander_token: Option<&str>, args: Args) -> Handshake {
        Handshake {
            token: js("t\"k\u{1}"),
            pid: 42,
            ppid: 7,
            env_workspace_hint: js("ws"),
            env_pty_hint: js(""),
            commander_token: commander_token.map(js),
            args,
        }
    }

    #[test]
    fn the_handshake_has_shim_ts_key_order_and_leaves_undefined_out() {
        assert_eq!(
            handshake_line(&sample(None, Args::default())),
            "{\"wmuxShim\":1,\"authToken\":\"t\\\"k\\u0001\",\"callerPid\":42,\"callerPpid\":7,\
             \"envWorkspaceHint\":\"ws\",\"envPtyHint\":\"\",\"commanderMode\":false,\"coreMode\":false}\n"
        );
        let args = Args {
            commander: true,
            core: true,
            role: Some(js("")),
            self_test: false,
        };
        assert_eq!(
            handshake_line(&sample(Some(""), args)),
            "{\"wmuxShim\":1,\"authToken\":\"t\\\"k\\u0001\",\"callerPid\":42,\"callerPpid\":7,\
             \"envWorkspaceHint\":\"ws\",\"envPtyHint\":\"\",\"commanderToken\":\"\",\
             \"commanderMode\":true,\"coreMode\":true,\"roleSurface\":\"\"}\n"
        );
        let mut h = sample(Some("c"), Args::default());
        h.ppid = -1;
        assert!(handshake_line(&h).contains("\"callerPpid\":-1,"));
        assert!(handshake_line(&h).contains("\"commanderToken\":\"c\","));
    }

    #[test]
    fn an_unreachable_broker_is_worded_as_nodes_connect_error() {
        let os = std::io::Error::from_raw_os_error;
        assert_eq!(connect_error(&os(2), "/p"), "connect ENOENT /p");
        let refused = if cfg!(windows) {
            1225
        } else if cfg!(target_os = "linux") {
            111
        } else {
            61
        };
        assert_eq!(connect_error(&os(refused), "/p"), "connect ECONNREFUSED /p");
        let unknown = if cfg!(windows) {
            "UNKNOWN"
        } else {
            "Unknown system error -9999"
        };
        assert_eq!(connect_error(&os(9999), "/p"), format!("connect {unknown} /p"));
    }

    #[test]
    fn a_mid_session_socket_error_is_worded_as_nodes_err_message() {
        let os = std::io::Error::from_raw_os_error;
        let (reset, pipe) = if cfg!(windows) {
            (64, 232)
        } else if cfg!(target_os = "linux") {
            (104, 32)
        } else {
            (54, 32)
        };
        assert_eq!(socket_error("read", &os(reset)), "read ECONNRESET");
        assert_eq!(socket_error("write", &os(pipe)), "write EPIPE");
        assert_eq!(
            Outcome::BrokerError(socket_error("read", &os(reset)))
                .message()
                .unwrap(),
            "[wmux-mcp-shim] broker connection error: read ECONNRESET"
        );
    }

    /// Linux reports a peer that closed with unread bytes as ECONNRESET on
    /// the next read. That read must end the session as `read ECONNRESET`,
    /// as node's 'error' event does, not as the plain close a 0-byte read is.
    #[test]
    fn a_reset_on_read_is_an_error_not_a_close() {
        let reset = std::io::Error::from_raw_os_error(if cfg!(windows) {
            64
        } else if cfg!(target_os = "linux") {
            104
        } else {
            54
        });
        assert_eq!(
            read_step(Err(reset)),
            ReadStep::End(Outcome::BrokerError("read ECONNRESET".into()))
        );
        assert_eq!(read_step(Ok(0)), ReadStep::End(Outcome::BrokerClosed));
        assert_eq!(read_step(Ok(5)), ReadStep::Data(5));
        assert_eq!(read_step(Err(std::io::ErrorKind::Interrupted.into())), ReadStep::Retry);
    }

    /// The first end claims the exit and later ones are dropped, so the
    /// reader's error, reported first, is the one printed.
    #[test]
    fn the_first_end_wins_the_exit() {
        let claim = ExitClaim::new();
        assert!(claim.claim());
        assert!(!claim.claim());
        assert!(!claim.claim());
    }

    #[test]
    fn host_ends_exit_0_and_broker_failures_exit_1() {
        for o in [
            Outcome::StdinEnd,
            Outcome::StdinError,
            Outcome::Signal,
            Outcome::StdoutClosed,
        ] {
            assert_eq!(o.code(), 0, "{o:?}");
            assert_eq!(o.message(), None, "{o:?}");
        }
        let unreachable = Outcome::Unreachable {
            pipe: "/p".into(),
            error: "e".into(),
        };
        for o in [
            Outcome::NoToken,
            unreachable,
            Outcome::BrokerClosed,
            Outcome::BrokerError("e".into()),
        ] {
            assert_eq!(o.code(), 1, "{o:?}");
            assert!(o.message().unwrap().starts_with("[wmux-mcp-shim] "), "{o:?}");
        }
        assert_eq!(
            Outcome::NoToken.message().unwrap(),
            "[wmux-mcp-shim] auth token not found. Is wmux running?"
        );
    }
}
