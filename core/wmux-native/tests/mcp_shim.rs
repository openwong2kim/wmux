//! The process contract of `wmux-native mcp-shim` (src/mcp/shim.ts is the
//! source of truth): a stub broker bound at the real endpoint checks the
//! handshake bytes, the raw byte pump and every exit path; then the shim runs
//! against the real broker, dist/mcp-bundle/broker.js, when it is built.
//!
//! Isolation: a throwaway home (short, under /tmp on Unix, for sun_path), a
//! random WMUX_DATA_SUFFIX and a cleared environment, so nothing here can
//! reach a live wmux.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_wmux-native");
const WAIT: Duration = Duration::from_secs(15);

fn unique() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    format!(
        "{:x}{:x}{:x}",
        std::process::id() & 0xffff,
        nanos & 0xfffff,
        N.fetch_add(1, Ordering::SeqCst)
    )
}

struct Sandbox {
    home: PathBuf,
    suffix: String,
}

impl Sandbox {
    fn new() -> Self {
        let base = if cfg!(windows) {
            std::env::temp_dir()
        } else {
            PathBuf::from("/tmp")
        };
        let tag = unique();
        let home = base.join(format!("wmsh-{tag}"));
        std::fs::create_dir(&home).expect("create sandbox home");
        Sandbox {
            home,
            suffix: format!("-t{tag}"),
        }
    }

    fn token_path(&self) -> PathBuf {
        self.home.join(format!(".wmux{}-auth-token", self.suffix))
    }

    fn write_token(&self, content: &str) {
        std::fs::write(self.token_path(), content).expect("write token");
    }

    fn pipe(&self) -> String {
        if cfg!(windows) {
            format!(r"\\.\pipe\wmux-mcpb{}-{}", self.suffix, stub::username())
        } else {
            format!("{}/.wmux-mcpb{}.sock", self.home.display(), self.suffix)
        }
    }

    /// A cleared environment pointing at this sandbox only.
    fn env(&self, c: &mut Command) {
        c.env_clear()
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("WMUX_DATA_SUFFIX", &self.suffix);
        for keep in ["PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP"] {
            if let Some(v) = std::env::var_os(keep) {
                c.env(keep, v);
            }
        }
    }

    fn shim(&self, args: &[&str]) -> Command {
        let mut c = Command::new(BIN);
        c.arg("mcp-shim").args(args);
        self.env(&mut c);
        c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        c
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.token_path());
        if cfg!(unix) {
            let _ = std::fs::remove_file(self.pipe());
        }
        let _ = std::fs::remove_dir(&self.home);
    }
}

#[cfg(unix)]
mod stub {
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::time::{Duration, Instant};

    pub type Conn = UnixStream;
    pub struct Listener(UnixListener);

    pub fn bind(pipe: &str) -> Listener {
        Listener(UnixListener::bind(pipe).expect("bind stub broker"))
    }

    impl Listener {
        pub fn accept(self, within: Duration) -> Conn {
            self.0.set_nonblocking(true).expect("nonblocking");
            let deadline = Instant::now() + within;
            loop {
                match self.0.accept() {
                    Ok((s, _)) => {
                        s.set_nonblocking(false).expect("blocking");
                        s.set_read_timeout(Some(super::WAIT)).expect("timeout");
                        return s;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("no shim connected: {e}"),
                }
            }
        }
    }

