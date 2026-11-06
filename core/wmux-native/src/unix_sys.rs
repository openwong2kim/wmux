//! The few libc calls and constants the unix socket code needs, with no
//! dependency: one extern block, and the per-platform ABI (sockaddr_un layout,
//! flag values). Only macOS and Linux/Android layouts are known; any other
//! unix fails the build instead of guessing one.

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
compile_error!("wmux-native knows the unix socket ABI of macOS and Linux only");

#[repr(C)]
pub struct PollFd {
    pub fd: i32,
    pub events: i16,
    pub revents: i16,
}

#[cfg(target_os = "macos")]
pub type NFds = std::os::raw::c_uint;
#[cfg(any(target_os = "linux", target_os = "android"))]
pub type NFds = std::os::raw::c_ulong;

extern "C" {
    pub fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
    pub fn connect(fd: i32, addr: *const u8, len: u32) -> i32;
    pub fn close(fd: i32) -> i32;
    pub fn poll(fds: *mut PollFd, nfds: NFds, timeout: i32) -> i32;
    pub fn fcntl(fd: i32, cmd: i32, ...) -> i32;
}

pub const AF_UNIX: i32 = 1;
pub const SOCK_STREAM: i32 = 1;
pub const F_GETFD: i32 = 1;
pub const F_SETFD: i32 = 2;
pub const FD_CLOEXEC: i32 = 1;

pub const POLLIN: i16 = 0x1;
pub const POLLOUT: i16 = 0x4;
pub const POLLERR: i16 = 0x8;
pub const POLLHUP: i16 = 0x10;
pub const POLLNVAL: i16 = 0x20;

pub const EINTR: i32 = 4;
pub const EBADF: i32 = 9;

#[cfg(target_os = "macos")]
pub const ENAMETOOLONG: i32 = 63;
#[cfg(any(target_os = "linux", target_os = "android"))]
pub const ENAMETOOLONG: i32 = 36;

/// Linux sets close-on-exec atomically at socket(); macOS needs fcntl after.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub const SOCK_CLOEXEC: i32 = 0o2000000;

/// A `sockaddr_un` for `path`, or None when it cannot hold it (too long, or
/// a NUL inside). macOS: sun_len, sun_family, path, NUL; a path past the
/// 104-byte `sun_path` is allowed when sun_len says so, as libuv relies on.
#[cfg(target_os = "macos")]
pub fn sockaddr_un(path: &[u8]) -> Option<Vec<u8>> {
    let len = 2 + path.len() + 1;
    if len > 255 || path.contains(&0) {
        return None;
    }
    let mut addr = vec![0u8; len];
    addr[0] = len as u8;
    addr[1] = AF_UNIX as u8;
    addr[2..2 + path.len()].copy_from_slice(path);
    Some(addr)
}

/// Linux: sun_family, then the path and its NUL within the 108-byte `sun_path`.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn sockaddr_un(path: &[u8]) -> Option<Vec<u8>> {
    if path.len() >= 108 || path.contains(&0) {
        return None;
    }
    let mut addr = vec![0u8; 2 + path.len() + 1];
    addr[..2].copy_from_slice(&(AF_UNIX as u16).to_ne_bytes());
    addr[2..2 + path.len()].copy_from_slice(path);
    Some(addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sockaddr_un_holds_the_path_and_refuses_what_it_cannot() {
        let addr = sockaddr_un(b"/tmp/x.sock").unwrap();
        assert_eq!(&addr[2..addr.len() - 1], b"/tmp/x.sock");
        assert_eq!(addr.last(), Some(&0));
        assert!(sockaddr_un(b"/tmp/a\0b").is_none());
        assert!(sockaddr_un(&[b'a'; 300]).is_none());
        #[cfg(target_os = "macos")]
        {
            assert_eq!(addr[0] as usize, addr.len());
            assert!(
                sockaddr_un(&[b'a'; 200]).is_some(),
                "macOS takes a long path via sun_len"
            );
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        assert!(sockaddr_un(&[b'a'; 108]).is_none());
    }
}
