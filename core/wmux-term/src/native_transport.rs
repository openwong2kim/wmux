//! Event-driven PTY transport. Blocking OS reads/writes never run on Node.
use crate::native_output::{NativeOutputChunk, NativeOutputDecoder};
use crate::wake_gate::WakeGate;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
#[cfg(unix)]
use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
#[cfg(windows)]
use portable_pty::{ChildKiller, PtySystem};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    unix::net::UnixStream,
};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc::{sync_channel, Receiver, TryRecvError},
    Arc, Condvar, Mutex,
};

/// The JS wake callback. Every worker shares one single-slot queue, so the
/// gate allows one queued call at a time; see `wake_gate` for why no wake
/// is lost.
struct Wake {
    callback: ThreadsafeFunction<(), (), (), napi::Status, false, false, 1>,
    gate: Arc<WakeGate>,
}
impl Wake {
    fn notify(&self) {
        if !self.gate.arm() {
            return;
        }
        match self
            .callback
            .call((), ThreadsafeFunctionCallMode::NonBlocking)
        {
            // Closing never dispatches again; staying armed stops more calls.
            napi::Status::Ok | napi::Status::Closing => {}
            _ => self.gate.disarm(),
        }
    }
}
const INPUT_LIMIT: usize = 8 * 1024 * 1024;
static ACTIVE_WORKERS: AtomicU32 = AtomicU32::new(0);
struct Worker;
impl Worker {
    fn enter() -> Self {
        ACTIVE_WORKERS.fetch_add(1, Ordering::AcqRel);
        Self
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        ACTIVE_WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}
#[napi]
pub fn native_transport_worker_count() -> u32 {
    ACTIVE_WORKERS.load(Ordering::Acquire)
}
#[derive(Default)]
struct Input {
    queue: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}
#[derive(Clone)]
struct Exit {
    code: u32,
    signal: Option<u32>,
}
struct State {
    input: Mutex<Input>,
    ready: Condvar,
    exited: Mutex<Option<Exit>>,
    error: Mutex<Option<String>>,
    closed: AtomicBool,
    #[cfg(unix)]
    cancel: Mutex<Option<UnixStream>>,
}
impl State {
    fn fail(&self, message: String, wake: &Wake) {
        *self.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(message);
        wake.notify();
    }
}

#[napi(object)]
pub struct TransportRead {
    pub data: Buffer,
    pub eof: bool,
    pub exit_code: Option<u32>,
    pub signal: Option<u32>,
    pub error: Option<String>,
    pub pending_input_bytes: u32,
    pub child_exited: bool,
}

struct RawTransportRead {
    pub data: Vec<u8>,
    pub eof: bool,
    pub exit_code: Option<u32>,
    pub signal: Option<u32>,
    pub error: Option<String>,
    pub pending_input_bytes: u32,
    pub child_exited: bool,
}

#[napi(object, object_from_js = false)]
pub struct TransportChunkRead {
    pub chunk: NativeOutputChunk,
    pub bytes_read: u32,
    pub eof: bool,
    pub exit_code: Option<u32>,
    pub signal: Option<u32>,
    pub error: Option<String>,
    pub pending_input_bytes: u32,
    pub child_exited: bool,
}

#[napi]
pub struct NativeTransport {
    master: Option<Box<dyn MasterPty + Send>>,
    #[cfg(windows)]
    killer: Option<Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>>,
    receiver: Option<Receiver<Vec<u8>>>,
    state: Arc<State>,
    pid: u32,
    eof: bool,
    decoder: NativeOutputDecoder,
}

#[napi]
impl NativeTransport {
    #[napi(constructor)]
    pub fn new(
        command: String,
        args: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        cols: u32,
        rows: u32,
        notify: Function<(), ()>,
        conpty_dll: Option<String>,
        parent_window: Option<Uint8Array>,
    ) -> Result<Self> {
        let size = size(cols, rows)?;
        let gate = Arc::new(WakeGate::default());
        let dispatched = gate.clone();
        let wake = Arc::new(Wake {
            callback: notify
                .build_threadsafe_function::<()>()
                .callee_handled::<false>()
                .weak::<false>()
                .max_queue_size::<1>()
                // Runs on Node before `notify`, so its drain sees all data.
                .build_callback(move |_| {
                    dispatched.disarm();
                    Ok(())
                })?,
            gate,
        });
        #[cfg(unix)]
        let pair = {
            let _ = (conpty_dll, parent_window);
            native_pty_system().openpty(size).map_err(error)?
        };
        #[cfg(windows)]
        let pair = portable_pty::win::conpty::ConPtySystem {
            dll_path: conpty_dll.map(Into::into),
        }
        .openpty(size)
        .map_err(error)?;
        // Before the shell starts, so a window it opens right away already has an owner.
        #[cfg(windows)]
        if let Some(hwnd) = parent_window.as_deref().and_then(native_window_handle) {
            pair.master.set_parent_window(hwnd);
        }
        #[cfg(unix)]
        let (unix_io, cancel) = UnixIo::new(
            pair.master
                .as_raw_fd()
                .ok_or_else(|| Error::from_reason("PTY has no file descriptor"))?,
        )
        .map_err(error)?;
        let mut reader = pair.master.try_clone_reader().map_err(error)?;
        let mut writer = pair.master.take_writer().map_err(error)?;
        let mut command_builder = CommandBuilder::new(command);
        command_builder.args(args);
        command_builder.cwd(cwd);
        command_builder.env_clear();
        for (key, value) in env {
            command_builder.env(key, value);
        }
        let state = Arc::new(State {
            input: Mutex::new(Input::default()),
            ready: Condvar::new(),
            exited: Mutex::new(None),
            error: Mutex::new(None),
            closed: AtomicBool::new(false),
            #[cfg(unix)]
            cancel: Mutex::new(Some(cancel)),
        });
        let (tx, rx) = sync_channel::<Vec<u8>>(16);
        let mut result = Self {
            master: Some(pair.master),
            #[cfg(windows)]
            killer: None,
            receiver: Some(rx),
            state: state.clone(),
            pid: 0,
            eof: false,
            decoder: NativeOutputDecoder::default(),
        };
        let reader_state = state.clone();
        let reader_wake = wake.clone();
        #[cfg(unix)]
        let reader_io = unix_io.clone();
        let reader_start = std::thread::Builder::new()
            .name("wmux-pty-reader".into())
            .spawn(move || {
                let _worker = Worker::enter();
                let mut bytes = [0; 16 * 1024];
                loop {
                    #[cfg(unix)]
                    if reader_state.closed.load(Ordering::Acquire) {
                        break;
                    }
                    match reader.read(&mut bytes) {
                        Ok(0) => break,
                        Ok(n) => {
                            // Older ConPTY versions block ClosePseudoConsole
                            // until their output is drained. After disposal,
                            // discard bytes until EOF instead of abandoning
                            // the pipe while the close worker is using it.
                            #[cfg(windows)]
                            if reader_state.closed.load(Ordering::Acquire) {
                                continue;
                            }
                            if tx.send(bytes[..n].to_vec()).is_err() {
                                #[cfg(windows)]
                                continue;
                                #[cfg(unix)]
                                break;
                            }
                            reader_wake.notify();
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        #[cfg(unix)]
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            if let Err(e) = reader_io.wait(libc::POLLIN, -1) {
                                if !reader_state.closed.load(Ordering::Acquire) {
                                    reader_state.fail(e.to_string(), &reader_wake);
                                }
                                break;
                            }
                        }
                        // Unix PTYs may signal slave closure with EIO.
                        Err(e) if cfg!(unix) && e.raw_os_error() == Some(5) => break,
                        Err(e) => {
                            reader_state.fail(e.to_string(), &reader_wake);
                            break;
                        }
                    }
                }
                drop(tx);
                reader_wake.notify();
            });
        if let Err(e) = reader_start {
            result.close();
            return Err(error(e));
        }
        let writer_state = state.clone();
        let writer_wake = wake.clone();
        let writer_start = std::thread::Builder::new()
            .name("wmux-pty-writer".into())
            .spawn(move || {
                let _worker = Worker::enter();
                loop {
                    let data = {
                        let mut input =
                            writer_state.input.lock().unwrap_or_else(|p| p.into_inner());
                        while input.queue.is_empty() && !input.closed {
                            input = writer_state
                                .ready
                                .wait(input)
                                .unwrap_or_else(|p| p.into_inner());
                        }
                        if input.closed {
                            break;
                        }
                        input.queue.pop_front().unwrap()
                    };
                    #[cfg(unix)]
                    let written =
                        write_cancellable(writer.as_mut(), &data, &writer_state, &unix_io);
                    #[cfg(windows)]
                    let written = writer.write_all(&data);
                    let mut input = writer_state.input.lock().unwrap_or_else(|p| p.into_inner());
                    input.bytes = input.bytes.saturating_sub(data.len());
                    drop(input);
                    writer_wake.notify();
                    if let Err(e) = written {
                        let mut input =
                            writer_state.input.lock().unwrap_or_else(|p| p.into_inner());
                        input.closed = true;
                        input.queue.clear();
                        input.bytes = 0;
                        drop(input);
                        // A write interrupted by our own close or an already
                        // observed child exit is expected, not a transport fault.
                        if !writer_state.closed.load(Ordering::Acquire)
                            && writer_state
                                .exited
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .is_none()
                        {
                            writer_state.fail(e.to_string(), &writer_wake);
                        }
                        break;
                    }
                }
            });
        if let Err(e) = writer_start {
            result.close();
            return Err(error(e));
        }
        // Own the wait independently of the killer: a blocked wait cannot lock
        // out termination. Exit is delivered only after the output queue drains.
        let (child_tx, child_rx) = sync_channel::<Box<dyn Child + Send + Sync>>(1);
        let waiter_state = state.clone();
        let wait_start = std::thread::Builder::new()
            .name("wmux-pty-wait".into())
            .spawn(move || {
                let _worker = Worker::enter();
                let Ok(mut child) = child_rx.recv() else {
                    return;
                };
                // Keep the exited Unix child unreaped until signal delivery is
                // excluded. Otherwise its PID can be reused before exited is set.
                #[cfg(unix)]
                let observed = observe_exit(child.process_id().unwrap() as i32);
                #[cfg(unix)]
                let mut exit_guard = waiter_state
                    .exited
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                #[cfg(unix)]
                if observed.is_ok() {
                    signal_session(child.process_id().unwrap() as i32, libc::SIGKILL);
                }
                let status = child.wait();
                #[cfg(windows)]
                let mut exit_guard = waiter_state
                    .exited
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                match status {
                    Ok(status) => {
                        *exit_guard = Some(Exit {
                            // node-pty reports WEXITSTATUS (zero) plus the signal
                            // for a signal exit; portable-pty otherwise uses 1.
                            code: if status.signal().is_some() {
                                0
                            } else {
                                status.exit_code()
                            },
                            signal: signal_number(status.signal()),
                        });
                    }
                    Err(e) => {
                        // A failed wait may mean another reaper already consumed
                        // the child. Do not signal a potentially reused Unix PID.
                        *exit_guard = Some(Exit {
                            code: 1,
                            signal: None,
                        });
                        waiter_state.fail(e.to_string(), &wake);
                    }
                }
                drop(exit_guard);
                let mut input = waiter_state.input.lock().unwrap_or_else(|p| p.into_inner());
                input.closed = true;
                input.queue.clear();
                input.bytes = 0;
                drop(input);
                waiter_state.ready.notify_all();
                wake.notify();
            });
        if let Err(e) = wait_start {
            result.close();
            return Err(error(e));
        }
        // Thread/resource failures happen before the command can have effects.
        // Drop closes the waiting workers if spawning fails.
        let child = pair.slave.spawn_command(command_builder).map_err(error)?;
        result.pid = child
            .process_id()
            .expect("spawned PTY child has a process id");
        #[cfg(windows)]
        {
            result.killer = Some(Arc::new(Mutex::new(child.clone_killer())));
        }
        // The receiver cannot exit before receiving the child.
        if let Err(e) = child_tx.send(child) {
            let mut child = e.0;
            let _ = child.kill();
            return Err(Error::from_reason("PTY waiter unavailable"));
        }
        drop(pair.slave);
        Ok(result)
    }

