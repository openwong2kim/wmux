//! PortWatcher's snapshot in one call: the process walk (pid → parent) and
//! the listening TCP sockets with the pid holding each one, from a single
//! walk, in place of `ps -axo pid=,ppid=` plus `lsof -nP -iTCP -sTCP:LISTEN`.
//! Like lsof run as this user, sockets are read only from this user's
//! processes; one row per socket a process holds, as lsof lists them.
//!
//! A process that exited or may not be read (ENOENT, ESRCH, EACCES, EPERM)
//! contributes no sockets; any other failed read fails the whole snapshot.

#[cfg(any(target_os = "macos", target_os = "linux", test))]
use super::unreadable_process;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::ProcessRow;

#[derive(Debug, Clone, PartialEq)]
pub struct ListenSocket {
    pub pid: u32,
    pub port: u16,
    /// The local address, `0.0.0.0` or `::` for any.
    pub address: String,
    /// 4 or 6.
    pub family: u8,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Clone, PartialEq)]
pub struct PortSnapshot {
    pub processes: Vec<ProcessRow>,
    pub sockets: Vec<ListenSocket>,
}

/// macOS `struct socket_fdinfo` (PROC_PIDFDSOCKETINFO), the fields read.
#[cfg(any(target_os = "macos", test))]
mod fdinfo {
    pub const SIZE: usize = 792;
    pub const FAMILY: usize = 184;
    pub const KIND: usize = 256;
    pub const LPORT: usize = 268;
    pub const VFLAG: usize = 288;
    pub const LADDR: usize = 312;
    pub const TCP_STATE: usize = 344;
    pub const AF_INET: i32 = 2;
    pub const AF_INET6: i32 = 30;
    pub const SOCKINFO_TCP: i32 = 2;
    pub const TSI_S_LISTEN: i32 = 1;
    pub const INI_IPV4: u8 = 1;
    pub const INI_IPV6: u8 = 2;
    pub const EBADF: i32 = 9;
    pub const ENOMEM: i32 = 12;
    pub const ENOTSOCK: i32 = 38;
    /// Not an errno: PROC_PIDFDSOCKETINFO answered with another size than
    /// `SIZE` and no errno, so the record layout is not the one parsed here.
    pub const SHORT_RECORD: i32 = -1;
}

/// One PROC_PIDFDSOCKETINFO answer (`got` bytes, `errno` after it) as
/// collect_macos reads it: a full record, the errno, or SHORT_RECORD.
#[cfg(any(target_os = "macos", test))]
pub(super) fn fd_info_result(got: i32, errno: i32) -> Result<(), i32> {
    match got {
        n if n == fdinfo::SIZE as i32 => Ok(()),
        _ if errno != 0 => Err(errno),
        _ => Err(fdinfo::SHORT_RECORD),
    }
}

/// Read a variable-length libproc list into a buffer that starts at `start`
/// bytes and doubles while an answer fills it (the list may have grown
/// since its size was asked), up to 1 MiB. `read` returns (bytes, errno);
/// 0 bytes with errno 0 is an empty list. A list that still fills 1 MiB is
/// ENOMEM rather than a list cut short.
#[cfg(any(target_os = "macos", test))]
pub(super) fn read_growing(
    start: usize,
    mut read: impl FnMut(&mut [u8]) -> (i32, i32),
) -> Result<Vec<u8>, i32> {
    const CAP: usize = 1 << 20;
    let mut len = start.max(64);
    loop {
        let mut buf = vec![0u8; len];
        let (got, errno) = read(&mut buf);
        if got <= 0 {
            return if errno == 0 {
                Ok(Vec::new())
            } else {
                Err(errno)
            };
        }
        let got = got as usize;
        if got < buf.len() {
            buf.truncate(got);
            return Ok(buf);
        }
        if len >= CAP {
            return Err(fdinfo::ENOMEM);
        }
        len = (len * 2).min(CAP);
    }
}

#[cfg(any(target_os = "macos", test))]
fn read_i32(buf: &[u8], at: usize) -> i32 {
    i32::from_ne_bytes(buf[at..at + 4].try_into().unwrap())
}

