//! One accepted pipe instance: one I/O thread drives an overlapped read and
//! an overlapped write on the handle and wakes the owner when either is done.
//! Reads run only on demand (`request_read`), so a paused reader leaves the
//! bytes in the pipe and the client's writes block: backpressure.

use super::listener::PipeInstance;
use super::peer::PeerFacts;
use super::sys::*;
use super::{Notify, Worker};
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// A single read asks for at most this much.
const MAX_READ: usize = 1024 * 1024;

/// A write is issued in chunks of at most this much, so a long write shows
/// progress (for END_DRAIN_LIMIT) each time a chunk completes.
const WRITE_CHUNK: usize = 64 * 1024;

/// An idle limit for end(): when no queued write makes progress for this
/// long, the client has stopped reading, and end() cancels the writes and
/// closes anyway, so it cannot keep an ended conn (its thread, handles and
/// slot) open for good. A client that reads slowly but steadily is never
/// cut off: the deadline moves forward each time a chunk completes.
pub(crate) const END_DRAIN_LIMIT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(30)
};

#[derive(Debug, PartialEq)]
pub(crate) enum ReadResult {
    Data(Vec<u8>),
    Eof,
}

#[derive(Default)]
struct State {
    /// A requested read the I/O thread has not started yet.
    read_request: Option<usize>,
    /// A read was requested and its result has not been taken.
    read_busy: bool,
    read_result: Option<ReadResult>,
    eof: bool,
    writes: VecDeque<(u32, Vec<u8>)>,
    written: Vec<u32>,
    next_write_id: u32,
    write_failed: bool,
    ending: bool,
    destroying: bool,
    closed: bool,
    error: Option<String>,
}

struct Shared {
    state: Mutex<State>,
    /// Auto-reset: "the state changed, look again". Closed by the I/O
    /// thread as it exits, so a finished conn holds no OS handle however
    /// long its JS object lives; a later poke is a no-op.
    control: Mutex<Option<OwnedHandle>>,
    /// Dropped once the instance is closed, so a closed conn no longer
    /// holds the (ref'd) wake callback.
    notify: Mutex<Option<Notify>>,
    /// The I/O thread's handle: taken by destroy() to join it, or dropped
    /// by the thread itself as it exits, so a finished conn keeps no thread
    /// handle either.
    thread: Mutex<Option<JoinHandle<()>>>,
    /// Set as the I/O thread's last act, for a join whose JoinHandle the
    /// thread already dropped.
    exited: Mutex<bool>,
    exited_signal: Condvar,
    /// Runs once when the conn has closed (the binding drops its strong
    /// cleanup entry there).
    on_closed: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn poke(&self) {
        // Under the lock, so the I/O thread cannot close it meanwhile.
        if let Some(control) = self
            .control
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            set_event(control);
        }
    }
    fn wake(&self) {
        let notify = self
            .notify
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(notify) = notify {
            notify();
        }
    }
}

pub(crate) struct Conn {
    shared: Arc<Shared>,
    peer: PeerFacts,
}

