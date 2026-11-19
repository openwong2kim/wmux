//! Event-driven PTY transport. Blocking OS reads/writes never run on Node.
use crate::fallible;
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
    mpsc::{sync_channel, Receiver, SyncSender, TryRecvError},
    Arc, Condvar, Mutex,
};
#[cfg(unix)]
use std::time::{Duration, Instant};

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
/// How long a closed pane's processes have between the hangup (the caller's
/// SIGHUP, then the master's close) and the SIGKILL of whatever is still in
/// the pane's session. The same 5 s AGENT_STOP_GRACE_MS (src/daemon/agentStop.ts)
/// gives an agent to close its MCP servers and exit before it is killed: time
/// to save a transcript and release locks. The threads that keep it die with
/// the process, so a daemon that exits sooner leaves the rest to the hangup,
/// as node-pty always does and as #2398 decided for a clean exit.
#[cfg(unix)]
const HANGUP_GRACE: Duration = Duration::from_secs(5);
/// node-pty's DESTROY_SOCKET_TIMEOUT_MS: once the shell has exited, how long
/// the output may stay open before the exit is reported without its end. A
/// background job left holding the terminal keeps it open for good on Linux.
/// One budget waits for the end; a second bounds a job that never stops writing.
#[cfg(unix)]
const EXIT_OUTPUT_GRACE: Duration = Duration::from_millis(200);
/// How often the waiter looks again at a root that is stopped, or whose exit
/// it cannot watch: it holds no lock meanwhile. A root that stays stopped is
/// looked at less and less often, down to EXIT_POLL_MAX.
#[cfg(unix)]
const EXIT_POLL: Duration = Duration::from_millis(25);
#[cfg(unix)]
const EXIT_POLL_MAX: Duration = Duration::from_millis(250);
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
#[napi(catch_unwind)]
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
    /// The session sweep, armed by the hangup (kill() or close()) while the
    /// child is unreaped. Taken under `exited` (see the waiter).
    #[cfg(unix)]
    sweep: Mutex<Sweep>,
    /// The reader stops once no output is pending, without reporting an error.
    #[cfg(unix)]
    stop_reading: AtomicBool,
    #[cfg(unix)]
    reader_done: AtomicBool,
}
impl State {
    fn new() -> Self {
        Self {
            input: Mutex::new(Input::default()),
            ready: Condvar::new(),
            exited: Mutex::new(None),
            error: Mutex::new(None),
            closed: AtomicBool::new(false),
            #[cfg(unix)]
            cancel: Mutex::new(None),
            #[cfg(unix)]
            sweep: Mutex::new(Sweep::None),
            #[cfg(unix)]
            stop_reading: AtomicBool::new(false),
            #[cfg(unix)]
            reader_done: AtomicBool::new(false),
        }
    }
    /// The error the next read reports.
    fn record(&self, message: String) {
        *self.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(message);
    }
    fn fail(&self, message: String, wake: &Wake) {
        self.record(message);
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
    /// Reads not returned yet, oldest first: a read chunk a refused join
    /// could not add to a batch, and a batch a refused decode handed back.
    /// At most two (take_output empties it before receiving more), so its
    /// fixed capacity of 2 is never outgrown.
    carry: VecDeque<Vec<u8>>,
}

/// The reader's buffer: one read copies at most this many bytes.
const READ_BYTES: usize = 16 * 1024;
/// The most reads one drain joins: a batch is at most 16 x READ_BYTES (256 KiB).
const DRAIN_READS: usize = 16;

#[napi]
impl NativeTransport {
    #[napi(constructor, catch_unwind)]
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
        #[cfg_attr(windows, allow(unused_mut))]
        let mut state = State::new();
        #[cfg(unix)]
        {
            state.cancel = Mutex::new(Some(cancel));
        }
        let state = Arc::new(state);
        let (tx, rx) = sync_channel::<Vec<u8>>(DRAIN_READS);
        let mut result = Self {
            master: Some(pair.master),
            #[cfg(windows)]
            killer: None,
            receiver: Some(rx),
            state: state.clone(),
            pid: 0,
            eof: false,
            decoder: NativeOutputDecoder::default(),
            carry: VecDeque::with_capacity(2),
        };
        let reader_state = state.clone();
        let reader_wake = wake.clone();
        #[cfg(unix)]
        let reader_io = unix_io.clone();
        let reader_start = std::thread::Builder::new()
            .name("wmux-pty-reader".into())
            .spawn(move || {
                let _worker = Worker::enter();
                #[cfg(unix)]
                let wait_readable = || reader_io.wait(libc::POLLIN, -1);
                #[cfg(windows)]
                let wait_readable = || Ok(());
                run_reader(
                    &mut reader,
                    tx,
                    &reader_state,
                    &|| reader_wake.notify(),
                    &wait_readable,
                );
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
                let pid = child.process_id().unwrap() as i32;
                // The shell's own exit signals nothing, as with node-pty: what it
                // left gets the terminal's hangup. Only a session whose pane was
                // closed first is swept, at the deadline, while the unreaped root
                // still pins its session id.
                //
                // Invariant: `exited` is never held across a wait that can block.
                // kill() and close() take it, on the JS thread, before they signal
                // the root, so a blocking reap under it would wait for a root that
                // only their signal can end. The root is reaped under the lock
                // (no signal can reach a freed pid), but only with try_wait, once
                // an exit was observed; a root not reapable yet lets the lock go.
                //
                // Invariant: a hung-up root is reaped only after its session was
                // swept. The hangup arms the sweep under `exited` (kill()'s SIGHUP,
                // or close()), so the waiter, which reaps under that lock too,
                // either sees it armed or reaps before any hangup: never between
                // the two, where nothing could sweep the session any more (#3434).
                #[cfg(unix)]
                let (mut exit_guard, status) = loop {
                    let observed = observe_exit(pid);
                    let guard = waiter_state
                        .exited
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    // A sweep needs the observed exit: only then does it run.
                    let armed = match *waiter_state.sweep.lock().unwrap_or_else(|p| p.into_inner())
                    {
                        Sweep::Armed(at) if observed.is_ok() => Some(at),
                        _ => None,
                    };
                    if let Some(at) = armed {
                        // Unlocked, so kill() never waits out the grace.
                        drop(guard);
                        std::thread::sleep(at.saturating_duration_since(Instant::now()));
                        signal_session(pid, libc::SIGKILL);
                        *waiter_state.sweep.lock().unwrap_or_else(|p| p.into_inner()) = Sweep::Done;
                        continue;
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => break (guard, Ok(status)),
                        Ok(None) => {
                            // Still running: no exit could be watched (observe_exit
                            // failed). Look again, unlocked, a moment later.
                            drop(guard);
                            std::thread::sleep(EXIT_POLL);
                        }
                        Err(e) => break (guard, Err(e)),
                    }
                };
                #[cfg(windows)]
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
                // A background job can hold the terminal past the shell's exit;
                // like node-pty, end the output once nothing is pending, or at
                // the reader's deadline when the job never stops writing.
                #[cfg(unix)]
                {
                    let until = Instant::now() + EXIT_OUTPUT_GRACE;
                    while !waiter_state.reader_done.load(Ordering::Acquire)
                        && Instant::now() < until
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    if !waiter_state.reader_done.load(Ordering::Acquire) {
                        waiter_state.stop_reading.store(true, Ordering::Release);
                        // Wakes a reader waiting on the terminal.
                        waiter_state
                            .cancel
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .take();
                    }
                }
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

    #[napi(getter, catch_unwind)]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    #[napi(catch_unwind)]
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

    /// A refused decode throws; its bytes are kept, ahead of any later output,
    /// for the next read, and nothing else the read would report is consumed.
    #[napi(catch_unwind)]
    pub fn read_chunk(&mut self, paused: Option<bool>) -> Result<TransportChunkRead> {
        let data = self.take_output(paused);
        let exit = self.exit();
        let bytes_read = data.len() as u32;
        // The exit is final only once the output ended (`report`).
        let finish = self.eof && exit.is_some();
        let chunk = match self.decoder.try_decode(data, finish) {
            Ok(chunk) => chunk,
            Err((failed, data)) => {
                self.keep(data);
                return Err(failed.into());
            }
        };
        let result = self.report(Vec::new(), exit);
        Ok(TransportChunkRead {
            chunk,
            bytes_read,
            eof: result.eof,
            child_exited: result.child_exited,
            exit_code: result.exit_code,
            signal: result.signal,
            error: result.error,
            pending_input_bytes: result.pending_input_bytes,
        })
    }

    #[napi(getter, catch_unwind)]
    pub fn pending_input_bytes(&self) -> u32 {
        self.state
            .input
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .bytes as u32
    }

    #[napi(catch_unwind)]
    pub fn write(&self, data: Uint8Array) -> Result<()> {
        let mut input = self.state.input.lock().map_err(error)?;
        if enqueue(&mut input, &data)? {
            self.state.ready.notify_one();
        }
        Ok(())
    }

    #[napi(catch_unwind)]
    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.master
            .as_ref()
            .ok_or_else(|| Error::from_reason("PTY_CLOSED"))?
            .resize(size(cols, rows)?)
            .map_err(error)
    }

    #[napi(catch_unwind)]
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
    #[napi(catch_unwind)]
    pub fn set_parent_window(&self, handle: Uint8Array) -> bool {
        let Some(hwnd) = native_window_handle(&handle[..]) else {
            return false;
        };
        self.master
            .as_ref()
            .is_some_and(|master| master.set_parent_window(hwnd))
    }

    /// Signals the child (SIGHUP by default) and, on Unix, its foreground group.
    /// A SIGHUP is a hangup: it arms the session sweep HANGUP_GRACE later, which
    /// runs once the root's exit is seen, also with no close() after it. Only
    /// close() SIGKILLs a root that ignored it. A SIGKILL sweeps the session now.
    #[napi(catch_unwind)]
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
            if signal == libc::SIGHUP {
                // The hangup decides the sweep, under `exited` (see the waiter).
                arm(&self.state.sweep);
            }
            if let Some(group) = self.master.as_ref().and_then(|m| m.process_group_leader()) {
                if group > 0 {
                    unsafe {
                        libc::kill(-group, signal);
                    }
                }
            }
            let root = (unsafe { libc::kill(self.pid as i32, signal) } != 0)
                .then(std::io::Error::last_os_error);
            if signal == libc::SIGKILL {
                // After the root's own SIGKILL: a child it forks during the scan
                // is already in the session, and the root forks nothing after.
                signal_session(self.pid as i32, signal);
                *self.state.sweep.lock().unwrap_or_else(|p| p.into_inner()) = Sweep::Done;
            }
            if let Some(e) = root {
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

    #[napi(catch_unwind)]
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
        // Dropping the master hangs the terminal up (SIGHUP to the shell), after
        // the caller's own kill() as a rule. Both need time to be acted on:
        // whatever still runs in the session is killed only at the deadline.
        #[cfg(unix)]
        let sweep_at = self.arm_sweep();
        #[cfg(unix)]
        let (state, pid) = (self.state.clone(), self.pid as i32);
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
            // A root that ignored the hangup dies now, and the waiter then sweeps
            // its session. Unreaped: the waiter reaps only under this lock.
            #[cfg(unix)]
            if let Some(at) = sweep_at {
                std::thread::sleep(at.saturating_duration_since(Instant::now()));
                let exited = state.exited.lock().unwrap_or_else(|p| p.into_inner());
                if exited.is_none() {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        });
    }
}
impl NativeTransport {
    /// The session sweep's deadline when the child is still unreaped: the
    /// hangup's own when kill() armed it already.
    #[cfg(unix)]
    fn arm_sweep(&self) -> Option<Instant> {
        let exited = self.state.exited.lock().unwrap_or_else(|p| p.into_inner());
        if exited.is_some() || self.pid == 0 {
            return None;
        }
        arm(&self.state.sweep)
    }
    fn drain(&mut self, paused: Option<bool>) -> RawTransportRead {
        let data = self.take_output(paused);
        let exit = self.exit();
        self.report(data, exit)
    }

