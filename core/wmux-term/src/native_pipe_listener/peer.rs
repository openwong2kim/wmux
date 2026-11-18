//! Facts about the process at the client end of an accepted pipe instance.
//!
//! The peer's process handle is opened right after the accept and held for
//! the session, so its pid cannot name another process while the session
//! lasts. The pid is only trusted when the process behind the handle was
//! created no later than the accept.

use super::security::{open_token, token_integrity_rid, token_user, Sid};
use super::sys::*;
use std::ffi::c_void;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PeerFacts {
    pub pid: u32,
    pub session_id: u32,
    pub same_session: bool,
    /// None when the peer's token cannot be read.
    pub same_user: Option<bool>,
    /// The RID of the peer's mandatory integrity label (0x2000 = Medium).
    pub integrity_rid: Option<u32>,
    /// Peer creation time, Unix-epoch ms (0 when unreadable).
    pub created: f64,
    /// The parent pid, only when the parent is alive and was created no
    /// later than the peer.
    pub ppid: Option<u32>,
    /// Why some facts are missing: 'process-unreadable',
    /// 'created-after-accept' or 'token-unreadable'.
    pub reason: Option<String>,
}

/// Whether a parent pid can be reported for a child: the process now
/// behind that pid must be alive and created no later than the child.
pub(crate) fn ppid_rule(parent_alive: bool, parent_created: u64, child_created: u64) -> bool {
    parent_alive && parent_created <= child_created
}

/// Reads the client's facts. Returns the peer's process handle to hold for
/// the session (None when it could not be opened or is not the peer).
pub(crate) fn read_peer(
    pipe: Handle,
    accepted_at: u64,
    own_user: &Sid,
    own_session: u32,
) -> (PeerFacts, Option<OwnedHandle>) {
    let pid = client_pid(pipe).unwrap_or(0);
    let mut session_id = u32::MAX;
    // SAFETY: a connected server end; writes one u32.
    unsafe { GetNamedPipeClientSessionId(pipe, &mut session_id) };
    let mut facts = PeerFacts {
        pid,
        session_id,
        same_session: session_id == own_session,
        same_user: None,
        integrity_rid: None,
        created: 0.0,
        ppid: None,
        reason: None,
    };
    // SAFETY: plain open; a failure returns null.
    let process = (pid != 0)
        .then(|| unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
        .and_then(OwnedHandle::from_raw);
    let Some((process, created)) = process
        .and_then(|p| process_created(p.raw()).map(|created| (p, created)))
        // The pipe still names the same client once its process is open.
        .filter(|_| client_pid(pipe) == Some(pid))
    else {
        facts.reason = Some("process-unreadable".into());
        return (facts, None);
    };
    if created > accepted_at {
        // The connecting process exited and its pid was reused.
        facts.reason = Some("created-after-accept".into());
        return (facts, None);
    }
    facts.created = epoch_ms(created);
    facts.ppid = parent_pid(process.raw(), created);
    match open_token(process.raw()) {
        Ok(token) => {
            facts.same_user = Some(token_user(token.raw()).is_ok_and(|sid| sid.equals(own_user)));
            facts.integrity_rid = token_integrity_rid(token.raw()).ok();
        }
        Err(_) => facts.reason = Some("token-unreadable".into()),
    }
    (facts, Some(process))
}

fn client_pid(pipe: Handle) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: a server end of our own; writes one u32.
    let ok = unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) };
    (ok != 0 && pid != 0).then_some(pid)
}

/// The parent pid by the creation-time rule, read from the process's own
/// basic information (advisory: a same-user process may name any parent).
fn parent_pid(process: Handle, child_created: u64) -> Option<u32> {
    let query = nt_query_information_process()?;
    // SAFETY: a zeroed POD struct of the documented layout.
    let mut info: ProcessBasicInformation = unsafe { std::mem::zeroed() };
    let mut len = 0u32;
    // SAFETY: the buffer is exactly one PROCESS_BASIC_INFORMATION.
    let status = unsafe {
        query(
            process,
            PROCESS_BASIC_INFORMATION_CLASS,
            (&mut info as *mut ProcessBasicInformation).cast::<c_void>(),
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            &mut len,
        )
    };
    if status < 0 {
        return None;
    }
    let ppid = u32::try_from(info.inherited_from_unique_process_id).ok()?;
    if ppid == 0 {
        return None;
    }
    // SAFETY: plain open; a failure returns null.
    let parent =
        OwnedHandle::from_raw(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, ppid) })?;
    let mut code = 0u32;
    // SAFETY: writes one u32.
    let alive = unsafe { GetExitCodeProcess(parent.raw(), &mut code) } != 0 && code == STILL_ACTIVE;
    let parent_created = process_created(parent.raw())?;
    ppid_rule(alive, parent_created, child_created).then_some(ppid)
}