    pub fn username() -> String {
        unreachable!("only a Windows pipe name carries the user")
    }
}

#[cfg(windows)]
mod stub {
    use core::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    use std::time::Duration;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_size: u32,
            in_size: u32,
            timeout: u32,
            security: *mut c_void,
        ) -> *mut c_void;
        fn ConnectNamedPipe(pipe: *mut c_void, overlapped: *mut c_void) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetUserNameW(buffer: *mut u16, size: *mut u32) -> i32;
    }

    const PIPE_ACCESS_DUPLEX: u32 = 3;
    const ERROR_PIPE_CONNECTED: i32 = 535;

    /// A synchronous server end: the test drives it from one thread.
    pub type Conn = File;
    pub struct Listener(usize);

    pub fn bind(pipe: &str) -> Listener {
        let wide: Vec<u16> = pipe.encode_utf16().chain(Some(0)).collect();
        // SAFETY: `wide` is NUL-terminated; the handle is checked.
        let h = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                0,
                255,
                65536,
                65536,
                0,
                std::ptr::null_mut(),
            )
        };
        assert!(
            h as isize != -1,
            "bind stub broker: {}",
            std::io::Error::last_os_error()
        );
        Listener(h as usize)
    }

    impl Listener {
        pub fn accept(self, within: Duration) -> Conn {
            let h = self.0;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                // SAFETY: the handle is a live pipe instance owned by this test.
                let ok = unsafe { ConnectNamedPipe(h as *mut c_void, std::ptr::null_mut()) } != 0;
                let connected = ok || std::io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED);
                let _ = tx.send(connected);
            });
            assert_eq!(rx.recv_timeout(within).ok(), Some(true), "no shim connected");
            // SAFETY: the handle is owned from here on by the File.
            unsafe { File::from_raw_handle(h as *mut c_void) }
        }
    }

    pub fn username() -> String {
        let mut buf = [0u16; 257];
        let mut len = buf.len() as u32;
        // SAFETY: buf is valid for `len` units.
        let ok = unsafe { GetUserNameW(buf.as_mut_ptr(), &mut len) } != 0;
        let name = if ok && len > 0 {
            String::from_utf16_lossy(&buf[..len as usize - 1])
        } else {
            String::new()
        };
        if name.is_empty() {
            "default".into()
        } else {
            name
        }
    }
}

fn read_line(r: &mut impl Read) -> String {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while line.last() != Some(&b'\n') {
        match r.read(&mut byte) {
            Ok(1) => line.push(byte[0]),
            other => panic!("handshake cut short after {line:?}: {other:?}"),
        }
    }
    String::from_utf8(line).expect("utf-8 handshake")
}

fn read_exact(r: &mut impl Read, n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).expect("bytes from the shim");
    buf
}

/// A pipe drained on its own thread, so a misbehaving shim fails a test
/// instead of hanging it.
fn spawn_reader(mut r: impl Read + Send + 'static) -> Receiver<Vec<u8>> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = r.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    rx
}

fn recv_exact(rx: &Receiver<Vec<u8>>, n: usize) -> Vec<u8> {
    let deadline = Instant::now() + WAIT;
    let mut got = Vec::new();
    while got.len() < n {
        let left = deadline.saturating_duration_since(Instant::now());
        got.extend(rx.recv_timeout(left).expect("stdout from the shim"));
    }
    got
}

fn collect(r: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(r).read_to_string(&mut s);
        s
    })
}

