//! Stops command hosts that earlier agent-desktop versions left running.

use std::mem::{MaybeUninit, size_of};

use super::process_arguments::{
    PROC_UID_ONLY, argument_buffer, arguments, list_pids, read_arguments,
};

const HOST_MARKER: &[u8] = b"AGENT_DESKTOP_INTERNAL_COMMAND_HOST=1";
const CS_OPS_IDENTITY: u32 = 11;
const IDENTITY_BUFFER_LEN: usize = 512;
const BLOB_HEADER_LEN: usize = 8;

unsafe extern "C" {
    fn csops(
        pid: libc::pid_t,
        ops: u32,
        useraddr: *mut libc::c_void,
        usersize: usize,
    ) -> libc::c_int;
}

/// Sends SIGKILL to this user's agent-desktop processes whose environment carries the old command
/// host marker. A process whose owner, start time, environment or code-signing identifier cannot be
/// read, or whose identifier is not agent-desktop's, is left alone.
pub fn stop_legacy_command_hosts() {
    let uid = unsafe { libc::geteuid() };
    let own_pid = std::process::id() as libc::pid_t;
    let Some(mut buffer) = argument_buffer() else {
        return;
    };
    for pid in list_pids(PROC_UID_ONLY, uid).unwrap_or_default() {
        if pid <= 0 || pid == own_pid || !has_marker(pid, &mut buffer) {
            continue;
        }
        let Some(started_at) = process_start_time(pid, uid) else {
            continue;
        };
        if !is_agent_desktop(pid) {
            continue;
        }
        if has_marker(pid, &mut buffer) && process_start_time(pid, uid) == Some(started_at) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// Whether a `KERN_PROCARGS2` buffer carries the host marker in its environment,
/// skipping the executable path and arguments that precede it.
pub(crate) fn environment_has_marker(procargs: &[u8]) -> bool {
    let Some((arguments, mut rest)) = arguments(procargs) else {
        return false;
    };
    for _ in 0..arguments {
        let Some(end) = rest.iter().position(|byte| *byte == 0) else {
            return false;
        };
        rest = &rest[end + 1..];
    }
    while let Some(end) = rest.iter().position(|byte| *byte == 0) {
        let entry = &rest[..end];
        if entry.is_empty() {
            break;
        }
        if entry == HOST_MARKER {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}

/// Whether a `CS_OPS_IDENTITY` blob names an agent-desktop build: an 8-byte big-endian magic and
/// length header followed by the NUL-terminated identifier.
fn blob_names_agent_desktop(blob: &[u8]) -> bool {
    let Some(identifier) = blob.get(BLOB_HEADER_LEN..) else {
        return false;
    };
    let Some(end) = identifier.iter().position(|byte| *byte == 0) else {
        return false;
    };
    let identifier = &identifier[..end];
    identifier == b"agent-desktop" || identifier.starts_with(b"agent_desktop-")
}

fn is_agent_desktop(pid: libc::pid_t) -> bool {
    let mut blob = [0u8; IDENTITY_BUFFER_LEN];
    let read = unsafe { csops(pid, CS_OPS_IDENTITY, blob.as_mut_ptr().cast(), blob.len()) };
    read == 0 && blob_names_agent_desktop(&blob)
}

fn process_start_time(pid: libc::pid_t, uid: libc::uid_t) -> Option<(u64, u64)> {
    let info = process_info(pid)?;
    (info.pbi_pid == pid as u32 && info.pbi_uid == uid && info.pbi_status != libc::SZOMB)
        .then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

fn process_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    (read == size).then(|| unsafe { info.assume_init() })
}

fn has_marker(pid: libc::pid_t, buffer: &mut [u8]) -> bool {
    read_arguments(pid, buffer).is_some_and(environment_has_marker)
}

#[cfg(test)]
#[path = "legacy_host_tests.rs"]
mod tests;
