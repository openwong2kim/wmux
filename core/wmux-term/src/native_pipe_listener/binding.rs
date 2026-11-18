//! N-API surface: NativePipeListener, NativePipeConn and two test hooks.

use super::conn::{Conn, ReadResult};
use super::listener::{ListenError, Listener};
use super::Notify;
use crate::wake_gate::WakeGate;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// The JS wake callback: a non-weak threadsafe function with a queue of one,
/// gated so a surplus wake is never enqueued (see `wake_gate`).
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

fn wake(notify: Function<(), ()>) -> Result<Notify> {
    let gate = Arc::new(WakeGate::default());
    let dispatched = gate.clone();
    let wake = Wake {
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
    };
    Ok(Arc::new(move || wake.notify()))
}

/// Blocking teardown for the environment cleanup hook (a worker thread or
/// the process exiting): cancel, join and close what is still open.
trait Shutdown: Send + Sync {
    fn shutdown(&self);
}
impl Shutdown for Listener {
    fn shutdown(&self) {
        self.close_and_join();
    }
}
impl Shutdown for Conn {
    fn shutdown(&self) {
        self.destroy_and_join();
    }
}

type Registry = Mutex<HashMap<usize, Vec<Weak<dyn Shutdown>>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// Tracks an object for its environment's cleanup; one hook per environment.
fn track(env: &Env, item: Weak<dyn Shutdown>) {
    let key = env.raw() as usize;
    let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
    let first = !map.contains_key(&key);
    let items = map.entry(key).or_default();
    items.retain(|item| item.strong_count() > 0);
    items.push(item);
    drop(map);
    if first {
        let added = env.add_env_cleanup_hook(key, |key| {
            let items = registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key)
                .unwrap_or_default();
            for item in items {
                if let Some(item) = item.upgrade() {
                    item.shutdown();
                }
            }
        });
        if added.is_err() {
            registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key);
        }
    }
}

#[napi]
pub struct NativePipeListener {
    inner: Arc<Listener>,
}

#[napi]
impl NativePipeListener {
    /// Listens on `name` (\\.\pipe\...) with at most `max_instances`
    /// instances (pending + accepted). Throws with code EADDRINUSE when the
    /// name already exists.
    #[napi(constructor, catch_unwind)]
    pub fn new(
        env: Env,
        name: String,
        max_instances: u32,
        notify: Function<(), ()>,
    ) -> Result<Self> {
        let notify = wake(notify)?;
        match Listener::bind(&name, max_instances, notify) {
            Ok(inner) => {
                let weak: Weak<dyn Shutdown> = Arc::downgrade(&inner) as Weak<Listener>;
                track(&env, weak);
                Ok(Self { inner })
            }
            Err(ListenError::AddressInUse(message)) => {
                env.throw_error(&message, Some("EADDRINUSE"))?;
                Err(Error::new(Status::PendingException, message))
            }
            Err(ListenError::Other(message)) => Err(Error::from_reason(message)),
        }
    }

    #[napi(catch_unwind)]
    pub fn take_accepted(&self, env: Env) -> Option<NativePipeConn> {
        let inner = self.inner.take_accepted()?;
        let weak: Weak<dyn Shutdown> = Arc::downgrade(&inner) as Weak<Conn>;
        track(&env, weak);
        Some(NativePipeConn { inner })
    }

    /// Why accepting stopped, if it did.
    #[napi(catch_unwind)]
    pub fn failure(&self) -> Option<String> {
        self.inner.failure()
    }

    #[napi(catch_unwind)]
    pub fn close(&self) {
        self.inner.close();
    }
}

#[napi(object, use_nullable = true)]
pub struct NativePipePeer {
    pub pid: u32,
    pub session_id: u32,
    pub same_session: bool,
    pub same_user: Option<bool>,
    pub integrity_rid: Option<u32>,
    /// Peer creation time, Unix-epoch ms.
    pub created: f64,
    pub ppid: Option<u32>,
    pub reason: Option<String>,
}

#[napi]
pub struct NativePipeConn {
    inner: Arc<Conn>,
}

#[napi]
impl NativePipeConn {
    #[napi(catch_unwind)]
    pub fn peer(&self) -> NativePipePeer {
        let peer = self.inner.peer().clone();
        NativePipePeer {
            pid: peer.pid,
            session_id: peer.session_id,
            same_session: peer.same_session,
            same_user: peer.same_user,
            integrity_rid: peer.integrity_rid,
            created: peer.created,
            ppid: peer.ppid,
            reason: peer.reason,
        }
    }

    /// At most one outstanding read; wakes when done.
    #[napi(catch_unwind)]
    pub fn request_read(&self, max: u32) {
        self.inner.request_read(max as usize);
    }

    /// null = nothing yet; 'eof' once the client end is closed.
    #[napi(catch_unwind)]
    pub fn take_read(&self) -> Option<Either<Buffer, String>> {
        match self.inner.take_read()? {
            ReadResult::Data(bytes) => Some(Either::A(bytes.into())),
            ReadResult::Eof => Some(Either::B("eof".into())),
        }
    }

    /// Queues `data`; returns its write id.
    #[napi(catch_unwind)]
    pub fn write(&self, data: Uint8Array) -> u32 {
        self.inner.write(data.to_vec())
    }

    /// Ids whose write completed (or failed: see error()).
    #[napi(catch_unwind)]
    pub fn take_written(&self) -> Vec<u32> {
        self.inner.take_written()
    }

    #[napi(catch_unwind)]
    pub fn error(&self) -> Option<String> {
        self.inner.error()
    }

    /// Closes once queued writes complete; the client can still read what
    /// is buffered. Wakes when closed.
    #[napi(catch_unwind)]
    pub fn end(&self) {
        self.inner.end();
    }

    #[napi(catch_unwind)]
    pub fn closed(&self) -> bool {
        self.inner.closed()
    }

    /// Cancels pending I/O and closes; idempotent.
    #[napi(catch_unwind)]
    pub fn destroy(&self) {
        self.inner.destroy();
    }
}

/// Test hook: running pipe worker threads.
#[napi(catch_unwind)]
pub fn native_pipe_worker_count() -> u32 {
    super::worker_count()
}

/// Test hook: this process's open handle count (GetProcessHandleCount).
#[napi(catch_unwind)]
pub fn native_pipe_handle_count() -> u32 {
    super::sys::process_handle_count()
}