fn wait_within(child: &mut Child, within: Duration) -> ExitStatus {
    let deadline = Instant::now() + within;
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("the shim did not exit within {within:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn expected_handshake(child: &Child, middle: &str) -> String {
    format!(
        "{{\"wmuxShim\":1,{},\"callerPid\":{},\"callerPpid\":{},{}}}\n",
        middle.split_once('|').unwrap().0,
        child.id(),
        std::process::id(),
        middle.split_once('|').unwrap().1
    )
}

#[test]
fn the_handshake_then_raw_bytes_both_ways_and_stdin_eof_exits_0() {
    let sb = Sandbox::new();
    // JS trim: the BOM and the line end go, the inner text stays.
    sb.write_token(" \u{feff}tok-π\r\n");
    let listener = stub::bind(&sb.pipe());
    let mut child = sb
        .shim(&["--core", "--role=a", "--port", "1", "--role=b"])
        .env("WMUX_WORKSPACE_ID", "ws-1")
        .env("WMUX_PTY_ID", "")
        .env("WMUX_AUTH_TOKEN", "not-this-one")
        .spawn()
        .expect("spawn shim");
    let err = collect(child.stderr.take().unwrap());
    let out = spawn_reader(child.stdout.take().unwrap());
    let mut conn = listener.accept(WAIT);
    assert_eq!(
        read_line(&mut conn),
        expected_handshake(
            &child,
            "\"authToken\":\"tok-π\"|\"envWorkspaceHint\":\"ws-1\",\"envPtyHint\":\"\",\
             \"commanderMode\":false,\"coreMode\":true,\"roleSurface\":\"b\""
        )
    );

    // No framing: a partial line and non-UTF-8 bytes pass through untouched.
    let mut stdin = child.stdin.take().unwrap();
    let up = b"{\"jsonrpc\":\"2.0\"\x00\xff partial";
    stdin.write_all(up).unwrap();
    stdin.flush().unwrap();
    assert_eq!(read_exact(&mut conn, up.len()), up);
    let down = b"\xfe\x00down\n no newline yet";
    conn.write_all(down).unwrap();
    assert_eq!(recv_exact(&out, down.len()), down);

    drop(stdin);
    assert_eq!(wait_within(&mut child, WAIT).code(), Some(0));
    // The half-close reached the broker as an end of stream.
    let mut rest = Vec::new();
    conn.read_to_end(&mut rest).expect("end of stream");
    assert!(rest.is_empty());
    assert_eq!(err.join().unwrap(), "");
}

#[test]
fn a_set_commander_token_is_sent_even_empty_and_the_env_token_backs_a_blank_file() {
    let sb = Sandbox::new();
    sb.write_token(" \n\t");
    let listener = stub::bind(&sb.pipe());
    let mut child = sb
        .shim(&["--commander", "--role="])
        .env("WMUX_AUTH_TOKEN", " env\"tok\u{1} ")
        .env("WMUX_COMMANDER_TOKEN", "")
        .env("WMUX_PTY_ID", "pty-9")
        .spawn()
        .expect("spawn shim");
    let err = collect(child.stderr.take().unwrap());
    let mut conn = listener.accept(WAIT);
    assert_eq!(
        read_line(&mut conn),
        expected_handshake(
            &child,
            "\"authToken\":\" env\\\"tok\\u0001 \"|\"envWorkspaceHint\":\"\",\"envPtyHint\":\"pty-9\",\
             \"commanderToken\":\"\",\"commanderMode\":true,\"coreMode\":false,\"roleSurface\":\"\""
        )
    );
    // The broker drops the session: the shim exits 1, stdout untouched.
    drop(conn);
    assert_eq!(wait_within(&mut child, WAIT).code(), Some(1));
    assert_eq!(err.join().unwrap(), "[wmux-mcp-shim] broker connection closed\n");
    let mut stdout = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut stdout).unwrap();
    assert!(stdout.is_empty());
}

#[test]
fn no_token_exits_1_without_dialling() {
    let sb = Sandbox::new();
    let started = Instant::now();
    let out = sb.shim(&[]).stdin(Stdio::null()).output().expect("run shim");
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "[wmux-mcp-shim] auth token not found. Is wmux running?\n"
    );
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

#[test]
fn an_unreachable_broker_exits_1_after_ten_tries() {
    let sb = Sandbox::new();
    sb.write_token("tok");
    let started = Instant::now();
    let out = sb.shim(&[]).stdin(Stdio::null()).output().expect("run shim");
    let elapsed = started.elapsed();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    // The last error as node words err.message: `connect <code> <pipe>`.
    let pipe = sb.pipe();
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        format!("[wmux-mcp-shim] cannot reach broker at {pipe}: connect ENOENT {pipe}\n")
    );
    // Ten tries, 300 ms apart.
    assert!(elapsed >= Duration::from_millis(2900), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
}

#[test]
fn a_broker_that_comes_up_during_the_retries_is_reached() {
    let sb = Sandbox::new();
    sb.write_token("tok");
    let mut child = sb.shim(&[]).spawn().expect("spawn shim");
    std::thread::sleep(Duration::from_millis(1000));
    let mut conn = stub::bind(&sb.pipe()).accept(WAIT);
    assert!(read_line(&mut conn).starts_with("{\"wmuxShim\":1,\"authToken\":\"tok\","));
    drop(child.stdin.take());
    assert_eq!(wait_within(&mut child, WAIT).code(), Some(0));
}

