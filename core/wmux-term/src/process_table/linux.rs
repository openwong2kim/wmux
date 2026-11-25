//! Linux backend: one stat line per `/proc/<pid>` directory, for pid, parent
//! and name. A process that exits between the listing and its read, or whose
//! stat this user may not read (hidepid, an LSM), is left out; any other
//! failed read fails the walk, since a table cut short would read every
//! missing pid as gone. The table (`snapshot`) also takes state, groups and
//! start time from the same stat line, and with details one more read gives
//! the command line; a detail that cannot be read is left empty, never a
//! reason to drop the row. PortWatcher's walk (`walk`) reads none of them.

use super::{LinuxDetails, ProcessRow, ROWS};
use crate::fallible::{self, AllocFailed, CallError};
use std::io;

/// The pids `/proc` lists: one per process.
#[cfg(target_os = "linux")]
const PIDS: &str = "the /proc listing";
/// A `/proc/<pid>/stat` line.
#[cfg(target_os = "linux")]
const STAT: &str = "a /proc stat line";
/// A `/proc/<pid>/cmdline`.
#[cfg(target_os = "linux")]
const CMDLINE: &str = "a /proc command line";
/// `/proc/stat`, read for the boot time.
#[cfg(target_os = "linux")]
const SYSTEM_STAT: &str = "/proc/stat";

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

/// The detail fields of a stat line, counted from the last `)` as in
/// parse_stat: state (field 3), process group (5), the terminal's foreground
/// group (8) and the start in clock ticks after boot (22).
pub(super) fn parse_details(stat: &[u8]) -> Option<(LinuxDetails, u64)> {
    let close = stat.iter().rposition(|&b| b == b')')?;
    let mut fields = std::str::from_utf8(&stat[close + 1..])
        .ok()?
        .split_ascii_whitespace();
    let state = fields.next()?;
    if state.len() != 1 || !state.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    let pgid = fields.nth(1)?.parse().ok()?;
    let tpgid = fields.nth(2)?.parse().ok()?;
    let start_ticks = fields.nth(13)?.parse().ok()?;
    let details = LinuxDetails {
        state: state.into(),
        pgid,
        tpgid,
    };
    Some((details, start_ticks))
}

/// What turns a start in ticks into a time: the boot time (`btime` in
/// /proc/stat, epoch seconds) and the clock ticks per second. Read once per
/// snapshot, as `ps` reads them once per run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct BootClock {
    pub boot_secs: u64,
    pub ticks_per_sec: u64,
}

/// `btime` from a /proc/stat read.
pub(super) fn parse_btime(stat: &[u8]) -> Option<u64> {
    stat.split(|&b| b == b'\n')
        .find_map(|line| line.strip_prefix(b"btime "))
        .and_then(|secs| std::str::from_utf8(secs).ok()?.trim().parse().ok())
}

/// The start in epoch ms. Whole seconds of it are boot + floor(ticks / hz),
/// the second `ps -o lstart` prints.
pub(super) fn created_ms(clock: BootClock, start_ticks: u64) -> Option<f64> {
    if clock.ticks_per_sec == 0 {
        return None;
    }
    let after_boot = start_ticks.checked_mul(1000)? / clock.ticks_per_sec;
    Some(clock.boot_secs.checked_mul(1000)?.checked_add(after_boot)? as f64)
}

/// A command line as text: each byte of an invalid UTF-8 sequence becomes
/// `?`, in place, as `ps` prints it in a UTF-8 locale. Empty is None.
pub(super) fn cmdline_text(mut bytes: Vec<u8>) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let mut at = 0;
    while let Err(e) = std::str::from_utf8(&bytes[at..]) {
        let bad = at + e.valid_up_to();
        let end = e.error_len().map_or(bytes.len(), |n| bad + n);
        bytes[bad..end].fill(b'?');
        at = end;
    }
    // Every invalid byte was replaced above, so this cannot fail.
    String::from_utf8(bytes).ok()
}

/// Whether a failed read under `/proc/<pid>` only means this process cannot
/// be read now (see unreadable_process). Judged by the errno alone: these are
/// Linux errno values, and on another OS (where the parsing tests also run)
/// the same raw numbers map to other ErrorKinds.
pub(super) fn unreadable(error: &io::Error) -> bool {
    error.raw_os_error().is_some_and(super::unreadable_process)
}