    /// Up to DRAIN_READS reads joined into one batch, carried ones first.
    /// The first is moved, not copied, so a read always makes progress
    /// without allocating; a read that cannot be joined (a refused
    /// allocation) is carried to the next call. No byte is ever dropped.
    fn take_output(&mut self, paused: Option<bool>) -> Vec<u8> {
        let mut bytes = Vec::new();
        if paused.unwrap_or(false) {
            return bytes;
        }
        let mut taken = 0;
        while let Some(chunk) = self.carry.pop_front() {
            taken += 1;
            if let Err(chunk) = join(&mut bytes, chunk) {
                self.carry.push_front(chunk);
                return bytes;
            }
        }
        let Some(rx) = &self.receiver else {
            return bytes;
        };
        while taken < DRAIN_READS {
            match rx.try_recv() {
                Ok(data) => {
                    taken += 1;
                    if let Err(data) = join(&mut bytes, data) {
                        // The carry was emptied above: this one is its only entry.
                        self.carry.push_front(data);
                        break;
                    }
                }
                Err(TryRecvError::Disconnected) => {
                    self.eof = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        bytes
    }

    /// Hands a batch back for the next read, ahead of anything carried.
    fn keep(&mut self, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        // take_output leaves at most one entry: this is the second.
        debug_assert!(self.carry.len() < self.carry.capacity());
        self.carry.push_front(data);
    }

    fn exit(&mut self) -> Option<Exit> {
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
        exit
    }

    /// What a read reports besides its bytes; takes the recorded error.
    fn report(&self, data: Vec<u8>, exit: Option<Exit>) -> RawTransportRead {
        RawTransportRead {
            data,
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

/// Adds `chunk` to a read batch: moved when the batch is empty, else copied
/// onto it. A refused copy hands the chunk back.
fn join(bytes: &mut Vec<u8>, chunk: Vec<u8>) -> std::result::Result<(), Vec<u8>> {
    if bytes.is_empty() {
        *bytes = chunk;
        return Ok(());
    }
    // Bounded by DRAIN_READS x READ_BYTES (256 KiB) per batch.
    fallible::try_extend(bytes, &chunk, "a batch of PTY reads").map_err(|_| chunk)
}

/// Queues one write for the writer thread; whether anything was queued. A
/// refused copy leaves the queue as it was.
fn enqueue(input: &mut Input, data: &[u8]) -> Result<bool> {
    if input.closed {
        return Err(Error::from_reason("PTY_CLOSED"));
    }
    let queued = input
        .bytes
        .checked_add(data.len())
        .filter(|&n| n <= INPUT_LIMIT)
        .ok_or_else(|| Error::from_reason("PTY_BACKPRESSURE: input queue is full"))?;
    if data.is_empty() {
        return Ok(false);
    }
    // Bounded by INPUT_LIMIT (8 MiB) queued, this write included.
    let copy = fallible::try_copy(data, "the PTY input queue")?;
    fallible::try_reserve_deque(&mut input.queue, 1, "the PTY input queue")?;
    input.bytes = queued;
    input.queue.push_back(copy);
    Ok(true)
}

/// The reader thread: forwards each read to the channel until the output
/// ends. A refused copy or a panic ends this one session's output, with the
/// error recorded for its next read (the seam message, or the panic's); no
/// other session sees it. On Windows the pipe is then still read to EOF and
/// discarded, as after close: older ConPTY versions block ClosePseudoConsole
/// until their output is drained.
fn run_reader(
    reader: &mut dyn Read,
    tx: SyncSender<Vec<u8>>,
    state: &State,
    notify: &dyn Fn(),
    wait_readable: &dyn Fn() -> std::io::Result<()>,
) {
    let mut buffer = [0; READ_BYTES];
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        read_loop(reader, &tx, &mut buffer, state, notify, wait_readable)
    }));
    let stopped = match outcome {
        Ok(stopped) => stopped,
        Err(panic) => {
            state.record(format!("PTY_READER_PANIC: {}", panic_message(&*panic)));
            true
        }
    };
    drop(tx);
    #[cfg(windows)]
    if stopped {
        // The error and the end of the output are reported before the drain.
        notify();
        discard(reader, &mut buffer);
    }
    #[cfg(unix)]
    {
        let _ = stopped;
        state.reader_done.store(true, Ordering::Release);
    }
    notify();
}

/// Returns true when the output stopped on a refused copy (the error is
/// recorded), false when it ended.
fn read_loop(
    reader: &mut dyn Read,
    tx: &SyncSender<Vec<u8>>,
    buffer: &mut [u8; READ_BYTES],
    state: &State,
    notify: &dyn Fn(),
    wait_readable: &dyn Fn() -> std::io::Result<()>,
) -> bool {
    #[cfg(windows)]
    let _ = wait_readable;
    #[cfg(unix)]
    let mut stop_by: Option<Instant> = None;
    loop {
        #[cfg(unix)]
        if state.closed.load(Ordering::Acquire) {
            return false;
        }
        match reader.read(buffer) {
            Ok(0) => return false,
            Ok(n) => {
                // Older ConPTY versions block ClosePseudoConsole until their
                // output is drained. After disposal, discard bytes until EOF
                // instead of abandoning the pipe while the close worker is
                // using it.
                #[cfg(windows)]
                if state.closed.load(Ordering::Acquire) {
                    continue;
                }
                // One read: at most READ_BYTES.
                let chunk = match fallible::try_copy(&buffer[..n], "a PTY read") {
                    Ok(chunk) => chunk,
                    Err(failed) => {
                        state.record(failed.message());
                        return true;
                    }
                };
                if tx.send(chunk).is_err() {
                    #[cfg(windows)]
                    continue;
                    #[cfg(unix)]
                    return false;
                }
                notify();
                // Output that never pauses would never reach the check
                // below: end it at a deadline instead.
                #[cfg(unix)]
                if state.stop_reading.load(Ordering::Acquire)
                    && Instant::now()
                        >= *stop_by.get_or_insert_with(|| Instant::now() + EXIT_OUTPUT_GRACE)
                {
                    return false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            #[cfg(unix)]
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // Nothing is pending: an exited shell's output ends here.
                if state.stop_reading.load(Ordering::Acquire) {
                    return false;
                }
                if let Err(e) = wait_readable() {
                    if state.closed.load(Ordering::Acquire) {
                        return false;
                    }
                    // Stopped while waiting: read what is pending first.
                    if state.stop_reading.load(Ordering::Acquire) {
                        continue;
                    }
                    state.record(e.to_string());
                    notify();
                    return false;
                }
            }
            // Unix PTYs may signal slave closure with EIO.
            Err(e) if cfg!(unix) && e.raw_os_error() == Some(5) => return false,
            Err(e) => {
                state.record(e.to_string());
                notify();
                return false;
            }
        }
    }
}

/// Reads to EOF without keeping anything (no allocation).
#[cfg(windows)]
fn discard(reader: &mut dyn Read, buffer: &mut [u8]) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| loop {
        match reader.read(buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }));
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic without a message")
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

/// A pane's session sweep: not armed, armed for a deadline, or run.
#[cfg(unix)]
#[derive(Clone, Copy)]
enum Sweep {
    None,
    Armed(Instant),
    Done,
}

/// Arms the sweep HANGUP_GRACE from now: the deadline it has, if armed already
/// and still ahead, so a later hangup never puts it off, or none once it ran.
/// A deadline already past (a hangup whose root lived on) is armed again, so
/// this hangup still gets its grace. The caller holds `exited` and found the
/// child unreaped.
#[cfg(unix)]
fn arm(sweep: &Mutex<Sweep>) -> Option<Instant> {
    let mut sweep = sweep.lock().unwrap_or_else(|p| p.into_inner());
    match *sweep {
        Sweep::Armed(at) if at > Instant::now() => Some(at),
        Sweep::Done => None,
        Sweep::None | Sweep::Armed(_) => {
            let at = Instant::now() + HANGUP_GRACE;
            *sweep = Sweep::Armed(at);
            Some(at)
        }
    }
}

/// Blocks until `pid` has exited (unreaped). A stopped or continued root is
/// not an exit: macOS answers WEXITED with a stop too (CLD_STOPPED, as a tree
/// capture's SIGSTOP leaves the root). The only waits here keep WNOWAIT, so
/// nothing reaps the root outside the waiter's lock.
#[cfg(unix)]
fn observe_exit(pid: i32) -> std::io::Result<()> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let mut pause = EXIT_POLL;
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
            match info.si_code {
                // Asked again a moment later: while the root stays stopped, the
                // same report comes back at once.
                libc::CLD_STOPPED | libc::CLD_CONTINUED | libc::CLD_TRAPPED => {
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(EXIT_POLL_MAX);
                    continue;
                }
                // Any other report is an exit; the waiter's try_wait confirms it.
                _ => return Ok(()),
            }
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
/// It runs for an explicit SIGKILL, and HANGUP_GRACE after a pane is hung up
/// (kill()'s SIGHUP, or close()) while its shell is unreaped. It never runs on
/// the shell's own exit, nor for a pane hung up after the shell has exited and
/// been reaped: once reaped, the
/// session id may name another session, so what the shell left behind gets
/// only the terminal's hangup there, as it does with node-pty.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fallible::{fail_from, ALLOC_FAILED};

    fn transport(rx: Receiver<Vec<u8>>, state: Arc<State>) -> NativeTransport {
        NativeTransport {
            master: None,
            #[cfg(windows)]
            killer: None,
            receiver: Some(rx),
            state,
            pid: 0,
            eof: false,
            decoder: NativeOutputDecoder::default(),
            carry: VecDeque::with_capacity(2),
        }
    }

    /// A PTY whose reads return these pieces, then EOF.
    struct Pieces(VecDeque<Vec<u8>>);
    impl Read for Pieces {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            Ok(self.0.pop_front().map_or(0, |piece| {
                buf[..piece.len()].copy_from_slice(&piece);
                piece.len()
            }))
        }
    }

    struct Panics;
    impl Read for Panics {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("read went wrong")
        }
    }

