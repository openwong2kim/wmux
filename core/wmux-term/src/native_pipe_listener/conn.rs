//! One accepted pipe instance: one I/O thread drives an overlapped read and
//! an overlapped write on the handle and wakes the owner when either is done.
//! Reads run only on demand (`request_read`), so a paused reader leaves the
//! bytes in the pipe and the client's writes block: backpressure.
//!
//! The client's token is read on a separate thread per request (`token`);
//! this conn's I/O thread never impersonates. The I/O thread waits for a
//! running token thread as it exits, so `closed` means the instance handle
//! is released and no thread of this conn is left running.

use super::listener::PipeInstance;
use super::peer::PeerFacts;
use super::sys::*;
use super::token::{self, TokenFacts, TokenOutcome};
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
    /// A read has returned data: the client can be impersonated.
    read_completed: bool,
    /// A token thread is running for this conn.
    token_pending: bool,
    token_facts: Option<TokenFacts>,
    #[cfg(test)]
    test: TestHooks,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestHooks {
    /// Holds the next token thread this long before it impersonates.
    pub token_delay: Option<Duration>,
    /// The last token thread's OpenThreadToken error after its revert.
    pub token_thread_after: Option<u32>,
}

struct Shared {
    state: Mutex<State>,
    /// The pipe instance, for token threads. The I/O thread takes it out as
    /// it exits; a token thread holds its own clone for its call.
    instance: Mutex<Option<Arc<PipeInstance>>>,
    /// The last token thread. Set under the `instance` lock, and read by the
    /// exiting I/O thread under that lock after it took the instance out, so
    /// every token thread started is joined before the conn reports closed.
    token_thread: Mutex<Option<JoinHandle<()>>>,
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
        let instance = Arc::new(instance);
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            instance: Mutex::new(Some(instance.clone())),
            token_thread: Mutex::new(None),
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
                // peer's process handle, then report closed. A running token
                // thread holds the handle until its call returns: wait for it
                // first, so the handle is released before `closed`.
                let token_thread = {
                    let mut slot = worker_shared
                        .instance
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    slot.take();
                    worker_shared
                        .token_thread
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .take()
                };
                drop(instance);
                if let Some(token_thread) = token_thread {
                    let _ = token_thread.join();
                }
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

    /// Starts reading the client's token on a thread of its own; the result
    /// is taken with take_token_facts(). Answered at once (with a wake)
    /// before any read returned data, or once the conn is closing. A call
    /// while a request runs, or while its result is untaken, does nothing.
    pub(crate) fn request_token_facts(&self) {
        let mut state = self.shared.lock();
        if state.token_pending || state.token_facts.is_some() {
            return;
        }
        if state.closed || state.destroying {
            return self.answer_now(state, token::CLOSED);
        }
        if !state.read_completed {
            return self.answer_now(state, token::NO_READ_YET);
        }
        // Held through the spawn and the handle's store: the exiting I/O
        // thread takes the instance out under this lock, then joins the
        // stored thread, so a thread started here is always waited for.
        let slot = self
            .shared
            .instance
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let Some(instance) = slot.clone() else {
            drop(slot);
            return self.answer_now(state, token::CLOSED);
        };
        let mut token_thread = self
            .shared
            .token_thread
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // The previous thread has stored its result (none is pending), so
        // it has ended or is about to: join it rather than leave it detached.
        if let Some(previous) = token_thread.take() {
            let _ = previous.join();
        }
        state.token_pending = true;
        #[cfg(test)]
        let delay = state.test.token_delay.take();
        #[cfg(not(test))]
        let delay = None;
        let shared = self.shared.clone();
        // Its own clone, so the result wakes JS before the conn reports
        // closed (the I/O thread waits for this thread first).
        let notify = self
            .shared
            .notify
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let spawned = token::spawn_read(instance, delay, move |outcome: TokenOutcome| {
            let mut state = shared.lock();
            state.token_pending = false;
            state.token_facts = Some(outcome.facts);
            #[cfg(test)]
            {
                state.test.token_thread_after = Some(outcome.thread_token_after);
            }
            drop(state);
            if let Some(notify) = notify {
                notify();
            }
        });
        match spawned {
            Ok(handle) => *token_thread = Some(handle),
            Err(_) => {
                drop(token_thread);
                drop(slot);
                state.token_pending = false;
                self.answer_now(state, token::IMPERSONATION_FAILED);
            }
        }
    }