/// One row per pid, its stat line read with `read_stat` (a refused buffer,
/// or the read's own result). A pid that exited, whose stat this user may
/// not read, or whose stat came back empty while it was being reaped, is
/// skipped; any other failure, a stat line that does not parse, or a
/// refused buffer is an error.
pub(super) fn walk(
    pids: impl IntoIterator<Item = u32>,
    read_stat: impl FnMut(u32) -> Result<io::Result<Vec<u8>>, AllocFailed>,
) -> Result<Vec<ProcessRow>, CallError> {
    walk_with(pids, read_stat, |_, _, _| Ok(()))
}

/// walk, with each row's details: state, groups and `created` (with
/// `clock`; None without one) from its stat line, and its command line read
/// with `read_cmdline` (an empty read is None). A command line that cannot be
/// read is None; only a refused buffer fails the walk.
pub(super) fn walk_details(
    pids: impl IntoIterator<Item = u32>,
    read_stat: impl FnMut(u32) -> Result<io::Result<Vec<u8>>, AllocFailed>,
    mut read_cmdline: impl FnMut(u32) -> Result<io::Result<Vec<u8>>, AllocFailed>,
    clock: Option<BootClock>,
) -> Result<Vec<ProcessRow>, CallError> {
    walk_with(pids, read_stat, |pid, stat, row| {
        let (details, start_ticks) = parse_details(stat)
            .ok_or_else(|| CallError::reason(format!("unparsable /proc/{pid}/stat")))?;
        row.linux = Some(details);
        row.created = clock.and_then(|clock| created_ms(clock, start_ticks));
        row.cmdline = read_cmdline(pid)?.ok().and_then(cmdline_text);
        Ok(())
    })
}

fn walk_with(
    pids: impl IntoIterator<Item = u32>,
    mut read_stat: impl FnMut(u32) -> Result<io::Result<Vec<u8>>, AllocFailed>,
    mut detail: impl FnMut(u32, &[u8], &mut ProcessRow) -> Result<(), CallError>,
) -> Result<Vec<ProcessRow>, CallError> {
    let mut rows = fallible::try_with_capacity(512, ROWS)?;
    for pid in pids {
        let stat = match read_stat(pid)? {
            Ok(stat) if stat.is_empty() => continue,
            Ok(stat) => stat,
            Err(e) if unreadable(&e) => continue,
            Err(e) => {
                return Err(CallError::reason(format!(
                    "read /proc/{pid}/stat failed ({e})"
                )))
            }
        };
        let (name, ppid) = parse_stat(&stat)
            .ok_or_else(|| CallError::reason(format!("unparsable /proc/{pid}/stat")))?;
        let mut row = ProcessRow {
            pid,
            ppid,
            name,
            created: None,
            cmdline: None,
            linux: None,
        };
        detail(pid, &stat, &mut row)?;
        fallible::try_reserve(&mut rows, 1, ROWS)?;
        rows.push(row);
    }
    Ok(rows)
}

/// The pids `/proc` lists. A listing cut short is an error.
#[cfg(target_os = "linux")]
pub(super) fn proc_pids() -> Result<Vec<u32>, CallError> {
    let failed = |e: io::Error| CallError::reason(format!("read /proc failed ({e})"));
    let mut pids = fallible::try_with_capacity(512, PIDS)?;
    for entry in std::fs::read_dir("/proc").map_err(failed)? {
        let entry = entry.map_err(failed)?;
        if let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse().ok()) {
            fallible::try_reserve(&mut pids, 1, PIDS)?;
            pids.push(pid);
        }
    }
    Ok(pids)
}

/// Walk `/proc`: pid, parent, name, state, groups and creation time of
/// every process, all from its stat line, and with `with_command_lines` its
/// command line too (walk_details). Without it no command line is read: that
/// read can wait on a process stuck in the kernel, and a stat line cannot.
#[cfg(target_os = "linux")]
pub fn snapshot(with_command_lines: bool) -> Result<Vec<ProcessRow>, CallError> {
    let clock = boot_clock()?;
    if with_command_lines {
        walk_details(proc_pids()?, stat_of, cmdline_of, clock)
    } else {
        walk_details(proc_pids()?, stat_of, |_| Ok(Ok(Vec::new())), clock)
    }
}

#[cfg(target_os = "linux")]
pub(super) fn stat_of(pid: u32) -> Result<io::Result<Vec<u8>>, AllocFailed> {
    super::read_file(std::path::Path::new(&format!("/proc/{pid}/stat")), STAT)
}

#[cfg(target_os = "linux")]
fn cmdline_of(pid: u32) -> Result<io::Result<Vec<u8>>, AllocFailed> {
    super::read_file(
        std::path::Path::new(&format!("/proc/{pid}/cmdline")),
        CMDLINE,
    )
}

