//! macOS backend. The walk is one `sysctl(KERN_PROC_ALL)`, the table `ps`
//! reads: pid, parent and short name for every process, another user's
//! included. (`proc_pidinfo(PROC_PIDTBSDINFO)` refuses processes of other
//! users, launchd among them, so it cannot be the walk.)

use super::ProcessRow;

/// One `struct kinfo_proc` (64-bit layout, arm64 and x86_64).
const KINFO_SIZE: usize = 648;
const KINFO_PID: usize = 40;
const KINFO_COMM: usize = 243;
const KINFO_COMM_LEN: usize = 17;
const KINFO_PPID: usize = 560;
/// kp_eproc.e_ucred.cr_uid: the effective uid.
const KINFO_UID: usize = 420;

fn read_i32(buf: &[u8], at: usize) -> i32 {
    i32::from_ne_bytes(buf[at..at + 4].try_into().unwrap())
}

/// The rows of a `KERN_PROC_*` read, each with its effective uid. A
/// partial trailing record is ignored.
pub(super) fn parse_kinfo(buf: &[u8]) -> Vec<(ProcessRow, u32)> {
    buf.as_chunks::<KINFO_SIZE>()
        .0
        .iter()
        .map(|r| {
            let comm = &r[KINFO_COMM..KINFO_COMM + KINFO_COMM_LEN];
            let len = comm.iter().position(|&b| b == 0).unwrap_or(comm.len());
            let row = ProcessRow {
                pid: read_i32(r, KINFO_PID) as u32,
                ppid: read_i32(r, KINFO_PPID) as u32,
                name: String::from_utf8_lossy(&comm[..len]).into_owned(),
                created: None,
                cmdline: None,
            };
            (row, read_i32(r, KINFO_UID) as u32)
        })
        .collect()
}

#[cfg(target_os = "macos")]
pub use sys::{snapshot, walk};

#[cfg(target_os = "macos")]
mod sys {
    use super::super::ProcessRow;
    use super::{parse_kinfo, KINFO_SIZE};
    use std::ffi::{c_int, c_uint, c_void};

    const CTL_KERN: c_int = 1;
    const KERN_PROC: c_int = 14;
    const KERN_PROC_ALL: c_int = 0;
    const ENOMEM: i32 = 12;

    extern "C" {
        fn sysctl(
            name: *mut c_int,
            namelen: c_uint,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }

    fn last_errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    /// Walk the process table: pid, parent and name. macOS reads no details
    /// (creation time, command line); `_with_details` is accepted for the
    /// shared signature.
    pub fn snapshot(_with_details: bool) -> Result<Vec<ProcessRow>, String> {
        Ok(walk()?.into_iter().map(|(row, _)| row).collect())
    }

    /// Every process with its effective uid, from one `KERN_PROC_ALL` read.
    /// The table can grow between the size query and the read (ENOMEM); that
    /// read is retried rather than returned short, since a cut table reads
    /// pids as gone.
    pub fn walk() -> Result<Vec<(ProcessRow, u32)>, String> {
        let mut mib = [CTL_KERN, KERN_PROC, KERN_PROC_ALL];
        for _ in 0..4 {
            let mut len = 0usize;
            // SAFETY: a null buffer asks only for the size.
            let status = unsafe {
                sysctl(
                    mib.as_mut_ptr(),
                    3,
                    std::ptr::null_mut(),
                    &mut len,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if status != 0 {
                return Err(format!(
                    "sysctl(KERN_PROC_ALL) size failed (errno {})",
                    last_errno()
                ));
            }
            let mut buf = vec![0u8; len + 64 * KINFO_SIZE];
            len = buf.len();
            // SAFETY: `buf` is `len` bytes long and writable.
            let status = unsafe {
                sysctl(
                    mib.as_mut_ptr(),
                    3,
                    buf.as_mut_ptr().cast(),
                    &mut len,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if status == 0 {
                buf.truncate(len);
                return Ok(parse_kinfo(&buf));
            }
            let errno = last_errno();
            if errno != ENOMEM {
                return Err(format!("sysctl(KERN_PROC_ALL) failed (errno {errno})"));
            }
        }
        Err("sysctl(KERN_PROC_ALL) kept growing".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pid: i32, ppid: i32, comm: &[u8]) -> Vec<u8> {
        let mut r = vec![0u8; KINFO_SIZE];
        r[KINFO_UID..KINFO_UID + 4].copy_from_slice(&(500 + pid).to_ne_bytes());
        r[KINFO_PID..KINFO_PID + 4].copy_from_slice(&pid.to_ne_bytes());
        r[KINFO_PPID..KINFO_PPID + 4].copy_from_slice(&ppid.to_ne_bytes());
        r[KINFO_COMM..KINFO_COMM + comm.len()].copy_from_slice(comm);
        r
    }

    #[test]
    fn kinfo_records_parse() {
        let mut buf = record(1, 0, b"launchd");
        buf.extend(record(4242, 1, b"0123456789abcdef"));
        // A partial record (the table cut mid-entry) is not a row.
        buf.extend(&record(7, 1, b"cut")[..100]);
        let rows = parse_kinfo(&buf);
        assert_eq!(
            rows.iter()
                .map(|(r, uid)| (r.pid, r.ppid, r.name.as_str(), *uid))
                .collect::<Vec<_>>(),
            vec![(1, 0, "launchd", 501), (4242, 1, "0123456789abcdef", 4742)]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn snapshot_reads_own_row_and_other_users() {
        extern "C" {
            fn geteuid() -> u32;
        }
        let rows = snapshot(false).expect("snapshot");
        let me = std::process::id();
        let own = rows.iter().find(|r| r.pid == me).expect("own row");
        assert!(rows.iter().any(|r| r.pid == own.ppid), "parent row present");
        let exe = std::env::current_exe().unwrap();
        let file = exe.file_name().unwrap().to_string_lossy().to_string();
        assert!(file.starts_with(&own.name) && !own.name.is_empty());
        // Another user's process is walked too.
        let launchd = rows.iter().find(|r| r.pid == 1).expect("launchd row");
        assert_eq!((launchd.name.as_str(), launchd.ppid), ("launchd", 0));
        assert!(rows
            .iter()
            .all(|r| r.created.is_none() && r.cmdline.is_none()));
        // The walk's uid is the effective uid.
        let walked = walk().expect("walk");
        let uid_of = |pid| walked.iter().find(|(r, _)| r.pid == pid).map(|(_, u)| *u);
        // SAFETY: geteuid has no preconditions.
        assert_eq!(uid_of(me), Some(unsafe { geteuid() }));
        assert_eq!(uid_of(1), Some(0));
    }
}
