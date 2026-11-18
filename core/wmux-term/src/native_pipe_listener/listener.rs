//! The accept side: pipe instances under one owner-only security
//! descriptor, an instance cap, and one accept thread.

use super::conn::Conn;
use super::peer::read_peer;
use super::security::{current_user, owner_only_sddl, SecurityDescriptor, Sid};
use super::sys::*;
use super::{Notify, Worker};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;

/// The most accepted conns: one more instance (the listening one) must stay
/// below PIPE_UNLIMITED_INSTANCES (255).
pub(crate) const MAX_INSTANCES: u32 = 253;

/// At the cap, how long a connected client waits unserved for a slot
/// before it is disconnected.
pub(crate) const AT_CAP_WAIT: std::time::Duration = if cfg!(test) {
    std::time::Duration::from_millis(500)
} else {
    std::time::Duration::from_secs(10)
};
const AT_CAP_WAIT_MS: u32 = AT_CAP_WAIT.as_millis() as u32;

#[derive(Debug)]
pub(crate) enum ListenError {
    /// The name already exists (another listener, ours or not).
    AddressInUse(String),
    Other(String),
}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AddressInUse(m) | Self::Other(m) => f.write_str(m),
        }
    }
}

/// What every instance of the name shares: the security descriptor, the
/// cap (a semaphore with one unit per accepted conn) and the live count.
///
/// A listening instance always exists while the listener runs (the next one
/// is created before an accepted one is handed off, and the cap counts
/// accepted conns only), so the name never disappears and cannot be created
/// anew by another process in between.
pub(crate) struct Instances {
    name: Vec<u16>,
    max: u32,
    descriptor: SecurityDescriptor,
    slots: OwnedHandle,
    /// Live instances (pending + accepted). Creation and close both hold
    /// the lock, so a create that sees zero is the name's first instance.
    live: Mutex<u32>,
    pub(crate) own_user: Sid,
    pub(crate) own_session: u32,
}

impl Instances {
    pub(super) fn new(name: &str, max: u32) -> Result<Arc<Self>, ListenError> {
        if !(1..=MAX_INSTANCES).contains(&max) {
            return Err(ListenError::Other(format!(
                "maxInstances must be 1..={MAX_INSTANCES}"
            )));
        }
        let own_user = current_user().map_err(ListenError::Other)?;
        let sid = own_user.to_sddl_string().map_err(ListenError::Other)?;
        let descriptor =
            SecurityDescriptor::from_sddl(&owner_only_sddl(&sid)).map_err(ListenError::Other)?;
        // SAFETY: unnamed semaphore, default security, not inheritable.
        let slots = OwnedHandle::from_raw(unsafe {
            CreateSemaphoreW(std::ptr::null(), max as i32, max as i32, std::ptr::null())
        })
        .ok_or_else(|| ListenError::Other(os_error("CreateSemaphoreW", last_error())))?;
        let mut own_session = 0;
        // SAFETY: writes one u32.
        unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut own_session) };
        Ok(Arc::new(Self {
            name: wide(name),
            max,
            descriptor,
            slots,
            live: Mutex::new(0),
            own_user,
            own_session,
        }))
    }

    fn live(&self) -> MutexGuard<'_, u32> {
        self.live.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Takes an accepted-conn slot without waiting; false at the cap.
    pub(super) fn try_slot(&self) -> bool {
        // SAFETY: a valid semaphore.
        unsafe { WaitForSingleObject(self.slots.raw(), 0) == WAIT_OBJECT_0 }
    }

    fn release_slot(&self) {
        // SAFETY: a valid semaphore; never released above its maximum since
        // every release pairs with a taken slot.
        unsafe { ReleaseSemaphore(self.slots.raw(), 1, std::ptr::null_mut()) };
    }

    /// Creates an instance (listening; it takes no slot until accepted).
    pub(super) fn create(self: &Arc<Self>) -> Result<PipeInstance, ListenError> {
        let mut live = self.live();
        let first = *live == 0;
        let attributes = self.descriptor.attributes();
        // SAFETY: NUL-terminated name; attributes point at a live descriptor.
        let raw = unsafe {
            CreateNamedPipeW(
                self.name.as_ptr(),
                PIPE_ACCESS_DUPLEX
                    | FILE_FLAG_OVERLAPPED
                    | if first {
                        FILE_FLAG_FIRST_PIPE_INSTANCE
                    } else {
                        0
                    },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                // The accepted conns plus the listening instance.
                self.max + 1,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                &attributes,
            )
        };
        let Some(handle) = OwnedHandle::from_raw(raw) else {
            let code = last_error();
            drop(live);
            let message = os_error("CreateNamedPipeW", code);
            return Err(
                if first && (code == ERROR_ACCESS_DENIED || code == ERROR_PIPE_BUSY) {
                    ListenError::AddressInUse(format!("EADDRINUSE: {message}"))
                } else {
                    ListenError::Other(message)
                },
            );
        };
        *live += 1;
        Ok(PipeInstance {
            handle: Some(handle),
            owner: self.clone(),
            holds_slot: false,
        })
    }
}