    fn pieces(list: &[&[u8]]) -> Pieces {
        Pieces(list.iter().map(|piece| piece.to_vec()).collect())
    }

    #[test]
    fn a_drain_joins_its_reads_into_one_batch() {
        let (tx, rx) = sync_channel(DRAIN_READS);
        let mut t = transport(rx, Arc::new(State::new()));
        for piece in ["one", "two", "three"] {
            tx.send(piece.as_bytes().to_vec()).unwrap();
        }
        assert_eq!(t.drain(None).data, b"onetwothree");
    }

    #[test]
    fn a_refused_join_carries_the_read_to_the_next_drain_without_losing_a_byte() {
        let (tx, rx) = sync_channel(DRAIN_READS);
        let mut t = transport(rx, Arc::new(State::new()));
        for piece in ["one", "two", "three"] {
            tx.send(piece.as_bytes().to_vec()).unwrap();
        }
        {
            let _fail = fail_from(1);
            // The first read is moved, never copied: every drain makes progress.
            let read = t.drain(None);
            assert_eq!(read.data, b"one");
            assert!(!read.eof && read.error.is_none());
            assert_eq!(t.carry.len(), 1);
            assert_eq!(t.drain(None).data, b"two");
            // A paused read takes nothing, the carried read included.
            assert!(t.drain(Some(true)).data.is_empty());
        }
        drop(tx);
        let read = t.drain(None);
        assert_eq!(read.data, b"three", "the carried read comes back next");
        assert!(read.eof);
        assert!(t.carry.is_empty());
    }