#[test]
fn a_host_that_stops_reading_stdout_ends_the_session_with_0() {
    let sb = Sandbox::new();
    sb.write_token("tok");
    let listener = stub::bind(&sb.pipe());
    let mut child = sb.shim(&[]).spawn().expect("spawn shim");
    let err = collect(child.stderr.take().unwrap());
    drop(child.stdout.take());
    let mut conn = listener.accept(WAIT);
    read_line(&mut conn);
    // stdin stays open, so only the stdout failure can end the session.
    let deadline = Instant::now() + WAIT;
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        if conn.write_all(b"{\"jsonrpc\":\"2.0\"}\n").is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(wait_within(&mut child, WAIT).code(), Some(0));
    assert_eq!(err.join().unwrap(), "");
}

#[cfg(unix)]
#[test]
fn sigterm_and_sigint_exit_0() {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    for sig in [15, 2] {
        let sb = Sandbox::new();
        sb.write_token("tok");
        let listener = stub::bind(&sb.pipe());
        let mut child = sb.shim(&[]).spawn().expect("spawn shim");
        let mut conn = listener.accept(WAIT);
        read_line(&mut conn);
        // SAFETY: signals a child this test spawned and still owns.
        assert_eq!(unsafe { kill(child.id() as i32, sig) }, 0);
        assert_eq!(wait_within(&mut child, WAIT).code(), Some(0), "signal {sig}");
    }
}

#[test]
fn a_broken_stderr_still_ends_a_dropped_session_with_1() {
    let sb = Sandbox::new();
    sb.write_token("tok");
    let listener = stub::bind(&sb.pipe());
    let mut child = sb.shim(&[]).spawn().expect("spawn shim");
    // The diagnostic write fails with EPIPE; the exit must not depend on it.
    drop(child.stderr.take());
    let mut conn = listener.accept(WAIT);
    read_line(&mut conn);
    drop(conn);
    assert_eq!(wait_within(&mut child, WAIT).code(), Some(1));
}

/// Before the handshake is written the shim keeps the default disposition, so
/// a signal kills it, as it does the Node shim (its handlers come later).
#[cfg(unix)]
#[test]
fn a_signal_during_the_connect_retries_kills_by_the_signal() {
    use std::os::unix::process::ExitStatusExt;
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let sb = Sandbox::new();
    sb.write_token("tok");
    let mut child = sb.shim(&[]).spawn().expect("spawn shim");
    std::thread::sleep(Duration::from_millis(500));
    // SAFETY: signals a child this test spawned and still owns.
    assert_eq!(unsafe { kill(child.id() as i32, 15) }, 0);
    let status = wait_within(&mut child, WAIT);
    assert_eq!((status.code(), status.signal()), (None, Some(15)));
}

/// A host may hand over non-blocking pipes. EAGAIN on either one is a wait,
/// not the end of the session.
#[cfg(unix)]
#[test]
fn a_non_blocking_stdin_and_stdout_are_waited_on() {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    let sb = Sandbox::new();
    sb.write_token("tok");
    let listener = stub::bind(&sb.pipe());
    let (mut host_in, shim_in) = UnixStream::pair().unwrap();
    let (mut host_out, shim_out) = UnixStream::pair().unwrap();
    shim_in.set_nonblocking(true).unwrap();
    shim_out.set_nonblocking(true).unwrap();
    let mut child = sb
        .shim(&[])
        .stdin(Stdio::from(OwnedFd::from(shim_in)))
        .stdout(Stdio::from(OwnedFd::from(shim_out)))
        .spawn()
        .expect("spawn shim");
    let mut conn = listener.accept(WAIT);
    read_line(&mut conn);
    // Nothing to read yet: the shim's stdin read sees EAGAIN.
    std::thread::sleep(Duration::from_millis(300));
    assert!(child.try_wait().unwrap().is_none(), "EAGAIN on stdin ended the session");
    host_in.write_all(b"up\n").unwrap();
    assert_eq!(read_exact(&mut conn, 3), b"up\n");

    // Far more than the socket buffers hold while the host is not reading:
    // the shim's stdout write sees EAGAIN.
    let big: Vec<u8> = (0..1u32 << 20).map(|i| (i % 251) as u8).collect();
    let mut writer = conn.try_clone().unwrap();
    let sent = big.clone();
    let feeder = std::thread::spawn(move || writer.write_all(&sent));
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        child.try_wait().unwrap().is_none(),
        "EAGAIN on stdout ended the session"
    );
    host_out.set_read_timeout(Some(WAIT)).unwrap();
    assert_eq!(read_exact(&mut host_out, big.len()), big);
    feeder.join().unwrap().unwrap();

    drop(host_in);
    assert_eq!(wait_within(&mut child, WAIT).code(), Some(0));
}