/// (port, address, family) of a macOS socket_fdinfo, when it is a TCP socket
/// in LISTEN state. An AF_INET6 socket bound to a v4-mapped address (only
/// INI_IPV4 set) is IPv4, with the dotted address lsof prints for it.
#[cfg(any(target_os = "macos", test))]
pub(super) fn parse_socket_fdinfo(buf: &[u8]) -> Option<(u16, String, u8)> {
    use fdinfo::*;
    if buf.len() < SIZE
        || read_i32(buf, KIND) != SOCKINFO_TCP
        || read_i32(buf, TCP_STATE) != TSI_S_LISTEN
    {
        return None;
    }
    // insi_lport holds the port in network byte order.
    let port = u16::from_be(read_i32(buf, LPORT) as u16);
    let addr = &buf[LADDR..LADDR + 16];
    // in4in6_addr: an IPv4 address is its last four bytes.
    let v4 = || {
        let v4: [u8; 4] = addr[12..16].try_into().unwrap();
        std::net::Ipv4Addr::from(v4).to_string()
    };
    let vflag = buf[VFLAG];
    match read_i32(buf, FAMILY) {
        AF_INET => Some((port, v4(), 4)),
        AF_INET6 if vflag & INI_IPV4 != 0 && vflag & INI_IPV6 == 0 => Some((port, v4(), 4)),
        AF_INET6 => {
            let v6: [u8; 16] = addr.try_into().unwrap();
            Some((port, std::net::Ipv6Addr::from(v6).to_string(), 6))
        }
        _ => None,
    }
}

/// The pids of `walked` (pid, effective uid) that `uid` owns: the only
/// processes PROC_PIDLISTFDS answers for, as lsof run as this user lists.
/// Root reads every process.
#[cfg(any(target_os = "macos", test))]
pub(super) fn owned_by(walked: &[(super::ProcessRow, u32)], uid: u32) -> Vec<u32> {
    walked
        .iter()
        .filter(|(_, owner)| uid == 0 || *owner == uid)
        .map(|(row, _)| row.pid)
        .collect()
}

/// The listening sockets of `pids` (macOS), read with `socket_fds` (the
/// socket descriptors of a pid) and `fd_info` (one PROC_PIDFDSOCKETINFO into
/// the buffer). Errors are errno values. A pid that cannot be read
/// contributes nothing; a descriptor closed since the listing (EBADF), or
/// reused for something that is no socket (ENOTSOCK), is skipped; any other
/// errno, or a record of another size (SHORT_RECORD), fails the call. One
/// buffer serves every read.
#[cfg(any(target_os = "macos", test))]
pub(super) fn collect_macos(
    pids: impl IntoIterator<Item = u32>,
    mut socket_fds: impl FnMut(u32) -> Result<Vec<i32>, i32>,
    mut fd_info: impl FnMut(u32, i32, &mut [u8]) -> Result<(), i32>,
) -> Result<Vec<ListenSocket>, String> {
    let mut out = Vec::new();
    let mut buf = [0u8; fdinfo::SIZE];
    for pid in pids {
        let fds = match socket_fds(pid) {
            Ok(fds) => fds,
            Err(e) if unreadable_process(e) => continue,
            Err(e) => return Err(format!("PROC_PIDLISTFDS of {pid} failed (errno {e})")),
        };
        let kept = out.len();
        for fd in fds {
            match fd_info(pid, fd, &mut buf) {
                Ok(()) => {
                    if let Some((port, address, family)) = parse_socket_fdinfo(&buf) {
                        out.push(ListenSocket {
                            pid,
                            port,
                            address,
                            family,
                        });
                    }
                }
                Err(fdinfo::EBADF | fdinfo::ENOTSOCK) => {}
                Err(fdinfo::SHORT_RECORD) => {
                    return Err(format!(
                        "PROC_PIDFDSOCKETINFO of {pid}/{fd} answered a record of another size"
                    ))
                }
                Err(e) if unreadable_process(e) => {
                    out.truncate(kept);
                    break;
                }
                Err(e) => {
                    return Err(format!(
                        "PROC_PIDFDSOCKETINFO of {pid}/{fd} failed (errno {e})"
                    ))
                }
            }
        }
    }
    Ok(out)
}

