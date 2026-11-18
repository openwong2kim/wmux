//! The connected client's own token (capability `pipe-listener-v2`).
//!
//! Each request runs on a dedicated short-lived thread, never on the conn's
//! I/O thread: it impersonates the client, opens the thread token, and
//! reverts before it reads anything from that token. The revert runs in a
//! guard's Drop, so it also runs when the call panics; a revert that fails
//! aborts the process, since no thread may keep running as the client. The
//! thread holds the pipe instance for the whole call, so the I/O thread
//! closing the conn cannot close the handle under it.

use super::listener::PipeInstance;
use super::security::{token_elevated, token_integrity_rid, token_user, Sid};
use super::sys::*;
use super::Worker;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const NO_READ_YET: &str = "no-read-yet";
pub(crate) const IMPERSONATION_FAILED: &str = "impersonation-failed";
pub(crate) const TOKEN_UNREADABLE: &str = "token-unreadable";
pub(crate) const CLOSED: &str = "closed";

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TokenFacts {
    Read {
        same_user: bool,
        /// The RID of the client token's mandatory integrity label.
        integrity_rid: u32,
        elevated: bool,
    },
    /// One of NO_READ_YET, IMPERSONATION_FAILED, TOKEN_UNREADABLE, CLOSED.
    Unavailable(&'static str),
}

/// What a token thread hands back.
pub(crate) struct TokenOutcome {
    pub facts: TokenFacts,
    /// The thread's own OpenThreadToken error after the revert
    /// (ERROR_NO_TOKEN when it runs as this process again).
    #[cfg(test)]
    pub thread_token_after: u32,
}

/// The calling thread is impersonating while this lives; Drop reverts it.
struct Impersonating;

impl Drop for Impersonating {
    fn drop(&mut self) {
        // SAFETY: no preconditions; reverting a thread that does not
        // impersonate succeeds as well.
        if unsafe { RevertToSelf() } == 0 {
            // The thread would go on as the client: stop the process.
            std::process::abort();
        }
    }
}

/// Reads the client token of a connected server end. Must run on a thread
/// that does nothing else, after at least one read from the pipe completed.
pub(crate) fn read_client_token(pipe: Handle, own_user: &Sid) -> TokenFacts {
    let token = {
        let _impersonating = Impersonating;
        // SAFETY: a connected server end, held open by the caller.
        if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
            return TokenFacts::Unavailable(IMPERSONATION_FAILED);
        }
        let mut raw: Handle = std::ptr::null_mut();
        // OpenAsSelf: the open is checked against this process, so a
        // client that allows identification only can still be read.
        // SAFETY: the current-thread pseudo handle; writes one handle.
        let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) };
        (opened != 0).then(|| OwnedHandle::from_raw(raw)).flatten()
        // Reverted here, before the token is read.
    };
    let Some(token) = token else {
        // Includes a client that connected at the anonymous level.
        return TokenFacts::Unavailable(TOKEN_UNREADABLE);
    };
    let facts = (|| {
        let same_user = token_user(token.raw()).ok()?.equals(own_user);
        let integrity_rid = token_integrity_rid(token.raw()).ok()?;
        let elevated = token_elevated(token.raw()).ok()?;
        Some(TokenFacts::Read {
            same_user,
            integrity_rid,
            elevated,
        })
    })();
    facts.unwrap_or(TokenFacts::Unavailable(TOKEN_UNREADABLE))
}

/// Starts a token thread for `instance`; `done` runs on it with the result.
/// `delay` (tests) holds the thread before it impersonates.
pub(crate) fn spawn_read(
    instance: Arc<PipeInstance>,
    delay: Option<Duration>,
    done: impl FnOnce(TokenOutcome) + Send + 'static,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("wmux-pipe-token".into())
        .spawn(move || {
            // Dropped last: a worker count back at its baseline means the
            // result is stored.
            let _worker = Worker::enter();
            if let Some(delay) = delay {
                std::thread::sleep(delay);
            }
            let facts = catch_unwind(AssertUnwindSafe(|| {
                read_client_token(instance.raw(), instance.own_user())
            }))
            .unwrap_or(TokenFacts::Unavailable(TOKEN_UNREADABLE));
            drop(instance);
            done(TokenOutcome {
                facts,
                #[cfg(test)]
                thread_token_after: thread_token_error(),
            });
        })
        .map(drop)
        .map_err(|e| e.to_string())
}

/// The calling thread's OpenThreadToken error: ERROR_NO_TOKEN when it does
/// not impersonate, 0 when it does.
#[cfg(test)]
pub(crate) fn thread_token_error() -> u32 {
    let mut raw: Handle = std::ptr::null_mut();
    // SAFETY: the current-thread pseudo handle; writes one handle.
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
        return last_error();
    }
    drop(OwnedHandle::from_raw(raw));
    0
}

/// Lets the panic test drive the guard on its own thread.
#[cfg(test)]
pub(crate) fn impersonating_guard() -> impl Drop {
    Impersonating
}
