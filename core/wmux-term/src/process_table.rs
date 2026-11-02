//! Windows process table for the daemon: one Toolhelp snapshot (pid, ppid,
//! image), plus creation time and command line per row on request. Creation
//! times come from one NtQuerySystemInformation pass, which covers processes
//! this user cannot open (services, other sessions), as CIM did. Replaces
//! the tasklist.exe liveness sweep and the PowerShell CIM enumeration, which
//! each spawned a process (and woke WMI) for what is a few ms of syscalls.
//!
//! Raw kernel32/ntdll declarations instead of a bindings crate: a handful of
//! calls and three structs.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::OnceLock;

type Handle = *mut c_void;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
/// ProcessCommandLineInformation (Windows 8.1+): a UNICODE_STRING that needs
/// only QUERY_LIMITED access, unlike reading the target's PEB.
const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
const SYSTEM_PROCESS_INFORMATION: u32 = 5;
const ERROR_NO_MORE_FILES: u32 = 18;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;
const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
/// FILETIME ticks (100 ns since 1601) at the Unix epoch.
const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FileTime {
    low: u32,
    high: u32,
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
    fn GetProcessTimes(
        process: Handle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *const c_void;
}

type NtQueryInformationProcess =
    unsafe extern "system" fn(Handle, u32, *mut c_void, u32, *mut u32) -> i32;

type NtQuerySystemInformation = unsafe extern "system" fn(u32, *mut c_void, u32, *mut u32) -> i32;

/// ntdll is mapped into every process; an export is absent only on a broken
/// system, where rows simply carry fewer details.
fn ntdll_export(name: &std::ffi::CStr) -> usize {
    let module_name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    // SAFETY: NUL-terminated names; a null module or proc yields 0.
    unsafe {
        let module = GetModuleHandleW(module_name.as_ptr());
        if module.is_null() {
            return 0;
        }
        GetProcAddress(module, name.as_ptr().cast()) as usize
    }
}

fn nt_query_process() -> Option<NtQueryInformationProcess> {
    static ADDR: OnceLock<usize> = OnceLock::new();
    let addr = *ADDR.get_or_init(|| ntdll_export(c"NtQueryInformationProcess"));
    // SAFETY: a non-zero address is ntdll's export with this documented signature.
    (addr != 0).then(|| unsafe { std::mem::transmute::<usize, NtQueryInformationProcess>(addr) })
}

fn nt_query_system() -> Option<NtQuerySystemInformation> {
    static ADDR: OnceLock<usize> = OnceLock::new();
    let addr = *ADDR.get_or_init(|| ntdll_export(c"NtQuerySystemInformation"));
    // SAFETY: as above.
    (addr != 0).then(|| unsafe { std::mem::transmute::<usize, NtQuerySystemInformation>(addr) })
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    /// Creation time, epoch ms. None when it could not be read.
    pub created: Option<f64>,
    /// None when unreadable (protected, other session without rights, exited
    /// mid-walk) or empty.
    pub cmdline: Option<String>,
}

struct OwnedHandle(Handle);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: only constructed from a valid, owned handle.
        unsafe { CloseHandle(self.0) };
    }
}

