//! Linux backend: one stat line per `/proc/<pid>` directory, for pid, parent
//! and name. A process that exits between the listing and its read, or whose
//! stat this user may not read (hidepid, an LSM), is left out; any other
//! failed read fails the walk, since a table cut short would read every
//! missing pid as gone.

use super::ProcessRow;
use std::io;

/// Parse a `/proc/<pid>/stat` line into (name, ppid). The name sits in
/// parentheses and may itself hold spaces and `)`, so fields are counted
/// from the last `)`.
pub(super) fn parse_stat(stat: &[u8]) -> Option<(String, u32)> {
    let open = stat.iter().position(|&b| b == b'(')?;
    let close = stat.iter().rposition(|&b| b == b')')?;
    if close < open {
        return None;
    }
    let name = String::from_utf8_lossy(&stat[open + 1..close]).into_owned();
    // After the name: state (field 3), then ppid (field 4).
    let ppid = std::str::from_utf8(&stat[close + 1..])
        .ok()?
        .split_ascii_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some((name, ppid))
}

/// Whether a failed read under `/proc/<pid>` only means this process cannot
/// be read now (see unreadable_process). Judged by the errno alone: these are
/// Linux errno values, and on another OS (where the parsing tests also run)
/// the same raw numbers map to other ErrorKinds.
pub(super) fn unreadable(error: &io::Error) -> bool {
    error.raw_os_error().is_some_and(super::unreadable_process)
}

/// One row per pid, its stat line read with `read_stat`. A pid that exited,
/// whose stat this user may not read, or whose stat came back empty while it
/// was being reaped, is skipped; any other failure, or a stat line that does
/// not parse, is an error.
pub(super) fn walk(
    pids: impl IntoIterator<Item = u32>,
    mut read_stat: impl FnMut(u32) -> io::Result<Vec<u8>>,
) -> Result<Vec<ProcessRow>, String> {
    let mut rows = Vec::with_capacity(512);
    for pid in pids {
        let stat = match read_stat(pid) {
            Ok(stat) if stat.is_empty() => continue,
            Ok(stat) => stat,
            Err(e) if unreadable(&e) => continue,
            Err(e) => return Err(format!("read /proc/{pid}/stat failed ({e})")),
        };
        let (name, ppid) =
            parse_stat(&stat).ok_or_else(|| format!("unparsable /proc/{pid}/stat"))?;
        rows.push(ProcessRow {
            pid,
            ppid,
            name,
            created: None,
            cmdline: None,
        });
    }
    Ok(rows)
}

/// The pids `/proc` lists. A listing cut short is an error.
#[cfg(target_os = "linux")]
pub(super) fn proc_pids() -> Result<Vec<u32>, String> {
    let mut pids = Vec::with_capacity(512);
    for entry in std::fs::read_dir("/proc").map_err(|e| format!("read /proc failed ({e})"))? {
        let entry = entry.map_err(|e| format!("read /proc failed ({e})"))?;
        if let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse().ok()) {
            pids.push(pid);
        }
    }
    Ok(pids)
}

/// Walk `/proc`: pid, parent and name of every process. Linux reads no
/// details (creation time, command line); `_with_details` is accepted for the
/// shared signature.
#[cfg(target_os = "linux")]
pub fn snapshot(_with_details: bool) -> Result<Vec<ProcessRow>, String> {
    walk(proc_pids()?, stat_of)
}

#[cfg(target_os = "linux")]
pub(super) fn stat_of(pid: u32) -> io::Result<Vec<u8>> {
    std::fs::read(format!("/proc/{pid}/stat"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_fields_count_from_the_last_parenthesis() {
        let line = b"4242 (we) ird (name)) S 77 4242 4242 0 -1 4194560 1 0 0 0 3 1 0 0 20 0 1 0 98765 1000 100 \n";
        assert_eq!(parse_stat(line), Some(("we) ird (name)".into(), 77)));
        assert_eq!(parse_stat(b"12 (short) S"), None);
        assert_eq!(parse_stat(b"no parens"), None);
    }

    fn stat(name: &str, ppid: u32) -> Vec<u8> {
        format!("1 ({name}) S {ppid} 1 1 0 -1").into_bytes()
    }

    #[test]
    fn an_exited_or_unreadable_process_is_skipped() {
        let read = |pid: u32| match pid {
            1 => Ok(stat("init", 0)),
            2 => Err(io::Error::from_raw_os_error(2)), // ENOENT
            3 => Err(io::Error::from_raw_os_error(3)), // ESRCH
            4 => Ok(Vec::new()),                       // reaped mid-read
            5 => Err(io::Error::from_raw_os_error(13)), // EACCES: hidepid
            6 => Err(io::Error::from_raw_os_error(1)), // EPERM: an LSM
            _ => Ok(stat("zsh", 1)),
        };
        let rows = walk([1, 2, 3, 4, 5, 6, 7], read).expect("walk");
        assert_eq!(
            rows.iter()
                .map(|r| (r.pid, r.ppid, r.name.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, 0, "init"), (7, 1, "zsh")]
        );
    }

    #[test]
    fn any_other_failure_fails_the_walk() {
        // EMFILE, ENFILE, EIO: the process may well be alive, so a table
        // without it would read it as dead.
        for errno in [24, 23, 5] {
            let read = |pid: u32| {
                if pid == 2 {
                    Err(io::Error::from_raw_os_error(errno))
                } else {
                    Ok(stat("zsh", 1))
                }
            };
            assert!(walk([1, 2, 3], read).is_err(), "errno {errno}");
        }
        assert!(walk([1], |_| Ok(b"garbage".to_vec())).is_err());
        // Judged by the Linux errno alone, never by ErrorKind.
        assert!(walk([1], |_| Err(io::Error::from(io::ErrorKind::NotFound))).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn snapshot_reads_own_row() {
        let rows = snapshot(false).expect("snapshot");
        let me = std::process::id();
        let own = rows.iter().find(|r| r.pid == me).expect("own row");
        assert!(rows.iter().any(|r| r.pid == own.ppid), "parent row present");
        assert!(rows.iter().any(|r| r.pid == 1));
        let exe = std::env::current_exe().unwrap();
        let file = exe.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            file.starts_with(&own.name),
            "comm is the first 15 bytes of the image"
        );
        assert!(rows
            .iter()
            .all(|r| r.created.is_none() && r.cmdline.is_none()));
    }
}
