//! The fallback to the full bundle: the session is handed to `node index.js`
//! with the shim's own arguments, before the shim has read a byte of stdin.
//!
//! Where the bundle and node come from mirrors the registration today
//! (McpRegistrar.getMcpScriptPath and mcpRegistration.registerTarget): the
//! registered entry is `command: "node"`, `args: [<script>, ...flags]`, and the
//! packaged shim.js and index.js are siblings in one bundle directory
//! (resources/mcp-bundle, copied whole to ~/.wmux/mcp). So the bundle is the
//! `index.js` beside this binary, and `node` is the bare name the host would
//! resolve from PATH for the registered command. Nothing else is searched.

use super::{exit_with, say, Outcome, PREFIX};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

/// The full bundle beside this binary. On Unix the binary's path is resolved
/// first, so a symlink to the binary still finds the bundle it ships with.
pub fn sibling_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("<beside this binary> ({e})"))?;
    #[cfg(unix)]
    let exe = exe.canonicalize().unwrap_or(exe);
    let index = exe.with_file_name("index.js");
    if index.is_file() {
        Ok(index)
    } else {
        Err(index.display().to_string())
    }
}

/// Run the session on the full bundle; never returns. `announce` says why on
/// stderr (the unreachable-broker case); bot mode is the designed path and
/// stays quiet.
pub fn run_full_bundle(args: &[OsString], announce: bool) -> ! {
    let index = match sibling_bundle() {
        Ok(index) => index,
        Err(path) => exit_with(Outcome::NoBundle(path)),
    };
    if announce {
        say(&format!(
            "{PREFIX} falling back to the full bundle at {}",
            index.display()
        ));
    }
    let mut cmd = Command::new("node");
    cmd.arg(&index).args(args);
    sys::hand_over(cmd)
}

#[cfg(unix)]
mod sys {
    use super::{exit_with, Outcome};
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    /// execvp: node replaces the shim under the same pid, so the host's child
    /// and its stdio stay exactly as they were.
    pub fn hand_over(mut cmd: Command) -> ! {
        let e = cmd.exec();
        exit_with(Outcome::BundleFailed(format!("node: {e}")))
    }
}

#[cfg(windows)]
mod sys {
    use super::{exit_with, say, Outcome, PREFIX};
    use core::ffi::c_void;
    use std::io::Error;
    use std::process::Command;

    type Handle = *mut c_void;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io_counters: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(security: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    /// Put the shim in a job that kills its members when its one handle
    /// closes. node is started after this, so it is in the job from its first
    /// instruction (no window to escape before an assignment), and it dies with
    /// the shim however the shim ends. The handle is not inheritable and is
    /// never closed: the process exit closes it.
    fn contain_in_job() -> std::io::Result<()> {
        // SAFETY: plain job calls on a handle this function owns; `info` is the
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout and outlives the call.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err(Error::last_os_error());
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&info as *const ExtendedLimitInformation).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                return Err(Error::last_os_error());
            }
        }
        Ok(())
    }

    /// Ctrl+C and Ctrl+Break reach node too (they go to the whole console);
    /// the shim outlives them so it can pass node's exit code on.
    unsafe extern "system" fn outlive_console_breaks(event: u32) -> i32 {
        i32::from(event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT)
    }

    /// Run node as a child with the inherited stdio, in the job, and exit with
    /// its exit code.
    pub fn hand_over(mut cmd: Command) -> ! {
        if let Err(e) = contain_in_job() {
            say(&format!("{PREFIX} the full bundle runs outside a job object: {e}"));
        }
        // SAFETY: registers a handler that only returns a value.
        unsafe { SetConsoleCtrlHandler(Some(outlive_console_breaks), 1) };
        match cmd.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(e) => exit_with(Outcome::BundleFailed(format!("node: {e}"))),
        }
    }
}