/// Walk the process table. Only a failed snapshot is an error; a row whose
/// details cannot be read, or cannot be shown to belong to the walked
/// process, keeps pid/ppid/name with `created`/`cmdline` unset. With details,
/// a row is left out only when its handle proves the pid now belongs to a
/// process created at another time.
pub fn snapshot(with_details: bool) -> Result<Vec<ProcessRow>, String> {
    // SAFETY: plain Win32 calls; every out-pointer refers to a local of the declared layout.
    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if raw == INVALID_HANDLE_VALUE || raw.is_null() {
            return Err(format!(
                "CreateToolhelp32Snapshot failed ({})",
                GetLastError()
            ));
        }
        let snap = OwnedHandle(raw);
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        if Process32FirstW(snap.0, &mut entry) == 0 {
            return Err(format!("Process32FirstW failed ({})", GetLastError()));
        }
        let mut rows = Vec::with_capacity(512);
        let listed = if with_details {
            listed_processes()
        } else {
            None
        };
        loop {
            let len = entry
                .sz_exe_file
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.sz_exe_file.len());
            let mut row = ProcessRow {
                pid: entry.th32_process_id,
                ppid: entry.th32_parent_process_id,
                // Toolhelp calls pid 0 "[System Process]"; tasklist and CIM
                // use this name.
                name: if entry.th32_process_id == 0 {
                    "System Idle Process".into()
                } else {
                    String::from_utf16_lossy(&entry.sz_exe_file[..len])
                },
                created: None,
                cmdline: None,
            };
            // Only the detailed table joins the two reads and may drop a row.
            // The liveness table (no details) keeps every Toolhelp row, so a
            // lost join can never read as a death.
            let keep = !with_details || row.pid == 0 || fill_details(&mut row, listed.as_ref());
            if keep {
                rows.push(row);
            }
            if Process32NextW(snap.0, &mut entry) == 0 {
                // Anything but the normal end is a cut-short table: callers
                // would read every pid past the cut as gone.
                let error = GetLastError();
                if error != ERROR_NO_MORE_FILES {
                    return Err(format!("Process32NextW failed ({error})"));
                }
                break;
            }
        }
        Ok(rows)
    }
}

/// Fill a walked row's creation time and command line. Details are taken
/// only for a process the kernel list shows with the same pid, parent and
/// image and a creation time the handle agrees with. Without that (no list,
/// an exited or reused pid, an image name Toolhelp cut at 260 chars, a null
/// kernel name) the row is kept with its details unset, as when the process
/// cannot be opened. False only when the handle proves the pid reused.
fn fill_details(row: &mut ProcessRow, listed: Option<&HashMap<u32, Listed>>) -> bool {
    let Some(created) = listed.and_then(|list| listed_creation(row, list)).flatten() else {
        return true;
    };
    row.created = Some(created);
    read_details(row, created)
}

/// Read the command line from a handle whose creation time matches the
/// listed one. False when it differs: the pid now names another process.
fn read_details(row: &mut ProcessRow, created: f64) -> bool {
    // SAFETY: the handle is checked and closed by OwnedHandle.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, row.pid) };
    if raw.is_null() {
        return true;
    }
    let process = OwnedHandle(raw);
    let (mut creation, mut exit, mut kernel, mut user) = Default::default();
    // SAFETY: four valid FILETIME out-pointers.
    let opened =
        if unsafe { GetProcessTimes(process.0, &mut creation, &mut exit, &mut kernel, &mut user) }
            != 0
        {
            filetime_to_epoch_ms(creation)
        } else {
            None
        };
    match opened {
        Some(now) if now != created => return false,
        Some(_) => row.cmdline = command_line(process.0),
        // The handle cannot be dated: its command line may not be this process's.
        None => {}
    }
    true
}

/// The kernel list's creation time for a walked row, when both reads saw the
/// same process (same pid, parent and image). None when the process exited
/// after the walk or its pid now names another process.
fn listed_creation(row: &ProcessRow, list: &HashMap<u32, Listed>) -> Option<Option<f64>> {
    list.get(&row.pid)
        .filter(|l| l.ppid == row.ppid && l.name == row.name)
        .map(|l| l.created)
}

/// One process as SystemProcessInformation lists it.
struct Listed {
    ppid: u32,
    name: String,
    created: Option<f64>,
}

/// Every process by pid, from one SystemProcessInformation read: creation
/// time needs no process handle there. None when the call fails.
#[cfg(target_pointer_width = "64")]
fn listed_processes() -> Option<HashMap<u32, Listed>> {
    let query = nt_query_system()?;
    let mut buffer: Vec<u64> = vec![0; 64 * 1024];
    for _ in 0..4 {
        let bytes = (buffer.len() * 8) as u32;
        let mut needed = 0u32;
        // SAFETY: the buffer is `bytes` long and writable.
        let status = unsafe {
            query(
                SYSTEM_PROCESS_INFORMATION,
                buffer.as_mut_ptr().cast(),
                bytes,
                &mut needed,
            )
        };
        if status >= 0 {
            return Some(parse_process_information(&buffer, bytes as usize));
        }
        if status != STATUS_INFO_LENGTH_MISMATCH || needed > 64 << 20 {
            return None;
        }
        // The table can grow between calls; leave headroom.
        buffer = vec![0; (needed as usize + 64 * 1024).div_ceil(8)];
    }
    None
}