    #[napi(getter)]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    #[napi]
    pub fn read(&mut self, paused: Option<bool>) -> TransportRead {
        let result = self.drain(paused);
        TransportRead {
            data: result.data.into(),
            eof: result.eof,
            child_exited: result.child_exited,
            exit_code: result.exit_code,
            signal: result.signal,
            error: result.error,
            pending_input_bytes: result.pending_input_bytes,
        }
    }

    #[napi]
    pub fn read_chunk(&mut self, paused: Option<bool>) -> TransportChunkRead {
        let result = self.drain(paused);
        let bytes_read = result.data.len() as u32;
        TransportChunkRead {
            chunk: self.decoder.decode(result.data, result.exit_code.is_some()),
            bytes_read,
            eof: result.eof,
            child_exited: result.child_exited,
            exit_code: result.exit_code,
            signal: result.signal,
            error: result.error,
            pending_input_bytes: result.pending_input_bytes,
        }
    }

    #[napi(getter)]
    pub fn pending_input_bytes(&self) -> u32 {
        self.state
            .input
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .bytes as u32
    }

    #[napi]
    pub fn write(&self, data: Uint8Array) -> Result<()> {
        let mut input = self.state.input.lock().map_err(error)?;
        if input.closed {
            return Err(Error::from_reason("PTY_CLOSED"));
        }
        if input.bytes + data.len() > INPUT_LIMIT {
            return Err(Error::from_reason("PTY_BACKPRESSURE: input queue is full"));
        }
        if !data.is_empty() {
            input.bytes += data.len();
            input.queue.push_back(data.to_vec());
            self.state.ready.notify_one();
        }
        Ok(())
    }

