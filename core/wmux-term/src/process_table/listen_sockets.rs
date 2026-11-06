//! Listening TCP sockets with the pid that holds each one, in place of
//! `lsof -nP -iTCP -sTCP:LISTEN`. Like lsof run as this user, only this
//! user's processes can be read; a process that cannot be read (another
//! user's, one that exited mid-walk) contributes nothing. One row per socket
//! a process holds, as lsof lists them.

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Clone, PartialEq)]
pub struct ListenSocket {
    pub pid: u32,
    pub port: u16,
    /// The local address, `0.0.0.0` or `::` for any.
    pub address: String,
    /// 4 or 6.
    pub family: u8,
}

#[cfg(any(target_os = "macos", test))]
/// macOS `struct socket_fdinfo` (PROC_PIDFDSOCKETINFO), the fields read.
mod fdinfo {
    pub const SIZE: usize = 792;
    pub const FAMILY: usize = 184;
    pub const KIND: usize = 256;
    pub const LPORT: usize = 268;
    pub const LADDR: usize = 312;
    pub const TCP_STATE: usize = 344;
    pub const AF_INET: i32 = 2;
    pub const AF_INET6: i32 = 30;
    pub const SOCKINFO_TCP: i32 = 2;
    pub const TSI_S_LISTEN: i32 = 1;
}

#[cfg(any(target_os = "macos", test))]
fn read_i32(buf: &[u8], at: usize) -> i32 {
    i32::from_ne_bytes(buf[at..at + 4].try_into().unwrap())
}

#[cfg(any(target_os = "macos", test))]
/// (port, address, family) of a macOS socket_fdinfo, when it is a TCP socket
/// in LISTEN state.
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
    match read_i32(buf, FAMILY) {
        AF_INET => {
            // in4in6_addr: the IPv4 address is its last four bytes.
            let v4: [u8; 4] = addr[12..16].try_into().unwrap();
            Some((port, std::net::Ipv4Addr::from(v4).to_string(), 4))
        }
        AF_INET6 => {
            let v6: [u8; 16] = addr.try_into().unwrap();
            Some((port, std::net::Ipv6Addr::from(v6).to_string(), 6))
        }
        _ => None,
    }
}

#[cfg(any(target_os = "linux", test))]
/// The listening sockets of `/proc/net/tcp` or `tcp6` (state 0A), as
/// (inode, port, address, family). Each address word is printed in host
/// byte order.
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

#[cfg(any(target_os = "linux", test))]
/// The inode of a `/proc/<pid>/fd/<n>` link to a socket (`socket:[1234]`).
pub(super) fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
pub use macos_sys::listening;

#[cfg(target_os = "macos")]
mod macos_sys {
    use super::{fdinfo, parse_socket_fdinfo, ListenSocket};
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
    }

    /// The socket descriptors `pid` has open; empty when it cannot be read.
    fn socket_fds(pid: c_int) -> Vec<c_int> {
        // SAFETY: a null buffer asks only for the size.
        let needed = unsafe { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if needed <= 0 {
            return Vec::new();
        }
        // Headroom for descriptors opened since the size query.
        let mut buf = vec![0u8; needed as usize + 32 * FDINFO_SIZE];
        // SAFETY: the buffer is `buf.len()` bytes and writable.
        let got = unsafe {
            proc_pidinfo(
                pid,
                PROC_PIDLISTFDS,
                0,
                buf.as_mut_ptr().cast(),
                buf.len() as c_int,
            )
        };
        if got <= 0 {
            return Vec::new();
        }
        buf[..got as usize]
            .as_chunks::<FDINFO_SIZE>()
            .0
            .iter()
            .filter(|e| u32::from_ne_bytes(e[4..8].try_into().unwrap()) == PROX_FDTYPE_SOCKET)
            .map(|e| c_int::from_ne_bytes(e[0..4].try_into().unwrap()))
            .collect()
    }

    /// Every listening TCP socket of every process this user can read.
    pub fn listening() -> Result<Vec<ListenSocket>, String> {
        let mut out = Vec::new();
        let mut info = vec![0u64; fdinfo::SIZE.div_ceil(8)];
        for row in super::super::snapshot(false)? {
            let Ok(pid) = c_int::try_from(row.pid) else {
                continue;
            };
            for fd in socket_fds(pid) {
                // SAFETY: the buffer is at least fdinfo::SIZE bytes and writable.
                let got = unsafe {
                    proc_pidfdinfo(
                        pid,
                        fd,
                        PROC_PIDFDSOCKETINFO,
                        info.as_mut_ptr().cast(),
                        fdinfo::SIZE as c_int,
                    )
                };
                if got as usize != fdinfo::SIZE {
                    continue;
                }
                let bytes: Vec<u8> = info.iter().flat_map(|w| w.to_ne_bytes()).collect();
                if let Some((port, address, family)) = parse_socket_fdinfo(&bytes) {
                    out.push(ListenSocket {
                        pid: row.pid,
                        port,
                        address,
                        family,
                    });
                }
            }
        }
        Ok(out)
    }
}