/// The record offsets below are the 64-bit layout; elsewhere creation times
/// come from each process handle alone.
#[cfg(not(target_pointer_width = "64"))]
fn listed_processes() -> Option<HashMap<u32, Listed>> {
    None
}

/// Walk SYSTEM_PROCESS_INFORMATION records. x64 offsets: NextEntryOffset 0,
/// CreateTime 32, ImageName 56 (UNICODE_STRING: Length 56, Buffer 64),
/// UniqueProcessId 80, InheritedFromUniqueProcessId 88.
#[cfg(target_pointer_width = "64")]
fn parse_process_information(buffer: &[u64], bytes: usize) -> HashMap<u32, Listed> {
    let base = buffer.as_ptr() as *const u8;
    let read_u64 = |at: usize| -> Option<u64> {
        // SAFETY: bounds checked against the owned buffer; unaligned plain-data read.
        (at + 8 <= bytes).then(|| unsafe { std::ptr::read_unaligned(base.add(at) as *const u64) })
    };
    // The kernel points ImageName into this same buffer; accept it only there.
    let image_name = |length: u64, pointer: u64| -> String {
        let len = (length & 0xffff) as usize;
        let start = (pointer as usize).wrapping_sub(base as usize);
        if pointer == 0
            || len == 0
            || !len.is_multiple_of(2)
            || start > bytes
            || len > bytes - start
        {
            return String::new();
        }
        // SAFETY: the range was checked against the owned buffer above.
        let chars = unsafe {
            std::slice::from_raw_parts(base.add(start), len)
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<u16>>()
        };
        String::from_utf16_lossy(&chars)
    };
    let mut out = HashMap::with_capacity(512);
    let mut at = 0usize;
    while let (Some(head), Some(created), Some(length), Some(pointer), Some(pid), Some(ppid)) = (
        read_u64(at),
        read_u64(at + 32),
        read_u64(at + 56),
        read_u64(at + 64),
        read_u64(at + 80),
        read_u64(at + 88),
    ) {
        out.insert(
            pid as u32,
            Listed {
                ppid: ppid as u32,
                name: image_name(length, pointer),
                created: filetime_to_epoch_ms(FileTime {
                    low: created as u32,
                    high: (created >> 32) as u32,
                }),
            },
        );
        let next = (head & 0xffff_ffff) as usize;
        if next == 0 {
            break;
        }
        at += next;
    }
    out
}

fn filetime_to_epoch_ms(time: FileTime) -> Option<f64> {
    let ticks = ((time.high as u64) << 32) | time.low as u64;
    // Integer ms, truncated — the same value CIM's CreationDate yields.
    ticks
        .checked_sub(UNIX_EPOCH_TICKS)
        .map(|t| (t / 10_000) as f64)
}

fn command_line(process: Handle) -> Option<String> {
    let query = nt_query_process()?;
    let (buffer, bytes) = query_growing(|buffer, bytes, needed| {
        // SAFETY: the buffer is `bytes` long and writable.
        unsafe {
            query(
                process,
                PROCESS_COMMAND_LINE_INFORMATION,
                buffer.as_mut_ptr().cast(),
                bytes,
                needed,
            )
        }
    })?;
    decode_command_line(&buffer, bytes)
}

/// Largest command-line buffer: 32 Ki UTF-16 chars plus the header, rounded up.
const COMMAND_LINE_CAP: usize = 1 << 20;

/// Call `query` with a buffer that doubles on each "too small" status, up to
/// the cap. The reported length is only a lower bound: a call that leaves it
/// at 0 still gets a bigger buffer. u64 storage keeps the UNICODE_STRING
/// header pointer-aligned.
fn query_growing(
    mut query: impl FnMut(&mut [u64], u32, &mut u32) -> i32,
) -> Option<(Vec<u64>, usize)> {
    let mut bytes = 512usize;
    loop {
        let mut buffer = vec![0u64; bytes / 8];
        let mut needed = 0u32;
        let status = query(&mut buffer, bytes as u32, &mut needed);
        if status >= 0 {
            return Some((buffer, bytes));
        }
        let retry = matches!(
            status,
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_OVERFLOW | STATUS_BUFFER_TOO_SMALL
        );
        if !retry || bytes >= COMMAND_LINE_CAP {
            return None;
        }
        bytes = (bytes * 2)
            .max((needed as usize).next_multiple_of(8))
            .min(COMMAND_LINE_CAP);
    }
}