/// The listening sockets of `/proc/net/tcp` or `tcp6` (state 0A), as
/// (inode, port, address, family). Each address word is printed in host
/// byte order.
#[cfg(any(target_os = "linux", test))]
pub(super) fn parse_net_tcp(text: &str, family: u8) -> Vec<(u64, u16, String, u8)> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((addr, port)) = fields[1].split_once(':') else {
            continue;
        };
        let (Ok(port), Ok(inode)) = (u16::from_str_radix(port, 16), fields[9].parse::<u64>())
        else {
            continue;
        };
        let words: Option<Vec<u32>> = (0..addr.len() / 8)
            .map(|i| u32::from_str_radix(&addr[i * 8..i * 8 + 8], 16).ok())
            .collect();
        let Some(words) = words else {
            continue;
        };
        let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_ne_bytes()).collect();
        let address = match (family, bytes.len()) {
            (4, 4) => std::net::Ipv4Addr::from(<[u8; 4]>::try_from(bytes).unwrap()).to_string(),
            (6, 16) => std::net::Ipv6Addr::from(<[u8; 16]>::try_from(bytes).unwrap()).to_string(),
            _ => continue,
        };
        if inode != 0 {
            out.push((inode, port, address, family));
        }
    }
    out
}

/// The inode of a `/proc/<pid>/fd/<n>` link to a socket (`socket:[1234]`).
#[cfg(any(target_os = "linux", test))]
pub(super) fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// The listening sockets of `pids` (Linux): `fd_links` lists a pid's
/// descriptor links, each read on its own. A pid that cannot be read
/// contributes nothing; a descriptor closed since the listing (ENOENT) is
/// skipped; any other failure fails the call.
#[cfg(any(target_os = "linux", test))]
pub(super) fn collect_linux(
    pids: impl IntoIterator<Item = u32>,
    listening: &std::collections::HashMap<u64, (u16, String, u8)>,
    mut fd_links: impl FnMut(u32) -> std::io::Result<Vec<std::io::Result<String>>>,
) -> Result<Vec<ListenSocket>, String> {
    let unreadable = |e: &std::io::Error| e.raw_os_error().is_some_and(unreadable_process);
    let mut out = Vec::new();
    if listening.is_empty() {
        return Ok(out);
    }
    for pid in pids {
        let links = match fd_links(pid) {
            Ok(links) => links,
            Err(e) if unreadable(&e) => continue,
            Err(e) => return Err(format!("read /proc/{pid}/fd failed ({e})")),
        };
        let kept = out.len();
        for link in links {
            match link {
                Ok(link) => {
                    if let Some((port, address, family)) =
                        socket_inode(&link).and_then(|inode| listening.get(&inode))
                    {
                        out.push(ListenSocket {
                            pid,
                            port: *port,
                            address: address.clone(),
                            family: *family,
                        });
                    }
                }
                // ENOENT, by its Linux errno (see linux::unreadable).
                Err(e) if e.raw_os_error() == Some(2) => {}
                Err(e) if unreadable(&e) => {
                    out.truncate(kept);
                    break;
                }
                Err(e) => return Err(format!("read a /proc/{pid}/fd link failed ({e})")),
            }
        }
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
pub use macos_sys::port_snapshot;

#[cfg(target_os = "macos")]
mod macos_sys {
    use super::{collect_macos, fd_info_result, fdinfo, owned_by, read_growing, PortSnapshot};
    use std::ffi::{c_int, c_void};

    const PROC_PIDLISTFDS: c_int = 1;
    const PROC_PIDFDSOCKETINFO: c_int = 3;
    const PROX_FDTYPE_SOCKET: u32 = 2;
    /// `struct proc_fdinfo`: fd, then its type.
    const FDINFO_SIZE: usize = 8;

    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
        fn proc_pidfdinfo(
            pid: c_int,
            fd: c_int,
            flavor: c_int,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
        fn geteuid() -> u32;
        fn __error() -> *mut c_int;
    }

    /// Run a libproc call that returns 0 on failure, with errno cleared first
    /// so a 0 that is no failure (no descriptors) reads as errno 0.
    fn call(f: impl FnOnce() -> c_int) -> (c_int, i32) {
        // SAFETY: __error returns this thread's errno slot.
        unsafe { *__error() = 0 };
        let got = f();
        // SAFETY: as above.
        (got, unsafe { *__error() })
    }

    /// The socket descriptors of `pid`, or the errno that refused them.
    fn socket_fds(pid: c_int) -> Result<Vec<c_int>, i32> {
        // SAFETY: a null buffer asks only for the size.
        let (needed, errno) =
            call(|| unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) });
        if needed <= 0 {
            return if errno == 0 {
                Ok(Vec::new())
            } else {
                Err(errno)
            };
        }
        // Headroom for descriptors opened since the size query.
        let list = read_growing(needed as usize + 32 * FDINFO_SIZE, |buf| {
            let len = buf.len() as c_int;
            // SAFETY: the buffer is `len` bytes and writable.
            call(|| unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, buf.as_mut_ptr().cast(), len) })
        })?;
        Ok(list
            .as_chunks::<FDINFO_SIZE>()
            .0
            .iter()
            .filter(|e| u32::from_ne_bytes(e[4..8].try_into().unwrap()) == PROX_FDTYPE_SOCKET)
            .map(|e| c_int::from_ne_bytes(e[0..4].try_into().unwrap()))
            .collect())
    }

    fn fd_info(pid: c_int, fd: c_int, buf: &mut [u8]) -> Result<(), i32> {
        let size = fdinfo::SIZE as c_int;
        // SAFETY: the buffer is at least fdinfo::SIZE bytes and writable.
        let (got, errno) = call(|| unsafe {
            proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, buf.as_mut_ptr().cast(), size)
        });
        fd_info_result(got, errno)
    }

    /// The walk, and the listening sockets of this user's processes (the
    /// only ones PROC_PIDLISTFDS answers for), from one KERN_PROC_ALL read.
    pub fn port_snapshot() -> Result<PortSnapshot, String> {
        let walked = super::super::macos::walk()?;
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { geteuid() };
        let mine = owned_by(&walked, me);
        let sockets = collect_macos(
            mine,
            |pid| socket_fds(pid as c_int),
            |pid, fd, buf| fd_info(pid as c_int, fd, buf),
        )?;
        Ok(PortSnapshot {
            processes: walked.into_iter().map(|(row, _)| row).collect(),
            sockets,
        })
    }
}