/// One pipe instance, and its slot once accepted. Dropping it closes the handle without
/// DisconnectNamedPipe or FlushFileBuffers: the client can still read what
/// is buffered, then sees ERROR_BROKEN_PIPE.
pub(crate) struct PipeInstance {
    handle: Option<OwnedHandle>,
    owner: Arc<Instances>,
    holds_slot: bool,
}

impl PipeInstance {
    pub(crate) fn raw(&self) -> Handle {
        self.handle
            .as_ref()
            .map_or(INVALID_HANDLE_VALUE, OwnedHandle::raw)
    }
}

impl Drop for PipeInstance {
    fn drop(&mut self) {
        let mut live = self.owner.live();
        drop(self.handle.take());
        *live -= 1;
        drop(live);
        if self.holds_slot {
            self.owner.release_slot();
        }
    }
}

struct Shared {
    /// Manual-reset stop signal; closed by the accept thread as it exits.
    stop: Mutex<Option<OwnedHandle>>,
    /// Accepted conns not taken yet. `closed` is set before close() drains
    /// this under its lock, and the accept thread checks `closed` under the
    /// same lock before it adds one, so none is left behind.
    accepted: Mutex<VecDeque<Arc<Conn>>>,
    /// Untaken conns close() destroyed without waiting, for close_and_join.
    discarded: Mutex<Vec<Arc<Conn>>>,
    failure: Mutex<Option<String>>,
    closed: AtomicBool,
    /// Set as the accept thread's last act (after its listening instance is
    /// closed), whoever holds its JoinHandle.
    exited: Mutex<bool>,
    exited_signal: Condvar,
    /// Taken when the accept thread ends, so a closed listener no longer
    /// holds the wake callback (its conns keep their own clones).
    notify: Mutex<Option<Notify>>,
}

impl Shared {
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
    fn fail(&self, message: String) {
        self.failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert(message);
        self.wake();
    }
}

pub(crate) struct Listener {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Listener {
    /// Creates the name's first instance on the caller's thread (so a taken
    /// name fails here), then starts accepting.
    pub(crate) fn bind(name: &str, max: u32, notify: Notify) -> Result<Arc<Self>, ListenError> {
        let instances = Instances::new(name, max)?;
        let first = instances.create()?;
        let shared = Arc::new(Shared {
            stop: Mutex::new(Some(event(true).map_err(ListenError::Other)?)),
            accepted: Mutex::new(VecDeque::new()),
            discarded: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            closed: AtomicBool::new(false),
            exited: Mutex::new(false),
            exited_signal: Condvar::new(),
            notify: Mutex::new(Some(notify)),
        });
        let worker_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("wmux-pipe-accept".into())
            .spawn(move || {
                let worker = Worker::enter();
                let stop = worker_shared
                    .stop
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    .map(OwnedHandle::raw);
                if let Some(stop) = stop {
                    accept_loop(&worker_shared, stop, &instances, first);
                }
                worker_shared
                    .stop
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                worker_shared
                    .notify
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                drop(worker);
                *worker_shared
                    .exited
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = true;
                worker_shared.exited_signal.notify_all();
            })
            .map_err(|e| ListenError::Other(e.to_string()))?;
        Ok(Arc::new(Self {
            shared,
            thread: Mutex::new(Some(thread)),
        }))
    }

    pub(crate) fn take_accepted(&self) -> Option<Arc<Conn>> {
        self.shared
            .accepted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop_front()
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.shared
            .failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Stops accepting and closes the listening instance; the join runs off
    /// the caller's thread. Taken conns stay open; conns not taken are
    /// destroyed now (without waiting), so none is left holding the wake
    /// callback.
    pub(crate) fn close(&self) {
        if !self.signal_close() {
            return;
        }
        let untaken = drain_untaken(&self.shared);
        for conn in &untaken {
            conn.destroy();
        }
        self.shared
            .discarded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend(untaken);
        if let Some(thread) = self.take_thread() {
            // If the reaper cannot start, the handle is dropped (detached);
            // close_and_join still waits on the exit flag.
            let _ = std::thread::Builder::new()
                .name("wmux-pipe-join".into())
                .spawn(move || {
                    let _worker = Worker::enter();
                    let _ = thread.join();
                });
        }
    }

    /// As `close`, waiting on the caller's thread until the accept thread
    /// has exited (the name released) and every untaken conn has closed,
    /// even after an earlier close().
    pub(crate) fn close_and_join(&self) {
        self.signal_close();
        if let Some(thread) = self.take_thread() {
            let _ = thread.join();
        }
        let mut exited = self.shared.exited.lock().unwrap_or_else(|p| p.into_inner());
        while !*exited {
            exited = self
                .shared
                .exited_signal
                .wait(exited)
                .unwrap_or_else(|p| p.into_inner());
        }
        drop(exited);
        let mut untaken = drain_untaken(&self.shared);
        untaken.extend(std::mem::take(
            &mut *self
                .shared
                .discarded
                .lock()
                .unwrap_or_else(|p| p.into_inner()),
        ));
        for conn in untaken {
            conn.destroy_and_join();
        }
    }

    fn signal_close(&self) -> bool {
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return false;
        }
        // Under the lock, so the accept thread cannot close it meanwhile.
        if let Some(stop) = self
            .shared
            .stop
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            set_event(stop);
        }
        true
    }