#[test]
fn self_test_prints_the_protocol_version_without_a_network() {
    let sb = Sandbox::new();
    let out = sb
        .shim(&["--self-test"])
        .stdin(Stdio::null())
        .output()
        .expect("run shim");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "wmux-mcp-shim protocol 1\n");
    assert!(out.stderr.is_empty());
}

// ----- the real broker -------------------------------------------------------

/// Kills the broker on every exit path of the test.
struct Owned(Child);

impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn lines(r: impl Read + Send + 'static) -> Receiver<String> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(r).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

fn recv_line_with(rx: &Receiver<String>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) if line.contains(needle) => return line,
            Ok(_) => {}
            Err(e) => panic!("no line with {needle:?}: {e}"),
        }
    }
}

/// The built broker bundle, or why the end-to-end test cannot run.
fn broker_bundle() -> Result<PathBuf, String> {
    let path = std::env::var_os("WMUX_BROKER_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("dist")
                .join("mcp-bundle")
                .join("broker.js")
        });
    if !path.is_file() {
        return Err(format!("{} is not built (npm run build:mcp)", path.display()));
    }
    match Command::new("node").arg("--version").output() {
        Ok(o) if o.status.success() => Ok(path),
        _ => Err("node is not on PATH".into()),
    }
}

#[test]
fn against_the_real_broker_initialize_list_call_then_a_broker_kill_exits_1() {
    let bundle = match broker_bundle() {
        Ok(p) => p,
        Err(why) if std::env::var_os("WMUX_REQUIRE_BROKER_E2E").is_some() => panic!("{why}"),
        Err(why) => {
            eprintln!("skipped: {why}");
            return;
        }
    };
    let sb = Sandbox::new();
    sb.write_token("e2e-token\n");
    let mut node = Command::new("node");
    node.arg(&bundle);
    sb.env(&mut node);
    let mut broker = Owned(
        node.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn broker"),
    );
    let broker_log = lines(broker.0.stderr.take().unwrap());
    recv_line_with(&broker_log, "listening on");

    let mut shim = sb.shim(&[]).spawn().expect("spawn shim");
    let err = collect(shim.stderr.take().unwrap());
    let out = lines(shim.stdout.take().unwrap());
    let mut stdin = shim.stdin.take().unwrap();
    let mut send = |msg: &str| {
        stdin.write_all(msg.as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    };
    send(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"native-shim-e2e","version":"0"}}}"#,
    );
    assert!(recv_line_with(&out, r#""id":1"#).contains(r#""serverInfo""#));
    send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    send(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
    assert!(recv_line_with(&out, r#""id":2"#).contains(r#""name":"workspace_list""#));
    // No app runs in the sandbox, so the tool answers with its own error result.
    send(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workspace_list","arguments":{}}}"#);
    assert!(recv_line_with(&out, r#""id":3"#).contains(r#""result""#));
    recv_line_with(&broker_log, "shim connected");

    broker.0.kill().expect("kill broker");
    let _ = broker.0.wait();
    assert_eq!(wait_within(&mut shim, WAIT).code(), Some(1));
    let err = err.join().unwrap();
    assert!(err.starts_with("[wmux-mcp-shim] broker connection "), "{err}");
}