#[cfg(target_os = "linux")]
pub use linux_sys::port_snapshot;

#[cfg(target_os = "linux")]
mod linux_sys {
    use super::{collect_linux, parse_net_tcp, PortSnapshot};
    use std::collections::HashMap;

    fn fd_links(pid: u32) -> std::io::Result<Vec<std::io::Result<String>>> {
        Ok(std::fs::read_dir(format!("/proc/{pid}/fd"))?
            .map(|entry| {
                let link = std::fs::read_link(entry?.path())?;
                Ok(link.to_string_lossy().into_owned())
            })
            .collect())
    }

    /// The walk, and the listening sockets of the processes this user can
    /// read: the kernel's socket tables, joined to pids through
    /// `/proc/<pid>/fd`, over one `/proc` listing.
    pub fn port_snapshot() -> Result<PortSnapshot, String> {
        let mut listening: HashMap<u64, (u16, String, u8)> = HashMap::new();
        for (file, family) in [("/proc/net/tcp", 4), ("/proc/net/tcp6", 6)] {
            match std::fs::read_to_string(file) {
                Ok(text) => {
                    for (inode, port, address, family) in parse_net_tcp(&text, family) {
                        listening.insert(inode, (port, address, family));
                    }
                }
                // No IPv6 in this kernel.
                Err(e) if family == 6 && e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("read {file} failed ({e})")),
            }
        }
        let processes = super::super::linux::walk(
            super::super::linux::proc_pids()?,
            super::super::linux::stat_of,
        )?;
        let sockets = collect_linux(processes.iter().map(|r| r.pid), &listening, fd_links)?;
        Ok(PortSnapshot { processes, sockets })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fdinfo_bytes(
        kind: i32,
        state: i32,
        family: i32,
        vflag: u8,
        port: u16,
        addr: [u8; 16],
    ) -> Vec<u8> {
        use fdinfo::*;
        let mut b = vec![0u8; SIZE];
        b[KIND..KIND + 4].copy_from_slice(&kind.to_ne_bytes());
        b[TCP_STATE..TCP_STATE + 4].copy_from_slice(&state.to_ne_bytes());
        b[FAMILY..FAMILY + 4].copy_from_slice(&family.to_ne_bytes());
        b[VFLAG] = vflag;
        b[LPORT..LPORT + 4].copy_from_slice(&i32::from(port.to_be()).to_ne_bytes());
        b[LADDR..LADDR + 16].copy_from_slice(&addr);
        b
    }