impl Conn {
    /// Starts the I/O thread for a connected instance. `process` is the
    /// peer's handle, held until the instance closes.
    pub(crate) fn start(
        instance: PipeInstance,
        peer: PeerFacts,
        process: Option<OwnedHandle>,
        notify: Notify,
    ) -> Result<Arc<Self>, String> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            control: Mutex::new(Some(event(false)?)),
            notify: Mutex::new(Some(notify)),
            thread: Mutex::new(None),
            exited: Mutex::new(false),
            exited_signal: Condvar::new(),
            on_closed: Mutex::new(None),
        });
        let read_event = event(true)?;
        let write_event = event(true)?;
        let worker_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("wmux-pipe-io".into())
            .spawn(move || {
                let worker = Worker::enter();
                run(&worker_shared, &instance, read_event, write_event);
                // Close order: the handle (and its instance slot), then the
                // peer's process handle, then report closed.
                drop(instance);
                drop(process);
                worker_shared
                    .control
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                worker_shared.lock().closed = true;
                worker_shared.wake();
                worker_shared
                    .notify
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                // Unless destroy() took it to join: dropping its own handle
                // only closes the handle; the thread ends right after.
                worker_shared
                    .thread
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                let on_closed = worker_shared
                    .on_closed
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                if let Some(on_closed) = on_closed {
                    on_closed();
                }
                drop(worker);
                *worker_shared
                    .exited
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = true;
                worker_shared.exited_signal.notify_all();
            })
            .map_err(|e| e.to_string())?;
        {
            let state = shared.lock();
            // Already closed: the thread has (nearly) ended; keep no handle.
            if !state.closed {
                *shared.thread.lock().unwrap_or_else(|p| p.into_inner()) = Some(thread);
            }
        }
        Ok(Arc::new(Self { shared, peer }))
    }

    pub(crate) fn peer(&self) -> &PeerFacts {
        &self.peer
    }

    /// Starts one read of up to `max` bytes unless one is outstanding or
    /// its result has not been taken.
    pub(crate) fn request_read(&self, max: usize) {
        let mut state = self.shared.lock();
        if state.read_busy || state.eof || state.closed || state.destroying {
            return;
        }
        state.read_busy = true;
        state.read_request = Some(max.clamp(1, MAX_READ));
        drop(state);
        self.shared.poke();
    }

    /// The finished read, if any. EOF is reported once and stays reported.
    pub(crate) fn take_read(&self) -> Option<ReadResult> {
        let mut state = self.shared.lock();
        let result = state.read_result.take();
        if result.is_some() {
            state.read_busy = false;
        }
        result
    }

    /// Queues `data`; returns its write id. After a failed write or a
    /// close, the id is reported as done at once (see `error`).
    pub(crate) fn write(&self, data: Vec<u8>) -> u32 {
        let mut state = self.shared.lock();
        state.next_write_id = state.next_write_id.wrapping_add(1);
        let id = state.next_write_id;
        if state.write_failed || state.ending || state.destroying || state.closed {
            if state.error.is_none() && !state.write_failed {
                state.error = Some("write after end".into());
            }
            state.written.push(id);
            drop(state);
            self.shared.wake();
            return id;
        }
        state.writes.push_back((id, data));
        drop(state);
        self.shared.poke();
        id
    }

    pub(crate) fn take_written(&self) -> Vec<u32> {
        std::mem::take(&mut self.shared.lock().written)
    }

    pub(crate) fn error(&self) -> Option<String> {
        self.shared.lock().error.clone()
    }

    /// Closes the handle once every queued write has completed.
    pub(crate) fn end(&self) {
        let mut state = self.shared.lock();
        if state.ending || state.destroying || state.closed {
            return;
        }
        state.ending = true;
        drop(state);
        self.shared.poke();
    }

    pub(crate) fn ending(&self) -> bool {
        self.shared.lock().ending
    }

    pub(crate) fn closed(&self) -> bool {
        self.shared.lock().closed
    }

    /// Runs `f` once the conn has closed (at once if it already has).
    pub(crate) fn on_closed(&self, f: Box<dyn FnOnce() + Send>) {
        let state = self.shared.lock();
        if state.closed {
            drop(state);
            f();
            return;
        }
        // Set under the state lock: the I/O thread sets `closed` before it
        // takes this, so it always finds `f`.
        *self
            .shared
            .on_closed
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    /// Cancels pending I/O and closes; the join runs off the caller's thread.
    pub(crate) fn destroy(&self) {
        if self.signal_destroy() {
            if let Some(thread) = self.take_thread() {
                if thread.is_finished() {
                    let _ = thread.join();
                    return;
                }
                let _ = std::thread::Builder::new()
                    .name("wmux-pipe-join".into())
                    .spawn(move || {
                        let _worker = Worker::enter();
                        let _ = thread.join();
                    });
            }
        }
    }

    /// As `destroy`, waiting on the caller's thread until the I/O thread
    /// has exited.
    pub(crate) fn destroy_and_join(&self) {
        self.signal_destroy();
        if let Some(thread) = self.take_thread() {
            let _ = thread.join();
            return;
        }
        // The thread dropped its own handle: wait for its last act.
        let mut exited = self.shared.exited.lock().unwrap_or_else(|p| p.into_inner());
        while !*exited {
            exited = self
                .shared
                .exited_signal
                .wait(exited)
                .unwrap_or_else(|p| p.into_inner());
        }
    }

    fn signal_destroy(&self) -> bool {
        let mut state = self.shared.lock();
        if state.destroying {
            return false;
        }
        state.destroying = true;
        drop(state);
        self.shared.poke();
        true
    }

    fn take_thread(&self) -> Option<JoinHandle<()>> {
        self.shared
            .thread
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        // An ending conn finishes its queued writes on its own, or gives up
        // after END_DRAIN_LIMIT.
        if !self.ending() {
            self.destroy();
        }
    }
}