/// This snapshot's boot clock; None when /proc/stat or the tick rate cannot
/// be read (every `created` is then None).
#[cfg(target_os = "linux")]
fn boot_clock() -> Result<Option<BootClock>, AllocFailed> {
    use std::ffi::{c_int, c_long};
    // The same value on glibc and musl.
    const SC_CLK_TCK: c_int = 2;
    extern "C" {
        fn sysconf(name: c_int) -> c_long;
    }
    let stat = super::read_file(std::path::Path::new("/proc/stat"), SYSTEM_STAT)?;
    let Some(boot_secs) = stat.ok().as_deref().and_then(parse_btime) else {
        return Ok(None);
    };
    // SAFETY: sysconf reads a constant and touches no memory of ours.
    let hz = unsafe { sysconf(SC_CLK_TCK) };
    Ok(u64::try_from(hz)
        .ok()
        .filter(|&hz| hz > 0)
        .map(|ticks_per_sec| BootClock {
            boot_secs,
            ticks_per_sec,
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_row_buffer_is_a_refusal_not_an_abort() {
        // The rows' first buffer holds 512 rows: an infallible one aborted here.
        let line = stat("zsh", 1);
        let rows =
            crate::test_allocator::refusing(4096, || walk([1, 2, 3], |_| Ok(Ok(line.clone()))));
        assert!(
            matches!(rows, Err(CallError::Alloc(AllocFailed { what: ROWS, .. }))),
            "{rows:?}"
        );
        // A refused stat buffer fails the walk too.
        let refused = AllocFailed {
            what: "a /proc stat line",
            bytes: 8192,
        };
        assert_eq!(walk([1], |_| Err(refused)), Err(CallError::Alloc(refused)));
    }

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
        let read = |pid: u32| {
            Ok(match pid {
                1 => Ok(stat("init", 0)),
                2 => Err(io::Error::from_raw_os_error(2)), // ENOENT
                3 => Err(io::Error::from_raw_os_error(3)), // ESRCH
                4 => Ok(Vec::new()),                       // reaped mid-read
                5 => Err(io::Error::from_raw_os_error(13)), // EACCES: hidepid
                6 => Err(io::Error::from_raw_os_error(1)), // EPERM: an LSM
                _ => Ok(stat("zsh", 1)),
            })
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
                Ok(if pid == 2 {
                    Err(io::Error::from_raw_os_error(errno))
                } else {
                    Ok(stat("zsh", 1))
                })
            };
            assert!(walk([1, 2, 3], read).is_err(), "errno {errno}");
        }
        assert!(walk([1], |_| Ok(Ok(b"garbage".to_vec()))).is_err());
        // Judged by the Linux errno alone, never by ErrorKind.
        assert!(walk([1], |_| Ok(Err(io::Error::from(io::ErrorKind::NotFound)))).is_err());
    }

    #[test]
    fn detail_fields_count_from_the_last_parenthesis() {
        // Fields 3 (state), 5 (pgid), 8 (tpgid), 22 (start ticks).
        let line = b"4242 (we) ird (name)) S 77 4200 4100 34816 -1 4194560 1 0 0 0 3 1 0 0 20 0 1 0 98765 1000 100 \n";
        let (details, ticks) = parse_details(line).expect("details");
        assert_eq!(
            details,
            LinuxDetails {
                state: "S".into(),
                pgid: 4200,
                tpgid: -1,
            }
        );
        assert_eq!(ticks, 98765);
        // Cut before field 22, a state that is no letter, a field that is no number.
        assert_eq!(
            parse_details(b"1 (a) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0"),
            None
        );
        assert_eq!(
            parse_details(b"1 (a) 7 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 5"),
            None
        );
        assert_eq!(
            parse_details(b"1 (a) S 0 x 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 5"),
            None
        );
    }

    #[test]
    fn created_is_boot_plus_ticks_and_floors_like_ps() {
        let clock = BootClock {
            boot_secs: 1_700_000_000,
            ticks_per_sec: 100,
        };
        assert_eq!(created_ms(clock, 250), Some(1_700_000_002_500.0));
        // 199 ticks is 1.99 s: lstart's whole second stays boot + 1.
        let ms = created_ms(clock, 199).unwrap();
        assert_eq!((ms / 1000.0).floor() as u64, 1_700_000_001);
        let zero = BootClock {
            ticks_per_sec: 0,
            ..clock
        };
        assert_eq!(created_ms(zero, 1), None);
        assert_eq!(created_ms(clock, u64::MAX), None);
        assert_eq!(
            parse_btime(b"cpu  1 2 3\nintr 9\nbtime 1700000000\nprocesses 5\n"),
            Some(1_700_000_000)
        );
        assert_eq!(parse_btime(b"cpu  1 2 3\n"), None);
    }

    #[test]
    fn each_invalid_utf8_byte_reads_as_a_question_mark() {
        assert_eq!(cmdline_text(Vec::new()), None);
        // NULs and newlines stay for the args rule; only invalid UTF-8 changes.
        assert_eq!(
            cmdline_text(b"sh\0-c\0a\nb\0".to_vec()).as_deref(),
            Some("sh\0-c\0a\nb\0")
        );
        assert_eq!(
            cmdline_text("caf\u{e9}".into()).as_deref(),
            Some("caf\u{e9}")
        );
        assert_eq!(
            cmdline_text(b"a\xffb\xe2\x82c".to_vec()).as_deref(),
            Some("a?b??c")
        );
        // A sequence cut off at the end.
        assert_eq!(cmdline_text(b"x\xe2\x82".to_vec()).as_deref(), Some("x??"));
    }

    fn full_stat(name: &str, ppid: u32) -> Vec<u8> {
        format!("1 ({name}) S {ppid} 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 500 0 0").into_bytes()
    }

    #[test]
    fn a_command_line_that_cannot_be_read_keeps_the_row() {
        let clock = BootClock {
            boot_secs: 1000,
            ticks_per_sec: 100,
        };
        let cmdline = |pid: u32| {
            Ok(match pid {
                1 => Ok(b"/sbin/init\0".to_vec()),
                2 => Err(io::Error::from_raw_os_error(13)), // EACCES
                3 => Err(io::Error::from_raw_os_error(5)),  // EIO
                _ => Ok(Vec::new()),                        // a kernel thread
            })
        };
        let rows = walk_details(
            [1, 2, 3, 4],
            |_| Ok(Ok(full_stat("p", 0))),
            cmdline,
            Some(clock),
        )
        .expect("walk");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].cmdline.as_deref(), Some("/sbin/init\0"));
        assert!(rows[1..].iter().all(|r| r.cmdline.is_none()));
        assert!(rows.iter().all(|r| r.created == Some(1_005_000.0)));
        assert!(rows
            .iter()
            .all(|r| r.linux.as_ref().is_some_and(|d| d.pgid == 7)));
        // Without a boot clock only `created` is missing.
        let rows = walk_details([1], |_| Ok(Ok(full_stat("p", 0))), cmdline, None).expect("walk");
        assert_eq!((rows[0].created, rows[0].linux.is_some()), (None, true));
        // A stat line short of the detail fields fails the walk, as any unparsable line does.
        assert!(walk_details([1], |_| Ok(Ok(stat("p", 0))), cmdline, None).is_err());
        // A refused command line buffer fails it too.
        let refused = AllocFailed {
            what: "a /proc command line",
            bytes: 8192,
        };
        assert_eq!(
            walk_details([1], |_| Ok(Ok(full_stat("p", 0))), |_| Err(refused), None),
            Err(CallError::Alloc(refused))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn details_read_own_row_and_no_thread_is_a_row() {
        use std::sync::mpsc;
        extern "C" {
            fn getpgrp() -> i32;
        }
        // A second thread: its tid has a /proc entry, but no row.
        let (tid_tx, tid_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let thread = std::thread::spawn(move || {
            let link = std::fs::read_link("/proc/thread-self").expect("thread-self");
            let tid: u32 = link.file_name().unwrap().to_str().unwrap().parse().unwrap();
            tid_tx.send(tid).unwrap();
            done_rx.recv().ok();
        });
        let tid = tid_rx.recv().unwrap();
        let rows = snapshot(true).expect("snapshot");
        done_tx.send(()).unwrap();
        thread.join().unwrap();

        let me = std::process::id();
        assert_ne!(tid, me);
        assert!(rows.iter().all(|r| r.pid != tid), "a thread id is no row");
        let own = rows.iter().find(|r| r.pid == me).expect("own row");
        let details = own.linux.as_ref().expect("details");
        assert_eq!(details.state, "R");
        // SAFETY: getpgrp only reads this process's group.
        assert_eq!(details.pgid, unsafe { getpgrp() });
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64;
        let created = own.created.expect("created");
        assert!(
            created <= now_ms + 2000.0 && created > now_ms - 3_600_000.0,
            "{created} vs {now_ms}"
        );
        let exe = std::env::current_exe().unwrap();
        let file = exe.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            own.cmdline.as_deref().is_some_and(|c| c.contains(&file)),
            "{:?}",
            own.cmdline
        );
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
        assert!(
            rows.iter().all(|r| r.cmdline.is_none()),
            "no command line read"
        );
        assert!(rows
            .iter()
            .all(|r| r.linux.is_some() && r.created.is_some()));
    }
}
