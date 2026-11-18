//! The accept side: pipe instances under one owner-only security
//! descriptor, an instance cap, and one accept thread.

use super::conn::Conn;
use super::peer::read_peer;
use super::security::{current_user, owner_only_sddl, SecurityDescriptor, Sid};
use super::sys::*;
use super::{Notify, Worker};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

/// The most instances a pipe name allows below PIPE_UNLIMITED_INSTANCES.
pub(crate) const MAX_INSTANCES: u32 = 254;

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
/// cap (a semaphore with one unit per instance) and the live count.
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

    /// Takes a slot without waiting; false at the cap.
    pub(super) fn try_slot(&self) -> bool {
        // SAFETY: a valid semaphore.
        unsafe { WaitForSingleObject(self.slots.raw(), 0) == WAIT_OBJECT_0 }
    }

    fn release_slot(&self) {
        // SAFETY: a valid semaphore; never released above its maximum since
        // every release pairs with a taken slot.
        unsafe { ReleaseSemaphore(self.slots.raw(), 1, std::ptr::null_mut()) };
    }

    /// Creates an instance in a slot the caller has taken; the slot is
    /// released on failure.
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
                self.max,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                &attributes,
            )
        };
        let Some(handle) = OwnedHandle::from_raw(raw) else {
            let code = last_error();
            drop(live);
            self.release_slot();
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
        })
    }
}

/// One pipe instance and its slot. Dropping it closes the handle without
/// DisconnectNamedPipe or FlushFileBuffers: the client can still read what
/// is buffered, then sees ERROR_BROKEN_PIPE.
pub(crate) struct PipeInstance {
    handle: Option<OwnedHandle>,
    owner: Arc<Instances>,
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
        self.owner.release_slot();
    }
}

struct Shared {
    /// Manual-reset stop signal; closed by the accept thread as it exits.
    stop: Mutex<Option<OwnedHandle>>,
    accepted: Mutex<VecDeque<Arc<Conn>>>,
    failure: Mutex<Option<String>>,
    closed: AtomicBool,
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
        if !instances.try_slot() {
            return Err(ListenError::Other("no instance slot".into()));
        }
        let first = instances.create()?;
        let shared = Arc::new(Shared {
            stop: Mutex::new(Some(event(true).map_err(ListenError::Other)?)),
            accepted: Mutex::new(VecDeque::new()),
            failure: Mutex::new(None),
            closed: AtomicBool::new(false),
            notify: Mutex::new(Some(notify)),
        });
        let worker_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("wmux-pipe-accept".into())
            .spawn(move || {
                let _worker = Worker::enter();
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

    /// Stops accepting and closes the pending instance; the join runs off
    /// the caller's thread. Taken conns stay open; conns not taken by then
    /// are destroyed, so none is left holding the wake callback.
    pub(crate) fn close(&self) {
        if !self.signal_close() {
            return;
        }
        let thread = self.take_thread();
        let shared = self.shared.clone();
        let _ = std::thread::Builder::new()
            .name("wmux-pipe-join".into())
            .spawn(move || {
                let _worker = Worker::enter();
                if let Some(thread) = thread {
                    let _ = thread.join();
                }
                destroy_untaken(&shared);
            });
    }

    /// As `close`, joining on the caller's thread; also destroys conns not
    /// taken yet.
    pub(crate) fn close_and_join(&self) {
        self.signal_close();
        if let Some(thread) = self.take_thread() {
            let _ = thread.join();
        }
        destroy_untaken(&self.shared);
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

fn destroy_untaken(shared: &Shared) {
    loop {
        let conn = shared
            .accepted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop_front();
        match conn {
            Some(conn) => conn.destroy_and_join(),
            None => break,
        }
    }
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
        let signalled = wait_any(&[stop, ready.raw()], INFINITE)?;
        let mut n = 0;
        if signalled == Some(0) {
            // SAFETY: cancels this connect, then waits for it to complete.
            unsafe {
                CancelIoEx(instance.raw(), &mut *overlapped);
                GetOverlappedResult(instance.raw(), &mut *overlapped, &mut n, 1);
            }
            return Ok(Connect::Stopped);
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
    let mut next = Some(first);
    loop {
        let instance = match next.take() {
            Some(instance) => instance,
            None => {
                // At the cap: wait for a slot (an instance closing) or stop.
                match wait_any(&[stop, instances.slots.raw()], INFINITE) {
                    Ok(Some(1)) => {}
                    Ok(_) => return,
                    Err(message) => return shared.fail(message),
                }
                match instances.create() {
                    Ok(instance) => instance,
                    Err(e) => return shared.fail(e.to_string()),
                }
            }
        };
        match connect(&instance, stop) {
            Ok(Connect::Connected) => {}
            Ok(Connect::Stopped) => return,
            Err(message) => return shared.fail(message),
        }
        let accepted_at = now_ticks();
        // The next instance exists before this one is handed off, unless
        // the cap is reached (then it is created once a slot frees).
        let mut create_failed = None;
        if instances.try_slot() {
            match instances.create() {
                Ok(instance) => next = Some(instance),
                Err(e) => create_failed = Some(e.to_string()),
            }
        }
        let (peer, process) = read_peer(
            instance.raw(),
            accepted_at,
            &instances.own_user,
            instances.own_session,
        );
        let notify = shared
            .notify
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match notify.map(|notify| Conn::start(instance, peer, process, notify)) {
            Some(Ok(conn)) => {
                shared
                    .accepted
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push_back(conn);
                shared.wake();
            }
            Some(Err(message)) => return shared.fail(message),
            None => return,
        }
        if let Some(message) = create_failed {
            return shared.fail(message);
        }
        if shared.closed.load(Ordering::Acquire) {
            return;
        }
    }
}