    fn mapped(v4: [u8; 4]) -> [u8; 16] {
        let mut a = [0u8; 16];
        a[10] = 0xff;
        a[11] = 0xff;
        a[12..].copy_from_slice(&v4);
        a
    }

    #[test]
    fn macos_socket_info_parses() {
        let v4 = mapped([127, 0, 0, 1]);
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 2, 1, 5173, v4)),
            Some((5173, "127.0.0.1".into(), 4))
        );
        let mut v6 = [0u8; 16];
        v6[15] = 1;
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 30, 2, 3000, v6)),
            Some((3000, "::1".into(), 6))
        );
        // Dual-stack `::` (both flags): IPv6.
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 30, 3, 8080, [0; 16])),
            Some((8080, "::".into(), 6))
        );
        // Established (4), not TCP (UDP: 1), not inet (unix: 1), short buffer.
        assert_eq!(parse_socket_fdinfo(&fdinfo_bytes(2, 4, 2, 1, 80, v4)), None);
        assert_eq!(parse_socket_fdinfo(&fdinfo_bytes(1, 1, 2, 1, 80, v4)), None);
        assert_eq!(parse_socket_fdinfo(&fdinfo_bytes(2, 1, 1, 1, 80, v4)), None);
        assert_eq!(parse_socket_fdinfo(&[0u8; 100]), None);
    }

    #[test]
    fn a_v4_mapped_inet6_socket_is_ipv4() {
        // Bound to ::ffff:127.0.0.1: AF_INET6 with only INI_IPV4 set, which
        // lsof prints as 127.0.0.1.
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 30, 1, 4000, mapped([127, 0, 0, 1]))),
            Some((4000, "127.0.0.1".into(), 4))
        );
    }

    fn listener(port: u16) -> Vec<u8> {
        fdinfo_bytes(2, 1, 2, 1, port, mapped([127, 0, 0, 1]))
    }

    #[test]
    fn macos_unreadable_pids_and_closed_fds_are_skipped() {
        // pid 1: another user's (EPERM); 2: exited (ESRCH); 3: fd 5 closed
        // since the listing (EBADF), fd 6 a listener; 4: exits mid-read, so
        // its earlier rows go too; 5: a listener.
        let fds = |pid: u32| match pid {
            1 => Err(1),
            2 => Err(3),
            3 => Ok(vec![5, 6]),
            4 => Ok(vec![7, 8]),
            _ => Ok(vec![9]),
        };
        let info = |pid: u32, fd: i32, buf: &mut [u8]| match (pid, fd) {
            (3, 5) => Err(9),
            (4, 8) => Err(3),
            _ => {
                buf.copy_from_slice(&listener(1000 + fd as u16));
                Ok(())
            }
        };
        let rows = collect_macos([1, 2, 3, 4, 5], fds, info).expect("collect");
        assert_eq!(
            rows.iter().map(|r| (r.pid, r.port)).collect::<Vec<_>>(),
            vec![(3, 1006), (5, 1009)]
        );
    }

    #[test]
    fn macos_reads_sockets_of_this_users_processes_only() {
        let row = |pid| crate::process_table::ProcessRow {
            pid,
            ppid: 1,
            name: "x".into(),
            created: None,
            cmdline: None,
        };
        let walked = [(row(1), 0), (row(2), 501), (row(3), 502), (row(4), 501)];
        assert_eq!(owned_by(&walked, 501), vec![2, 4]);
        // Root reads every process.
        assert_eq!(owned_by(&walked, 0), vec![1, 2, 3, 4]);
    }

    #[test]
    fn macos_a_descriptor_reused_for_no_socket_is_skipped() {
        // ENOTSOCK: the fd was closed and reopened as a file since the listing.
        let info = |_: u32, fd: i32, buf: &mut [u8]| {
            if fd == 5 {
                return Err(38);
            }
            buf.copy_from_slice(&listener(1000 + fd as u16));
            Ok(())
        };
        let rows = collect_macos([1], |_| Ok(vec![5, 6]), info).expect("collect");
        assert_eq!(rows.iter().map(|r| r.port).collect::<Vec<_>>(), vec![1006]);
    }

    #[test]
    fn macos_a_record_of_another_size_fails_the_call() {
        // Another size and no errno: a layout this parser does not know. The
        // tick falls back to lsof rather than report no ports.
        assert_eq!(fd_info_result(fdinfo::SIZE as i32, 0), Ok(()));
        assert_eq!(fd_info_result(0, 9), Err(9));
        assert_eq!(fd_info_result(600, 0), Err(fdinfo::SHORT_RECORD));
        assert_eq!(fd_info_result(0, 0), Err(fdinfo::SHORT_RECORD));
        let rows = collect_macos([1], |_| Ok(vec![3]), |_, _, _| fd_info_result(600, 0));
        assert!(rows.is_err());
    }

    #[test]
    fn a_list_that_fills_the_buffer_is_read_again_larger() {
        // 100 bytes of descriptors: a 64-byte buffer comes back full, a 128-byte one does not.
        let mut sizes = Vec::new();
        let list = read_growing(64, |buf| {
            sizes.push(buf.len());
            (buf.len().min(100) as i32, 0)
        })
        .expect("list");
        assert_eq!((list.len(), sizes), (100, vec![64, 128]));
        assert_eq!(read_growing(64, |_| (0, 0)), Ok(Vec::new()));
        assert_eq!(read_growing(64, |_| (0, 3)), Err(3));
        // Still full at the cap: an error, never a list cut short.
        assert_eq!(
            read_growing(64, |buf| (buf.len() as i32, 0)),
            Err(fdinfo::ENOMEM)
        );
    }

    #[test]
    fn macos_any_other_errno_fails() {
        for errno in [5, 12, 22] {
            // EIO, ENOMEM, EINVAL on the listing, then on one descriptor.
            assert!(collect_macos([1], |_| Err(errno), |_, _, _| Ok(())).is_err());
            assert!(collect_macos([1], |_| Ok(vec![3]), |_, _, _| Err(errno)).is_err());
        }
    }

    /// A `/proc/net/tcp*` address field for these bytes, as the kernel
    /// prints it on this host.
    fn hex(bytes: &[u8]) -> String {
        bytes
            .chunks(4)
            .map(|w| format!("{:08X}", u32::from_ne_bytes(w.try_into().unwrap())))
            .collect()
    }

    #[test]
    fn proc_net_tcp_parses_listeners_only() {
        let header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
        let tcp = format!(
            "{header}   0: {}:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0 100 0 0 10 0\n   1: {}:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0 20 4 30 10 -1\n",
            hex(&[127, 0, 0, 1]),
            hex(&[127, 0, 0, 1]),
        );
        assert_eq!(
            parse_net_tcp(&tcp, 4),
            vec![(4242, 8080, "127.0.0.1".into(), 4)]
        );
        let tcp6 = |local: [u8; 16]| {
            format!(
                "{header}   0: {}:0BB8 {}:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99 1 0 100 0 0 10 0\n",
                hex(&local),
                hex(&[0u8; 16]),
            )
        };
        assert_eq!(
            parse_net_tcp(&tcp6([0; 16]), 6),
            vec![(99, 3000, "::".into(), 6)]
        );
        let mut loopback = [0u8; 16];
        loopback[15] = 1;
        assert_eq!(parse_net_tcp(&tcp6(loopback), 6)[0].2, "::1");
        assert!(parse_net_tcp("header only\n", 4).is_empty());
    }

    #[test]
    fn socket_links() {
        assert_eq!(socket_inode("socket:[4242]"), Some(4242));
        assert_eq!(socket_inode("pipe:[4242]"), None);
        assert_eq!(socket_inode("/dev/null"), None);
    }

    fn errno(n: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(n)
    }

    #[test]
    fn linux_unreadable_pids_and_closed_fds_are_skipped() {
        let listening = std::collections::HashMap::from([
            (10, (3000, "127.0.0.1".to_string(), 4)),
            (11, (4000, "::".to_string(), 6)),
        ]);
        let links = |pid: u32| -> std::io::Result<Vec<std::io::Result<String>>> {
            match pid {
                1 => Err(errno(13)), // EACCES: another user's
                2 => Err(errno(2)),  // ENOENT: exited
                // fd closed since the listing (ENOENT), then a listener.
                3 => Ok(vec![Err(errno(2)), Ok("socket:[10]".into())]),
                // exits mid-read (ESRCH): its earlier rows go too.
                4 => Ok(vec![Ok("socket:[11]".into()), Err(errno(3))]),
                _ => Ok(vec![Ok("pipe:[10]".into()), Ok("socket:[11]".into())]),
            }
        };
        let rows = collect_linux([1, 2, 3, 4, 5], &listening, links).expect("collect");
        assert_eq!(
            rows.iter().map(|r| (r.pid, r.port)).collect::<Vec<_>>(),
            vec![(3, 3000), (5, 4000)]
        );
    }

    #[test]
    fn linux_any_other_errno_fails() {
        let listening = std::collections::HashMap::from([(10, (3000, "::".to_string(), 6))]);
        for n in [5, 23, 24] {
            // EIO, ENFILE, EMFILE on the listing, then on one link.
            assert!(collect_linux([1], &listening, |_| Err(errno(n))).is_err());
            assert!(collect_linux([1], &listening, |_| Ok(vec![Err(errno(n))])).is_err());
        }
        // Judged by the Linux errno alone, never by ErrorKind: an error that
        // only says NotFound (Windows maps raw 3, ESRCH on Linux, to it)
        // proves no closed descriptor.
        let kind_only = || std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(collect_linux([1], &listening, |_| Ok(vec![Err(kind_only())])).is_err());
        assert!(collect_linux([1], &listening, |_| Err(kind_only())).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn snapshot_lists_this_process_and_its_listeners() {
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").expect("bind v4");
        let v6 = std::net::TcpListener::bind("[::1]:0").ok();
        let snap = port_snapshot().expect("snapshot");
        let me = std::process::id();
        assert!(snap.processes.iter().any(|r| r.pid == me));
        let own = |port, address: &str, family| ListenSocket {
            pid: me,
            port,
            address: address.into(),
            family,
        };
        let port = v4.local_addr().unwrap().port();
        assert!(
            snap.sockets.contains(&own(port, "127.0.0.1", 4)),
            "{:?}",
            snap.sockets
        );
        if let Some(v6) = v6 {
            assert!(snap
                .sockets
                .contains(&own(v6.local_addr().unwrap().port(), "::1", 6)));
        }
        // Every socket's pid is in the same snapshot's walk.
        assert!(snap
            .sockets
            .iter()
            .all(|s| snap.processes.iter().any(|r| r.pid == s.pid)));
        // A connected (not listening) socket is not listed.
        let client = std::net::TcpStream::connect(v4.local_addr().unwrap()).expect("connect");
        let local = client.local_addr().unwrap().port();
        let snap = port_snapshot().expect("snapshot");
        assert!(!snap.sockets.iter().any(|r| r.pid == me && r.port == local));
    }
}