    #[test]
    fn a_refused_decode_keeps_its_bytes_and_the_read_error_for_the_next_read() {
        let (tx, rx) = sync_channel(DRAIN_READS);
        let state = Arc::new(State::new());
        let mut t = transport(rx, state.clone());
        state.record("earlier error".into());
        // An invalid byte needs the decoder's replacement copy.
        tx.send(b"bad\xff".to_vec()).unwrap();
        tx.send(b"next".to_vec()).unwrap();
        {
            let _fail = fail_from(1);
            let refused = t.read_chunk(None).err().expect("the decode is refused");
            assert!(
                refused.reason.starts_with(ALLOC_FAILED),
                "{}",
                refused.reason
            );
        }
        assert_eq!(
            t.carry.len(),
            2,
            "the batch comes back ahead of the carried read"
        );
        let read = t.read_chunk(None).unwrap();
        assert_eq!(read.chunk.bytes, "bad\u{fffd}next".as_bytes());
        assert_eq!(read.bytes_read, 8);
        assert_eq!(read.error.as_deref(), Some("earlier error"));
    }

    #[test]
    fn a_refused_reader_copy_ends_only_this_sessions_output_with_the_seam_error() {
        let (tx, rx) = sync_channel(DRAIN_READS);
        let state = Arc::new(State::new());
        let mut reader = pieces(&[b"kept", &[b'x'; 64], b"never"]);
        {
            let _fail = fail_from(64);
            run_reader(&mut reader, tx, &state, &|| {}, &|| Ok(()));
        }
        // Windows reads the pipe to EOF so ClosePseudoConsole cannot block.
        #[cfg(windows)]
        assert!(reader.0.is_empty());
        let mut t = transport(rx, state);
        let read = t.drain(None);
        assert_eq!(read.data, b"kept");
        assert!(read.eof, "the session's output ended");
        assert_eq!(
            read.error.as_deref(),
            Some("ALLOC_FAILED: could not allocate 64 bytes for a PTY read")
        );
        assert_eq!(t.drain(None).error, None, "the error is reported once");
    }