#[cfg(target_os = "linux")]
pub use linux_sys::listening;

#[cfg(target_os = "linux")]
mod linux_sys {
    use super::{parse_net_tcp, socket_inode, ListenSocket};
    use std::collections::HashMap;

    /// Every listening TCP socket held by a process this user can read: the
    /// kernel's socket tables, joined to pids through `/proc/<pid>/fd`.
    pub fn listening() -> Result<Vec<ListenSocket>, String> {
        let mut by_inode: HashMap<u64, (u16, String, u8)> = HashMap::new();
        for (file, family) in [("/proc/net/tcp", 4), ("/proc/net/tcp6", 6)] {
            match std::fs::read_to_string(file) {
                Ok(text) => {
                    for (inode, port, address, family) in parse_net_tcp(&text, family) {
                        by_inode.insert(inode, (port, address, family));
                    }
                }
                // No IPv6 in this kernel.
                Err(e) if family == 6 && e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("read {file} failed ({e})")),
            }
        }
        let mut out = Vec::new();
        if by_inode.is_empty() {
            return Ok(out);
        }
        for pid in super::super::linux::proc_pids()? {
            // Another user's process, or one that exited: nothing to read.
            let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Some(inode) = std::fs::read_link(fd.path())
                    .ok()
                    .and_then(|l| l.to_str().and_then(socket_inode))
                else {
                    continue;
                };
                if let Some((port, address, family)) = by_inode.get(&inode) {
                    out.push(ListenSocket {
                        pid,
                        port: *port,
                        address: address.clone(),
                        family: *family,
                    });
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fdinfo_bytes(kind: i32, state: i32, family: i32, port: u16, addr: [u8; 16]) -> Vec<u8> {
        use fdinfo::*;
        let mut b = vec![0u8; SIZE];
        b[KIND..KIND + 4].copy_from_slice(&kind.to_ne_bytes());
        b[TCP_STATE..TCP_STATE + 4].copy_from_slice(&state.to_ne_bytes());
        b[FAMILY..FAMILY + 4].copy_from_slice(&family.to_ne_bytes());
        b[LPORT..LPORT + 4].copy_from_slice(&i32::from(port.to_be()).to_ne_bytes());
        b[LADDR..LADDR + 16].copy_from_slice(&addr);
        b
    }

    #[test]
    fn macos_socket_info_parses() {
        let mut v4 = [0u8; 16];
        v4[12..].copy_from_slice(&[127, 0, 0, 1]);
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 2, 5173, v4)),
            Some((5173, "127.0.0.1".into(), 4))
        );
        let mut v6 = [0u8; 16];
        v6[15] = 1;
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 30, 3000, v6)),
            Some((3000, "::1".into(), 6))
        );
        assert_eq!(
            parse_socket_fdinfo(&fdinfo_bytes(2, 1, 30, 8080, [0; 16])),
            Some((8080, "::".into(), 6))
        );
        // Established (4), not TCP (UDP: 1), not inet (unix: 1), short buffer.
        assert_eq!(parse_socket_fdinfo(&fdinfo_bytes(2, 4, 2, 80, v4)), None);
        assert_eq!(parse_socket_fdinfo(&fdinfo_bytes(1, 1, 2, 80, v4)), None);
        assert_eq!(parse_socket_fdinfo(&fdinfo_bytes(2, 1, 1, 80, v4)), None);
        assert_eq!(parse_socket_fdinfo(&[0u8; 100]), None);
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn lists_this_process_listeners() {
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").expect("bind v4");
        let v6 = std::net::TcpListener::bind("[::1]:0").ok();
        let rows = listening().expect("listening");
        let me = std::process::id();
        let port = v4.local_addr().unwrap().port();
        assert!(
            rows.contains(&ListenSocket {
                pid: me,
                port,
                address: "127.0.0.1".into(),
                family: 4
            }),
            "{rows:?}"
        );
        if let Some(v6) = v6 {
            let port = v6.local_addr().unwrap().port();
            assert!(rows.contains(&ListenSocket {
                pid: me,
                port,
                address: "::1".into(),
                family: 6
            }));
        }
        // A connected (not listening) socket is not listed.
        let client = std::net::TcpStream::connect(v4.local_addr().unwrap()).expect("connect");
        let local = client.local_addr().unwrap().port();
        let rows = listening().expect("listening");
        assert!(!rows.iter().any(|r| r.pid == me && r.port == local));
    }
}
