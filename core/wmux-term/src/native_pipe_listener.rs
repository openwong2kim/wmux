//! Owner-only named-pipe listener for Windows (capability `pipe-listener-v1`).
//!
//! Every instance is created with a protected DACL that grants access to this
//! process's user and SYSTEM only, owned by that user, not inheritable, and
//! rejecting remote clients. The first instance uses
//! FILE_FLAG_FIRST_PIPE_INSTANCE, so a name that already exists fails with
//! EADDRINUSE instead of joining another pipe. Each accepted instance reports
//! its peer's identity (pid, session, user, integrity level, parent).
//!
//! Threads: one accept thread per listener, one I/O thread per accepted
//! instance. Workers wake JS through one callback per listener (shared with
//! its instances); JS drains with the take*() calls. Blocking teardown (I/O
//! cancel + join) never runs on the JS thread, except in the environment
//! cleanup hook.
//!
//! The Win32 logic has no napi dependency, so plain `cargo test` runs it;
//! `binding` is the N-API surface.
#![cfg_attr(
    not(all(feature = "native-core", feature = "bindings")),
    allow(dead_code)
)]

mod conn;
mod listener;
mod peer;
mod security;
mod sys;

#[cfg(all(feature = "native-core", feature = "bindings"))]
mod binding;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// The wake callback: "something changed, drain with take*()".
pub(crate) type Notify = Arc<dyn Fn() + Send + Sync>;

static ACTIVE_WORKERS: AtomicU32 = AtomicU32::new(0);

/// Counts a running worker thread for its lifetime.
pub(crate) struct Worker;
impl Worker {
    pub(crate) fn enter() -> Self {
        ACTIVE_WORKERS.fetch_add(1, Ordering::AcqRel);
        Self
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        ACTIVE_WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) fn worker_count() -> u32 {
    ACTIVE_WORKERS.load(Ordering::Acquire)
}