/// The kernel writes the UNICODE_STRING header followed by its characters
/// into the same buffer; accept the string only if it lies inside it.
fn decode_command_line(buffer: &[u64], bytes: usize) -> Option<String> {
    if bytes < std::mem::size_of::<UnicodeString>() {
        return None;
    }
    // SAFETY: the buffer is at least header-sized and 8-byte aligned.
    let header = unsafe { &*(buffer.as_ptr() as *const UnicodeString) };
    let len = header.length as usize;
    if len == 0 || header.buffer.is_null() {
        return None;
    }
    let base = buffer.as_ptr() as usize;
    let start = header.buffer as usize;
    if start < base || start + len > base + bytes || !len.is_multiple_of(2) {
        return None;
    }
    // SAFETY: bounds checked against the owned buffer above.
    let chars = unsafe { std::slice::from_raw_parts(header.buffer, len / 2) };
    let text = String::from_utf16_lossy(chars);
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reads_own_row_with_details() {
        let rows = snapshot(true).expect("snapshot");
        let me = std::process::id();
        let own = rows.iter().find(|r| r.pid == me).expect("own row");
        assert!(own.name.to_ascii_lowercase().ends_with(".exe"));
        assert!(rows.iter().any(|r| r.pid == own.ppid), "parent row present");
        let created = own.created.expect("own creation time");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64;
        assert!(created <= now && now - created < 3_600_000.0);
        let exe = std::env::current_exe().unwrap();
        let stem = exe.file_stem().unwrap().to_string_lossy().to_string();
        assert!(own.cmdline.as_deref().unwrap_or("").contains(&stem));
    }

    #[test]
    fn protected_rows_never_fail_the_snapshot() {
        let rows = snapshot(true).expect("snapshot");
        // pid 0 is never opened; System (4) carries no command line but,
        // like processes this user cannot open, a creation time.
        let idle = rows.iter().find(|r| r.pid == 0).expect("idle row");
        assert_eq!(idle.name, "System Idle Process");
        assert!(idle.created.is_none() && idle.cmdline.is_none());
        let system = rows.iter().find(|r| r.pid == 4).expect("System row");
        assert!(system.cmdline.is_none());
        assert!(system.created.is_some());
    }

    #[test]
    fn creation_times_agree_with_the_process_handle() {
        let me = std::process::id();
        let listed = listed_processes().expect("kernel process list");
        let own = listed.get(&me).expect("own record");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(
            own.name,
            exe.file_name().unwrap().to_string_lossy().to_string()
        );
        let mut row = ProcessRow {
            pid: me,
            ppid: 0,
            name: String::new(),
            created: None,
            cmdline: None,
        };
        // A differing handle time would read as a reused pid (false).
        assert!(read_details(&mut row, own.created.expect("listed time")));
        assert!(row.cmdline.is_some());
    }

    fn own_row(name: &str) -> ProcessRow {
        ProcessRow {
            pid: std::process::id(),
            ppid: 0,
            name: name.into(),
            created: None,
            cmdline: None,
        }
    }

    #[test]
    fn a_join_miss_keeps_the_row_without_details() {
        // The kernel list shows another image on this pid (or Toolhelp cut the
        // name): the row stays listed, as when the process cannot be opened.
        let listed = HashMap::from([(
            std::process::id(),
            Listed {
                ppid: 0,
                name: "another.exe".into(),
                created: Some(5.0),
            },
        )]);
        let mut row = own_row("walked.exe");
        assert!(fill_details(&mut row, Some(&listed)));
        assert_eq!((row.created, row.cmdline), (None, None));
        let mut row = own_row("walked.exe");
        assert!(fill_details(&mut row, Some(&HashMap::new())));
        assert_eq!((row.created, row.cmdline), (None, None));
    }

    #[test]
    fn without_the_kernel_list_no_details_are_adopted() {
        // Nothing dates the walked process, so the handle's process (maybe a
        // new owner of the pid) lends it nothing.
        let mut row = own_row("walked.exe");
        assert!(fill_details(&mut row, None));
        assert_eq!((row.created, row.cmdline), (None, None));
    }

    #[test]
    fn the_buffer_grows_when_the_needed_length_is_not_reported() {
        let mut calls = 0;
        let (_, bytes) = query_growing(|_, bytes, _needed| {
            calls += 1;
            if bytes < 5_000 {
                STATUS_INFO_LENGTH_MISMATCH
            } else {
                0
            }
        })
        .expect("grown buffer");
        assert_eq!((bytes, calls), (8_192, 5));
        // A reported length still jumps straight there.
        let (_, bytes) = query_growing(|_, bytes, needed| {
            *needed = 70_000;
            if (bytes as usize) < 70_000 {
                STATUS_BUFFER_TOO_SMALL
            } else {
                0
            }
        })
        .expect("sized buffer");
        assert_eq!(bytes, 70_000);
        // Never past the cap.
        let mut largest = 0;
        let read = query_growing(|_, bytes, _| {
            largest = largest.max(bytes as usize);
            STATUS_BUFFER_OVERFLOW
        });
        assert!(read.is_none());
        assert_eq!(largest, COMMAND_LINE_CAP);
        assert!(query_growing(|_, _, _| 0xC000_0022_u32 as i32).is_none());
    }

    #[test]
    fn reads_a_command_line_over_2_kb() {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        let tail = "x".repeat(3_000);
        // cmd stays at its prompt on the piped stdin until killed.
        let mut child = std::process::Command::new("cmd.exe")
            .raw_arg(format!("/d /q /k rem {tail}"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd");
        let read = command_line(child.as_raw_handle() as Handle);
        child.kill().ok();
        child.wait().ok();
        let read = read.expect("command line");
        assert!(read.len() > 3_000 && read.ends_with(&tail));
    }

    #[test]
    fn the_join_needs_the_same_pid_parent_and_image() {
        let row = ProcessRow {
            pid: 10,
            ppid: 2,
            name: "pwsh.exe".into(),
            created: None,
            cmdline: None,
        };
        let listed = |ppid: u32, name: &str| Listed {
            ppid,
            name: name.into(),
            created: Some(5.0),
        };
        let one = |l: Listed| HashMap::from([(10, l)]);
        assert_eq!(
            listed_creation(&row, &one(listed(2, "pwsh.exe"))),
            Some(Some(5.0))
        );
        assert_eq!(listed_creation(&row, &one(listed(3, "pwsh.exe"))), None);
        assert_eq!(listed_creation(&row, &one(listed(2, "node.exe"))), None);
        assert_eq!(listed_creation(&row, &HashMap::new()), None);
    }

    #[test]
    fn the_liveness_table_keeps_every_walked_row() {
        // Without details nothing is joined or dropped: the table is Toolhelp's.
        let rows = snapshot(false).expect("snapshot");
        assert!(rows.iter().any(|r| r.pid == 0));
        assert!(rows.iter().any(|r| r.pid == 4));
        assert!(rows.iter().any(|r| r.pid == std::process::id()));
    }

    #[test]
    fn a_pid_reused_after_the_walk_is_dropped() {
        // The walk saw an earlier process on this pid: the handle's creation
        // time differs, so the open process's command line is not taken.
        let mut row = own_row("earlier.exe");
        assert!(!read_details(&mut row, 1.0));
        assert_eq!(row.cmdline, None);
    }

    #[test]
    fn without_details_reads_no_times_or_command_lines() {
        let rows = snapshot(false).expect("snapshot");
        assert!(rows.len() > 10);
        assert!(rows
            .iter()
            .all(|r| r.created.is_none() && r.cmdline.is_none()));
        assert!(rows.iter().any(|r| r.pid == std::process::id()));
    }

    #[test]
    fn filetime_conversion() {
        let at = UNIX_EPOCH_TICKS + 1_234 * 10_000 + 9_999;
        let time = FileTime {
            low: at as u32,
            high: (at >> 32) as u32,
        };
        assert_eq!(filetime_to_epoch_ms(time), Some(1_234.0));
        assert_eq!(filetime_to_epoch_ms(FileTime::default()), None);
    }
}