fn is_eof(code: u32) -> bool {
    matches!(
        code,
        ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_HANDLE_EOF | ERROR_NO_DATA
    )
}

/// A queued write being sent, chunk by chunk.
struct Sending {
    id: u32,
    data: Vec<u8>,
    sent: usize,
}

/// The I/O loop. Returns with no I/O outstanding on the handle.
fn run(
    shared: &Shared,
    instance: &PipeInstance,
    read_event: OwnedHandle,
    write_event: OwnedHandle,
) {
    let pipe = instance.raw();
    // Valid until this thread closes it after `run` returns.
    let Some(control) = shared
        .control
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(OwnedHandle::raw)
    else {
        return;
    };
    let mut read_ov = Overlapped::with_event(read_event.raw());
    let mut write_ov = Overlapped::with_event(write_event.raw());
    let mut read_buf: Vec<u8> = Vec::new();
    let mut read_pending = false;
    let mut sending: Option<Sending> = None;
    let mut write_pending = false;
    // While ending: the last write progress plus the idle limit.
    let mut drain_deadline: Option<Instant> = None;
    loop {
        let mut state = shared.lock();
        if state.destroying {
            break;
        }
        if state.ending {
            // All writes done wins over a deadline that passed meanwhile.
            if sending.is_none() && (state.writes.is_empty() || state.write_failed) {
                break;
            }
            let deadline = *drain_deadline.get_or_insert_with(|| Instant::now() + END_DRAIN_LIMIT);
            if Instant::now() >= deadline {
                state.error.get_or_insert_with(|| {
                    format!(
                        "end: the client read none of the queued writes for {} s",
                        END_DRAIN_LIMIT.as_secs()
                    )
                });
                break;
            }
        }
        if !read_pending && !state.eof {
            if let Some(max) = state.read_request.take() {
                read_buf.resize(max, 0);
                read_ov.rearm();
                let mut n = 0;
                // SAFETY: the buffer and OVERLAPPED outlive the operation:
                // this loop never exits with a read outstanding.
                let ok = unsafe {
                    ReadFile(
                        pipe,
                        read_buf.as_mut_ptr(),
                        max as u32,
                        &mut n,
                        &mut *read_ov,
                    )
                };
                let code = if ok != 0 { 0 } else { last_error() };
                if ok != 0 || code == ERROR_IO_PENDING || code == ERROR_MORE_DATA {
                    read_pending = true;
                } else {
                    finish_read_error(&mut state, code);
                    drop(state);
                    shared.wake();
                    continue;
                }
            }
        }
        if sending.is_none() && !state.write_failed {
            if let Some((id, data)) = state.writes.pop_front() {
                if data.is_empty() {
                    state.written.push(id);
                    drop(state);
                    shared.wake();
                    continue;
                }
                sending = Some(Sending { id, data, sent: 0 });
            }
        }
        if !write_pending {
            if let Some(current) = &sending {
                let chunk = &current.data[current.sent..];
                let len = chunk.len().min(WRITE_CHUNK) as u32;
                write_ov.rearm();
                let mut n = 0;
                // SAFETY: as for the read; `sending` keeps the bytes alive
                // until the write completes or is canceled and waited for.
                let ok = unsafe { WriteFile(pipe, chunk.as_ptr(), len, &mut n, &mut *write_ov) };
                let code = if ok != 0 { 0 } else { last_error() };
                if ok != 0 || code == ERROR_IO_PENDING {
                    write_pending = true;
                } else {
                    let id = current.id;
                    sending = None;
                    fail_writes(&mut state, id, code);
                    drop(state);
                    shared.wake();
                    continue;
                }
            }
        }
        drop(state);

        let mut handles = vec![control];
        if read_pending {
            handles.push(read_event.raw());
        }
        if write_pending {
            handles.push(write_event.raw());
        }
        let timeout = drain_deadline.map_or(INFINITE, |deadline| {
            let left = deadline
                .saturating_duration_since(Instant::now())
                .as_millis();
            // Rounded up, so the deadline has passed when the wait times out.
            (left + 1).min(u128::from(INFINITE - 1)) as u32
        });
        let signalled = match wait_any(&handles, timeout) {
            Ok(Some(index)) => handles[index],
            Ok(None) => continue,
            Err(message) => {
                shared.lock().error = Some(message);
                shared.wake();
                break;
            }
        };
        if read_pending && signalled == read_event.raw() {
            read_pending = false;
            let mut n = 0;
            // SAFETY: the read has completed (its event is set).
            let ok = unsafe { GetOverlappedResult(pipe, &mut *read_ov, &mut n, 0) };
            let code = if ok != 0 { 0 } else { last_error() };
            let mut state = shared.lock();
            if ok != 0 || code == ERROR_MORE_DATA {
                if n == 0 {
                    // A zero-length message: read again.
                    state.read_request = Some(read_buf.len());
                    drop(state);
                    continue;
                }
                state.read_result = Some(ReadResult::Data(read_buf[..n as usize].to_vec()));
            } else {
                // Includes ERROR_OPERATION_ABORTED: this thread cancels only
                // at exit, so an abort here is reported, never left pending.
                finish_read_error(&mut state, code);
            }
            drop(state);
            shared.wake();
        } else if write_pending && signalled == write_event.raw() {
            write_pending = false;
            let mut n = 0;
            // SAFETY: the write has completed (its event is set).
            let ok = unsafe { GetOverlappedResult(pipe, &mut *write_ov, &mut n, 0) };
            let code = if ok != 0 { 0 } else { last_error() };
            let Some(mut current) = sending.take() else {
                continue;
            };
            if ok == 0 {
                let mut state = shared.lock();
                fail_writes(&mut state, current.id, code);
                drop(state);
                shared.wake();
                continue;
            }
            // Progress: an ending conn's idle deadline moves forward.
            if let Some(deadline) = drain_deadline.as_mut() {
                *deadline = Instant::now() + END_DRAIN_LIMIT;
            }
            current.sent += n as usize;
            if current.sent < current.data.len() {
                sending = Some(current);
                continue;
            }
            shared.lock().written.push(current.id);
            shared.wake();
        }
    }
    // Cancel what is still outstanding and wait for it, so the buffers and
    // OVERLAPPEDs are not in use when the handle closes.
    if read_pending {
        cancel_and_wait(pipe, &mut read_ov);
    }
    if write_pending {
        cancel_and_wait(pipe, &mut write_ov);
    }
    let mut state = shared.lock();
    if let Some(current) = sending.take() {
        state.written.push(current.id);
        state.error.get_or_insert_with(|| "write canceled".into());
    }
    if !state.writes.is_empty() {
        let ids: Vec<u32> = state.writes.drain(..).map(|(id, _)| id).collect();
        state.written.extend(ids);
        state.error.get_or_insert_with(|| "write canceled".into());
    }
}

fn cancel_and_wait(pipe: Handle, overlapped: &mut Overlapped) {
    let mut n = 0;
    // SAFETY: cancels this OVERLAPPED's operation, then waits for it to
    // complete either way.
    unsafe {
        CancelIoEx(pipe, overlapped);
        GetOverlappedResult(pipe, overlapped, &mut n, 1);
    }
}

fn finish_read_error(state: &mut State, code: u32) {
    state.eof = true;
    if is_eof(code) {
        state.read_result = Some(ReadResult::Eof);
    } else {
        state.error = Some(os_error("ReadFile", code));
        state.read_result = Some(ReadResult::Eof);
    }
}

/// A failed write fails it and every write queued after it.
fn fail_writes(state: &mut State, id: u32, code: u32) {
    state.write_failed = true;
    state.written.push(id);
    let ids: Vec<u32> = state.writes.drain(..).map(|(id, _)| id).collect();
    state.written.extend(ids);
    if state.error.is_none() {
        state.error = Some(if is_eof(code) {
            format!("EPIPE: {}", os_error("WriteFile", code))
        } else {
            os_error("WriteFile", code)
        });
    }
}
