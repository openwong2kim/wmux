//! Reads process launch commands from the kernel with libproc and `KERN_PROCARGS2`.

use agent_desktop_core::{AdapterError, ErrorCode};
use std::mem::size_of;
use std::time::Instant;

pub(crate) const PROC_ALL_PIDS: u32 = 1;
pub(crate) const PROC_UID_ONLY: u32 = 4;

/// Calls `visit` with the pid and launch command (`argv[0]`, the value `ps -o comm` prints) of
/// every process whose arguments are readable. Processes that exit during the walk, zombies and
/// processes of other users have no readable arguments and are skipped.
pub(crate) fn visit_commands_until(
    deadline: Instant,
    mut visit: impl FnMut(libc::pid_t, &[u8]) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    let pids = require_pids(list_pids(PROC_ALL_PIDS, 0))?;
    let mut buffer = argument_buffer().ok_or_else(|| {
        listing_error("Could not read the kernel argument size limit".to_string())
    })?;
    for pid in pids {
        if Instant::now() >= deadline {
            return Err(AdapterError::timeout("process app inventory timed out"));
        }
        if let Some(command) = read_arguments(pid, &mut buffer).and_then(first_argument) {
            visit(pid, command)?;
        }
    }
    Ok(())
}

pub(crate) fn list_pids(kind: u32, info: u32) -> Option<Vec<libc::pid_t>> {
    let size = unsafe { libc::proc_listpids(kind, info, std::ptr::null_mut(), 0) };
    let size = usize::try_from(size).ok()?;
    let mut pids = vec![0; size / size_of::<libc::pid_t>() + 1];
    loop {
        let bytes = pids.len().checked_mul(size_of::<libc::pid_t>())?;
        let bytes = i32::try_from(bytes).ok()?;
        let written = unsafe { libc::proc_listpids(kind, info, pids.as_mut_ptr().cast(), bytes) };
        if written <= 0 {
            return None;
        }
        if written < bytes {
            pids.truncate(written as usize / size_of::<libc::pid_t>());
            return Some(pids);
        }
        pids.resize(pids.len() * 2, 0);
    }
}

pub(crate) fn argument_buffer() -> Option<Vec<u8>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut max: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut max as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    usize::try_from(max)
        .ok()
        .filter(|max| *max > 0)
        .map(|max| vec![0u8; max])
}

pub(crate) fn read_arguments(pid: libc::pid_t, buffer: &mut [u8]) -> Option<&[u8]> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buffer.len();
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0 && size <= buffer.len()).then_some(&buffer[..size])
}

/// Alignment of the first argument from the start of the executable path for 64-bit processes:
/// `exec_extract_strings` in XNU `bsd/kern/kern_exec.c` pads the path with NULs to it.
const EXEC_PATH_ALIGNMENT: usize = 8;

/// The argument count and the bytes from `argv[0]` onward of a `KERN_PROCARGS2` buffer: a
/// native-endian argument count, the NUL-terminated executable path, NUL padding to
/// `EXEC_PATH_ALIGNMENT`, then the arguments. The padding has a fixed length, so an empty
/// `argv[0]` is not mistaken for more padding.
pub(crate) fn arguments(procargs: &[u8]) -> Option<(usize, &[u8])> {
    let (count, strings) = procargs.split_first_chunk::<4>()?;
    let count = usize::try_from(i32::from_ne_bytes(*count))
        .ok()
        .filter(|count| *count > 0)?;
    let path_end = strings.iter().position(|byte| *byte == 0)?;
    let start = (path_end + 1).next_multiple_of(EXEC_PATH_ALIGNMENT);
    let padding = strings.get(path_end + 1..start)?;
    if padding.iter().any(|byte| *byte != 0) {
        return None;
    }
    Some((count, &strings[start..]))
}

/// The non-empty first argument of a `KERN_PROCARGS2` buffer.
pub(crate) fn first_argument(procargs: &[u8]) -> Option<&[u8]> {
    let (_, arguments) = arguments(procargs)?;
    let end = arguments.iter().position(|byte| *byte == 0)?;
    Some(&arguments[..end]).filter(|command| !command.is_empty())
}

fn require_pids(pids: Option<Vec<libc::pid_t>>) -> Result<Vec<libc::pid_t>, AdapterError> {
    pids.ok_or_else(|| listing_error("libproc could not list processes".to_string()))
}

fn listing_error(detail: String) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "process app inventory could not read the process list",
    )
    .with_suggestion("Retry after macOS finishes updating the process inventory")
    .with_platform_detail(detail)
    .with_details(serde_json::json!({
        "kind": "inventory_source",
        "source": "libproc",
        "retryable": true,
    }))
}

#[cfg(test)]
#[path = "process_arguments_tests.rs"]
mod tests;