    #[napi]
    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.master
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY_CLOSED"))?
            .resize(size(cols, rows)?)
            .map_err(error)
    }

    #[napi]
    pub fn clear(&self) {
        if let Some(master) = &self.master {
            master.clear();
        }
    }

    /// Make a top-level window the owner of the pane's console window (Windows, the
    /// bundled conpty.dll only), so a window a console program parents to it, such as
    /// a sign-in prompt, opens above that window. `handle` is the HWND's bytes in native
    /// byte order, as BrowserWindow.getNativeWindowHandle() returns it. Returns whether
    /// the request reached ConPTY, which applies it asynchronously; false for a handle
    /// of the wrong size or a NULL one, a closed PTY, or a ConPTY without the call.
    #[napi]
    pub fn set_parent_window(&self, handle: Uint8Array) -> bool {
        let Some(hwnd) = native_window_handle(&handle[..]) else {
            return false;
        };
        self.master
            .as_ref()
            .is_some_and(|master| master.set_parent_window(hwnd))
    }

    #[napi]
    pub fn kill(&self, signal: Option<u32>) -> Result<()> {
        let exited = self.state.exited.lock().map_err(error)?;
        if exited.is_some() || self.pid == 0 {
            return Ok(());
        }
        #[cfg(unix)]
        {
            let signal = signal.unwrap_or(libc::SIGHUP as u32) as i32;
            if !(1..=64).contains(&signal) {
                return Err(Error::from_reason("Invalid signal"));
            }
            if signal == libc::SIGKILL {
                signal_session(self.pid as i32, signal);
            }
            if let Some(group) = self.master.as_ref().and_then(|m| m.process_group_leader()) {
                if group > 0 {
                    unsafe {
                        libc::kill(-group, signal);
                    }
                }
            }
            if unsafe { libc::kill(self.pid as i32, signal) } != 0 {
                let e = std::io::Error::last_os_error();
                if e.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error(e));
                }
            }
            Ok(())
        }
        #[cfg(windows)]
        {
            if signal.is_some() {
                return Err(Error::from_reason("Signals are unsupported on Windows"));
            }
            if let Some(killer) = &self.killer {
                killer.lock().map_err(error)?.kill().map_err(error)
            } else {
                Ok(())
            }
        }
    }

    #[napi]
    pub fn close(&mut self) {
        if self.state.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(unix)]
        {
            self.state
                .cancel
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
        }
        #[cfg(unix)]
        {
            let _ = self.kill(Some(libc::SIGKILL as u32));
        }
        #[cfg(windows)]
        let killer = self.killer.take();
        let master = self.master.take();
        self.receiver.take();
        let mut input = self.state.input.lock().unwrap_or_else(|p| p.into_inner());
        input.closed = true;
        input.queue.clear();
        input.bytes = 0;
        drop(input);
        self.state.ready.notify_all();
        // ClosePseudoConsole can wait on Windows: release it off Node.
        std::thread::spawn(move || {
            let _worker = Worker::enter();
            #[cfg(windows)]
            {
                if let Some(killer) = killer {
                    let _ = killer.lock().map(|mut k| k.kill());
                }
            }
            drop(master);
        });
    }
}
impl NativeTransport {
    fn drain(&mut self, paused: Option<bool>) -> RawTransportRead {
        let mut bytes = Vec::new();
        if let Some(rx) = &self.receiver {
            if !paused.unwrap_or(false) {
                for _ in 0..16 {
                    match rx.try_recv() {
                        Ok(data) => bytes.extend(data),
                        Err(TryRecvError::Disconnected) => {
                            self.eof = true;
                            break;
                        }
                        Err(TryRecvError::Empty) => break,
                    }
                }
            }
        }
        let exit = self
            .state
            .exited
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        // Inbox ConPTY may keep stdout open until ClosePseudoConsole. Its
        // blocking final drain belongs off Node while the reader keeps draining.
        #[cfg(windows)]
        if exit.is_some() {
            if let Some(master) = self.master.take() {
                let killer = self.killer.clone();
                std::thread::spawn(move || {
                    let _worker = Worker::enter();
                    if let Some(killer) = killer {
                        let _ = killer.lock().map(|mut k| k.kill());
                    }
                    drop(master);
                });
            }
        }
        RawTransportRead {
            data: bytes,
            eof: self.eof,
            child_exited: exit.is_some(),
            exit_code: if self.eof {
                exit.as_ref().map(|e| e.code)
            } else {
                None
            },
            signal: if self.eof {
                exit.and_then(|e| e.signal)
            } else {
                None
            },
            error: self
                .state
                .error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take(),
            pending_input_bytes: self
                .state
                .input
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .bytes as u32,
        }
    }
}
impl Drop for NativeTransport {
    fn drop(&mut self) {
        self.close();
    }
}
fn error(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}
fn size(cols: u32, rows: u32) -> Result<PtySize> {
    if cols == 0 || rows == 0 || cols > 32767 || rows > 32767 {
        return Err(Error::from_reason("Invalid PTY dimensions"));
    }
    Ok(PtySize {
        cols: cols as u16,
        rows: rows as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}
/// An HWND from its bytes in native byte order, as BrowserWindow.getNativeWindowHandle()
/// returns it; None for a handle of the wrong size or a NULL one, which never reaches
/// ConPTY (Windows drops a destroyed owner window by itself).
fn native_window_handle(handle: &[u8]) -> Option<isize> {
    <[u8; std::mem::size_of::<isize>()]>::try_from(handle)
        .ok()
        .map(isize::from_ne_bytes)
        .filter(|&hwnd| hwnd != 0)
}
fn signal_number(signal: Option<&str>) -> Option<u32> {
    #[cfg(unix)]
    if let Some(name) = signal {
        for n in 1..=64 {
            let ptr = unsafe { libc::strsignal(n) };
            if !ptr.is_null() && unsafe { std::ffi::CStr::from_ptr(ptr) }.to_string_lossy() == name
            {
                return Some(n as u32);
            }
        }
    }
    #[cfg(windows)]
    let _ = signal;
    None
}

#[cfg(unix)]
fn observe_exit(pid: i32) -> std::io::Result<()> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        } == 0
        {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// portable-pty creates a fresh Unix session. Only processes still in that
/// owned session are terminated; detached services with a new SID are separate.
/// The root PID is not reaped until this scan finishes, so its SID cannot be reused.
#[cfg(unix)]
fn signal_session(session: i32, signal: i32) {
    if session <= 0 {
        return;
    }
    #[cfg(target_os = "linux")]
    let pids: Vec<i32> = std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    #[cfg(target_os = "macos")]
    let pids = {
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return;
        }
        let mut values = vec![0i32; count as usize + 128];
        let count = unsafe {
            libc::proc_listallpids(values.as_mut_ptr().cast(), (values.len() * 4) as i32)
        };
        values.truncate((count.max(0) as usize).min(values.len()));
        values
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let pids = Vec::<i32>::new();
    for pid in pids {
        if pid > 0 && pid != session && unsafe { libc::getsid(pid) } == session {
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
}

/// Nonblocking Unix I/O plus an owned cancellation socket. The extra PTY fd
/// keeps poll's descriptor valid until both workers stop; it cannot be reused
/// underneath a poll when the JS-facing master is dropped.
#[cfg(unix)]
struct UnixIo {
    pty: OwnedFd,
    cancel: UnixStream,
}
#[cfg(unix)]
impl UnixIo {
    fn new(fd: i32) -> std::io::Result<(Arc<Self>, UnixStream)> {
        let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if copy < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let pty = unsafe { OwnedFd::from_raw_fd(copy) };
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let (cancel, signal) = UnixStream::pair()?;
        Ok((Arc::new(Self { pty, cancel }), signal))
    }
    fn wait(&self, events: i16, timeout: i32) -> std::io::Result<()> {
        let mut fds = [
            libc::pollfd {
                fd: self.pty.as_raw_fd(),
                events,
                revents: 0,
            },
            libc::pollfd {
                fd: self.cancel.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        loop {
            if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) } >= 0 {
                if fds[1].revents != 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "PTY_CLOSED",
                    ));
                }
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}
#[cfg(unix)]
fn write_cancellable(
    writer: &mut dyn Write,
    mut bytes: &[u8],
    state: &State,
    io: &UnixIo,
) -> std::io::Result<()> {
    while !bytes.is_empty() {
        if state.closed.load(Ordering::Acquire)
            || state.input.lock().unwrap_or_else(|p| p.into_inner()).closed
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "PTY_CLOSED",
            ));
        }
        match writer.write(&bytes[..bytes.len().min(16 * 1024)]) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => bytes = &bytes[n..],
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            // A bounded wait also observes child exit before JS calls close.
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => io.wait(libc::POLLOUT, 100)?,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