    fn take_thread(&self) -> Option<JoinHandle<()>> {
        self.thread.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.close();
    }
}

fn drain_untaken(shared: &Shared) -> Vec<Arc<Conn>> {
    shared
        .accepted
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain(..)
        .collect()
}

enum Connect {
    Connected,
    Stopped,
}

/// Waits for a client on `instance`, or for the stop event.
fn connect(instance: &PipeInstance, stop: Handle) -> Result<Connect, String> {
    let ready = event(true)?;
    let mut overlapped = Overlapped::with_event(ready.raw());
    loop {
        overlapped.rearm();
        // SAFETY: the OVERLAPPED and its event outlive the operation: every
        // path below waits for it to complete.
        let ok = unsafe { ConnectNamedPipe(instance.raw(), &mut *overlapped) };
        if ok != 0 {
            return Ok(Connect::Connected);
        }
        match last_error() {
            ERROR_PIPE_CONNECTED => return Ok(Connect::Connected),
            // A client came and went before the accept: reuse the instance.
            ERROR_NO_DATA => {
                // SAFETY: a server end of our own.
                unsafe { DisconnectNamedPipe(instance.raw()) };
                continue;
            }
            ERROR_IO_PENDING => {}
            code => return Err(os_error("ConnectNamedPipe", code)),
        }
        let signalled = wait_any(&[stop, ready.raw()], INFINITE);
        let mut n = 0;
        if signalled != Ok(Some(1)) {
            // Stop, or a failed wait: cancel this connect and wait for it to
            // complete before the OVERLAPPED and its event are freed.
            // SAFETY: as above.
            unsafe {
                CancelIoEx(instance.raw(), &mut *overlapped);
                GetOverlappedResult(instance.raw(), &mut *overlapped, &mut n, 1);
            }
            return match signalled {
                Err(message) => Err(message),
                _ => Ok(Connect::Stopped),
            };
        }
        // SAFETY: the connect has completed.
        if unsafe { GetOverlappedResult(instance.raw(), &mut *overlapped, &mut n, 0) } != 0 {
            return Ok(Connect::Connected);
        }
        match last_error() {
            ERROR_PIPE_CONNECTED => return Ok(Connect::Connected),
            ERROR_NO_DATA => {
                // SAFETY: as above.
                unsafe { DisconnectNamedPipe(instance.raw()) };
            }
            code => return Err(os_error("ConnectNamedPipe", code)),
        }
    }
}

/// `stop` stays open until this returns.
fn accept_loop(shared: &Shared, stop: Handle, instances: &Arc<Instances>, first: PipeInstance) {
    let mut listening = first;
    loop {
        match connect(&listening, stop) {
            Ok(Connect::Connected) => {}
            Ok(Connect::Stopped) => return,
            Err(message) => return shared.fail(message),
        }
        // Sampled as the connect returns, before any slot wait, so the
        // peer's creation-time check spans only the accept latency.
        let accepted_at = now_ticks();
        // A slot for the conn. At the cap this waits up to AT_CAP_WAIT for an
        // accepted conn to close, while the connected instance keeps the
        // name and its client waits unserved. Past that, the client is
        // disconnected (it sees a broken pipe) and the same instance listens
        // again, so the name never disappears.
        if !instances.try_slot() {
            match wait_any(&[stop, instances.slots.raw()], AT_CAP_WAIT_MS) {
                Ok(Some(1)) => {}
                Ok(None) => {
                    // SAFETY: a server end of our own, with no I/O pending.
                    unsafe { DisconnectNamedPipe(listening.raw()) };
                    continue;
                }
                Ok(_) => return,
                Err(message) => return shared.fail(message),
            }
        }
        let mut accepted = listening;
        accepted.holds_slot = true;
        // The next listening instance exists before this one is handed off.
        let next = instances.create();
        let (peer, process) = read_peer(
            accepted.raw(),
            accepted_at,
            &instances.own_user,
            instances.own_session,
        );
        let notify = shared
            .notify
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match notify.map(|notify| Conn::start(accepted, peer, process, notify)) {
            Some(Ok(conn)) => {
                let mut accepted = shared.accepted.lock().unwrap_or_else(|p| p.into_inner());
                if shared.closed.load(Ordering::Acquire) {
                    // close() has drained the queue already: nobody takes it.
                    drop(accepted);
                    conn.destroy();
                    shared
                        .discarded
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(conn);
                    return;
                }
                accepted.push_back(conn);
                drop(accepted);
                shared.wake();
            }
            Some(Err(message)) => return shared.fail(message),
            None => return,
        }
        match next {
            Ok(instance) => listening = instance,
            Err(e) => return shared.fail(e.to_string()),
        }
        if shared.closed.load(Ordering::Acquire) {
            return;
        }
    }
}