    #[test]
    fn a_reader_panic_is_the_sessions_read_error() {
        let (tx, rx) = sync_channel(DRAIN_READS);
        let state = Arc::new(State::new());
        let notified = std::cell::Cell::new(0);
        run_reader(
            &mut Panics,
            tx,
            &state,
            &|| notified.set(notified.get() + 1),
            &|| Ok(()),
        );
        assert!(notified.get() >= 1);
        let read = transport(rx, state).drain(None);
        assert!(read.eof);
        assert_eq!(
            read.error.as_deref(),
            Some("PTY_READER_PANIC: read went wrong")
        );
    }

    #[test]
    fn a_reader_reaching_eof_ends_the_output_without_an_error() {
        let (tx, rx) = sync_channel(DRAIN_READS);
        let state = Arc::new(State::new());
        run_reader(&mut pieces(&[b"a", b"b"]), tx, &state, &|| {}, &|| Ok(()));
        let read = transport(rx, state).drain(None);
        assert_eq!(read.data, b"ab");
        assert!(read.eof && read.error.is_none());
    }

    #[test]
    fn a_refused_input_copy_is_the_write_error_and_queues_nothing() {
        let mut input = Input::default();
        {
            // The copy itself.
            let _fail = fail_from(4);
            let refused = enqueue(&mut input, b"abcd").unwrap_err();
            assert_eq!(
                refused.reason,
                "ALLOC_FAILED: could not allocate 4 bytes for the PTY input queue"
            );
        }
        {
            // The queue's own growth (one Vec slot).
            let _fail = fail_from(std::mem::size_of::<Vec<u8>>());
            assert!(enqueue(&mut input, b"abcd").is_err());
        }
        assert_eq!(input.bytes, 0);
        assert!(input.queue.is_empty());
        assert!(enqueue(&mut input, b"abcd").unwrap());
        assert_eq!(input.bytes, 4);
        assert!(!enqueue(&mut input, b"").unwrap());
    }

    #[test]
    fn the_input_limit_is_checked_without_overflow() {
        let mut input = Input {
            bytes: usize::MAX,
            ..Input::default()
        };
        let refused = enqueue(&mut input, b"a").unwrap_err();
        assert!(refused.reason.starts_with("PTY_BACKPRESSURE"));
        input.bytes = INPUT_LIMIT;
        assert!(enqueue(&mut input, b"a").is_err());
        input.closed = true;
        assert_eq!(enqueue(&mut input, b"a").unwrap_err().reason, "PTY_CLOSED");
    }
}
