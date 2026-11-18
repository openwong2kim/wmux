//! One accepted pipe instance: one I/O thread drives an overlapped read and
//! an overlapped write on the handle and wakes the owner when either is done.
//! Reads run only on demand (`request_read`), so a paused reader leaves the
//! bytes in the pipe and the client's writes block: backpressure.

use super::listener::PipeInstance;
use super::peer::PeerFacts;
use super::sys::*;
use super::{Notify, Worker};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

/// A single read asks for at most this much.
const MAX_READ: usize = 1024 * 1024;

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
    /// Auto-reset: "the state changed, look again".
    control: OwnedHandle,
    /// Dropped once the instance is closed, so a closed conn no longer
    /// holds the (ref'd) wake callback.
    notify: Mutex<Option<Notify>>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn poke(&self) {
        set_event(&self.control);
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
    thread: Mutex<Option<JoinHandle<()>>>,
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
            control: event(false)?,
            notify: Mutex::new(Some(notify)),
        });
        let read_event = event(true)?;
        let write_event = event(true)?;
        let worker_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("wmux-pipe-io".into())
            .spawn(move || {
                let _worker = Worker::enter();
                run(&worker_shared, &instance, read_event, write_event);
                // Close order: the handle (and its instance slot), then the
                // peer's process handle, then report closed.
                drop(instance);
                drop(process);
                worker_shared.lock().closed = true;
                worker_shared.wake();
                worker_shared
                    .notify
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
            })
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            shared,
            peer,
            thread: Mutex::new(Some(thread)),
        }))
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

    /// Cancels pending I/O and closes; the join runs off the caller's thread.
    pub(crate) fn destroy(&self) {
        if self.signal_destroy() {
            if let Some(thread) = self.take_thread() {
                let _ = std::thread::Builder::new()
                    .name("wmux-pipe-join".into())
                    .spawn(move || {
                        let _worker = Worker::enter();
                        let _ = thread.join();
                    });
            }
        }
    }

    /// As `destroy`, joining on the caller's thread.
    pub(crate) fn destroy_and_join(&self) {
        self.signal_destroy();
        if let Some(thread) = self.take_thread() {
            let _ = thread.join();
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
        self.thread.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        // An ending conn finishes its queued writes on its own.
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

/// The I/O loop. Returns with no I/O outstanding on the handle.
fn run(
    shared: &Shared,
    instance: &PipeInstance,
    read_event: OwnedHandle,
    write_event: OwnedHandle,
) {
    let pipe = instance.raw();
    let mut read_ov = Overlapped::with_event(read_event.raw());
    let mut write_ov = Overlapped::with_event(write_event.raw());
    let mut read_buf: Vec<u8> = Vec::new();
    let mut read_pending = false;
    let mut write_pending: Option<(u32, Vec<u8>)> = None;
    loop {
        let mut state = shared.lock();
        if state.destroying {
            break;
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
        if write_pending.is_none() && !state.write_failed {
            if let Some((id, data)) = state.writes.pop_front() {
                if data.is_empty() {
                    state.written.push(id);
                    drop(state);
                    shared.wake();
                    continue;
                }
                write_ov.rearm();
                let mut n = 0;
                let len = data.len().min(u32::MAX as usize) as u32;
                // SAFETY: as for the read; `data` moves into write_pending.
                let ok = unsafe { WriteFile(pipe, data.as_ptr(), len, &mut n, &mut *write_ov) };
                let code = if ok != 0 { 0 } else { last_error() };
                if ok != 0 || code == ERROR_IO_PENDING {
                    write_pending = Some((id, data));
                } else {
                    fail_writes(&mut state, id, code);
                    drop(state);
                    shared.wake();
                    continue;
                }
            }
        }
        if state.ending
            && write_pending.is_none()
            && (state.writes.is_empty() || state.write_failed)
        {
            break;
        }
        drop(state);

        let mut handles = vec![shared.control.raw()];
        if read_pending {
            handles.push(read_event.raw());
        }
        if write_pending.is_some() {
            handles.push(write_event.raw());
        }
        let signalled = match wait_any(&handles, INFINITE) {
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
            } else if code == ERROR_OPERATION_ABORTED {
                continue;
            } else {
                finish_read_error(&mut state, code);
            }
            drop(state);
            shared.wake();
        } else if signalled == write_event.raw() {
            if let Some((id, _data)) = write_pending.take() {
                let mut n = 0;
                // SAFETY: the write has completed (its event is set).
                let ok = unsafe { GetOverlappedResult(pipe, &mut *write_ov, &mut n, 0) };
                let mut state = shared.lock();
                if ok != 0 {
                    state.written.push(id);
                } else {
                    fail_writes(&mut state, id, last_error());
                }
                drop(state);
                shared.wake();
            }
        }
    }
    // Cancel what is still outstanding and wait for it, so the buffers and
    // OVERLAPPEDs are not in use when the handle closes.
    if read_pending {
        cancel_and_wait(pipe, &mut read_ov);
    }
    if let Some((id, _data)) = write_pending.take() {
        cancel_and_wait(pipe, &mut write_ov);
        let mut state = shared.lock();
        state.written.push(id);
        if state.error.is_none() {
            state.error = Some("write canceled".into());
        }
    }
    let mut state = shared.lock();
    if !state.writes.is_empty() {
        let ids: Vec<u32> = state.writes.drain(..).map(|(id, _)| id).collect();
        state.written.extend(ids);
        if state.error.is_none() {
            state.error = Some("write canceled".into());
        }
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
