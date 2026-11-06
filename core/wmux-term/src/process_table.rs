//! Process table for the daemon, in place of the processes it used to spawn
//! for it: tasklist and a PowerShell CIM query on Windows, `ps` on macOS and
//! Linux.
//!
//! The same rules hold on every OS:
//! - the liveness table (no details) is the walk alone, so a detail read that
//!   fails can never read as a death;
//! - a walk cut short is an error, never a shorter table;
//! - Windows only: a row's details are attached only when they provably
//!   belong to the walked process, and a row is never dropped because its
//!   details could not be read. macOS and Linux read no details.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
#[cfg_attr(not(feature = "native-core"), allow(unused_imports))]
pub use windows::snapshot;

#[cfg(any(target_os = "macos", test))]
mod macos;
#[cfg(target_os = "macos")]
#[cfg_attr(not(feature = "native-core"), allow(unused_imports))]
pub use macos::snapshot;

#[cfg(any(target_os = "linux", test))]
mod linux;
#[cfg(target_os = "linux")]
#[cfg_attr(not(feature = "native-core"), allow(unused_imports))]
pub use linux::snapshot;

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    /// Windows: the image file name. macOS and Linux: the kernel's short
    /// process name (`p_comm`, `comm`), as `ps -o ucomm` reads it.
    pub name: String,
    /// Creation time, epoch ms (Windows, with details). None when it could
    /// not be read.
    pub created: Option<f64>,
    /// Command line (Windows, with details). None when unreadable
    /// (protected, other session without rights, exited mid-walk) or empty.
    pub cmdline: Option<String>,
}