    fn answer_now(&self, mut state: MutexGuard<'_, State>, reason: &'static str) {
        state.token_facts = Some(TokenFacts::Unavailable(reason));
        drop(state);
        self.shared.wake();
    }

    /// The token result, once; None while pending or never requested.
    pub(crate) fn take_token_facts(&self) -> Option<TokenFacts> {
        self.shared.lock().token_facts.take()
    }

    #[cfg(test)]
    pub(crate) fn test_hooks<R>(&self, f: impl FnOnce(&mut TestHooks) -> R) -> R {
        f(&mut self.shared.lock().test)
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
    /// close the write is not queued: error() says why, and the id is never
    /// reported by take_written().
    pub(crate) fn write(&self, data: Vec<u8>) -> u32 {
        let mut state = self.shared.lock();
        state.next_write_id = state.next_write_id.wrapping_add(1);
        let id = state.next_write_id;
        if state.write_failed || state.ending || state.destroying || state.closed {
            state.error.get_or_insert_with(|| "write after end".into());
            drop(state);
            self.shared.wake();
            return id;
        }
        state.writes.push_back((id, data));
        drop(state);
        self.shared.poke();
        id
    }

    /// Ids of writes that completed: every byte is in the pipe. A write
    /// that failed or was canceled is never listed; error() is set instead,
    /// so its caller fails it rather than settling it as sent.
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
            // A write that already completed is collected (by the wait
            // below, which returns at once) before the deadline counts.
            if Instant::now() >= deadline && !(write_pending && is_set(write_event.raw())) {
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
        if let Err(message) = wait_any(&handles, timeout) {
            shared.lock().error = Some(message);
            shared.wake();
            break;
        }
        // Each completion by its event's state, not by which handle the wait
        // named: control can win the wait while a write is already done.
        if read_pending && is_set(read_event.raw()) {
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
                state.read_completed = true;
            } else {
                // Includes ERROR_OPERATION_ABORTED: this thread cancels only
                // at exit, so an abort here is reported, never left pending.
                finish_read_error(&mut state, code);
            }
            drop(state);
            shared.wake();
        }
        if write_pending && is_set(write_event.raw()) {
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
    let completed = if write_pending {
        cancel_and_wait(pipe, &mut write_ov)
    } else {
        None
    };
    let mut state = shared.lock();
    if let Some(current) = sending.take() {
        // The cancel can lose to the completion: a write whose last chunk
        // went through is a completed write.
        if completed.is_some_and(|n| current.sent + n as usize >= current.data.len()) {
            state.written.push(current.id);
        } else {
            state.error.get_or_insert_with(|| "write canceled".into());
        }
    }
    if !state.writes.is_empty() {
        state.writes.clear();
        state.error.get_or_insert_with(|| "write canceled".into());
    }
}

/// Whether a manual-reset event is set.
fn is_set(event: Handle) -> bool {
    // SAFETY: a valid event handle; a zero timeout never blocks.
    unsafe { WaitForSingleObject(event, 0) == WAIT_OBJECT_0 }
}

/// Cancels this OVERLAPPED's operation and waits for it; Some(bytes) when
/// it completed successfully anyway.
fn cancel_and_wait(pipe: Handle, overlapped: &mut Overlapped) -> Option<u32> {
    let mut n = 0;
    // SAFETY: cancels this OVERLAPPED's operation, then waits for it to
    // complete either way.
    let ok = unsafe {
        CancelIoEx(pipe, overlapped);
        GetOverlappedResult(pipe, overlapped, &mut n, 1)
    };
    (ok != 0).then_some(n)
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

/// A failed write fails it and every write queued after it: none of their
/// ids is reported as written; error() is set instead.
fn fail_writes(state: &mut State, _id: u32, code: u32) {
    state.write_failed = true;
    state.writes.clear();
    if state.error.is_none() {
        state.error = Some(if is_eof(code) {
            format!("EPIPE: {}", os_error("WriteFile", code))
        } else {
            os_error("WriteFile", code)
        });
    }
}
