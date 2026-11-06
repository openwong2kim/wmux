//! The fallback to the full bundle: the session is handed to node and the
//! bundle's entry script, with the shim's own arguments, before the shim has
//! read a byte of stdin.
//!
//! The registration runs the bundle as `command: "node"`, `args: [<script>,
//! ...flags]`. The entry script is one of three fixed places, tried in order
//! from the binary's own (canonical) directory:
//!   1. `index.js` beside the binary, only when the stable bundle's version
//!      marker (`.wmux-mcp-version`) is there too: the binary sits in the
//!      stabilised bundle directory;
//!   2. `../mcp-bundle/index.js`: the packaged layout, where the binary ships
//!      in a sibling resources directory;
//!   3. a development build (`core/wmux-native/target/{debug,release}`): the
//!      repository's `dist/mcp/mcp/entry.js` (there, index.js is the server
//!      factory and entry.js the stdio entry).

use super::{exit_with, say, Outcome, PREFIX};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The stable bundle's version marker (MCP_VERSION_MARKER in stabilizeBundle.ts).
const VERSION_MARKER: &str = ".wmux-mcp-version";

/// The places `find_bundle` looks for the entry script, in order, for a
/// binary in `exe_dir`. Each is paired with whether its precondition holds.
fn candidates(exe_dir: &Path) -> Vec<(PathBuf, bool)> {
    let mut out = vec![
        (exe_dir.join("index.js"), exe_dir.join(VERSION_MARKER).is_file()),
        (exe_dir.join("..").join("mcp-bundle").join("index.js"), true),
    ];
    let names: Vec<_> = exe_dir.iter().rev().take(4).collect();
    let in_target = names.len() == 4
        && (names[0] == "debug" || names[0] == "release")
        && names[1] == "target"
        && names[2] == "wmux-native"
        && names[3] == "core";
    if let (true, Some(repo)) = (in_target, exe_dir.ancestors().nth(4)) {
        out.push((repo.join("dist").join("mcp").join("mcp").join("entry.js"), true));
    }
    out
}

/// The first candidate whose precondition holds and whose file exists, or the
/// list of places looked at.
pub fn find_bundle(exe_dir: &Path) -> Result<PathBuf, Vec<PathBuf>> {
    let all = candidates(exe_dir);
    match all.iter().find(|(path, ok)| *ok && path.is_file()) {
        Some((path, _)) => Ok(path.clone()),
        None => Err(all.into_iter().map(|(path, _)| path).collect()),
    }
}

/// The directory of this binary, symlinks resolved.
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate this binary: {e}"))?;
    #[cfg(unix)]
    let exe = exe.canonicalize().unwrap_or(exe);
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "cannot locate this binary's directory".into())
}

/// Run the session on the full bundle; never returns. `announce` says so on
/// stderr (a broker that did not take the session); bot mode is the designed
/// path and stays quiet.
pub fn run_full_bundle(args: &[OsString], announce: bool) -> ! {
    let entry = match exe_dir().map(|dir| find_bundle(&dir)) {
        Ok(Ok(entry)) => entry,
        Ok(Err(looked)) => {
            let looked: Vec<String> = looked.iter().map(|p| p.display().to_string()).collect();
            exit_with(Outcome::NoBundle(looked.join(", ")))
        }
        Err(why) => exit_with(Outcome::NoBundle(why)),
    };
    if announce {
        say(&format!(
            "{PREFIX} falling back to the full bundle at {}",
            entry.display()
        ));
    }
    sys::hand_over(&entry, args)
}

/// The first `node.exe` in an absolute PATH entry, in PATH order. Relative
/// entries are skipped, and so are the binary's own directory and the working
/// directory unless PATH names them absolutely; no PATHEXT, no `.cmd`.
#[cfg(any(windows, test))]
pub fn node_on_path(path_var: Option<OsString>) -> Option<PathBuf> {
    std::env::split_paths(&path_var?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("node.exe"))
        .find(|node| node.is_file())
}

#[cfg(unix)]
mod sys {
    use super::{exit_with, Outcome};
    use std::ffi::OsString;
    use std::os::unix::process::CommandExt;
    use std::path::Path;

    /// execvp of `node`, as the registration's command names it: node replaces
    /// the shim under the same pid, with the host's stdio as it was.
    pub fn hand_over(entry: &Path, args: &[OsString]) -> ! {
        let e = super::Command::new("node").arg(entry).args(args).exec();
        exit_with(Outcome::BundleFailed(format!("node: {e}")))
    }
}

#[cfg(windows)]
mod sys {
    use super::{exit_with, node_on_path, Outcome};
    use core::ffi::c_void;
    use std::ffi::OsString;
    use std::io::Error;
    use std::path::Path;

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
    /// instruction, and it dies with the shim however the shim ends. The
    /// handle is not inheritable and is never closed: the process exit closes it.
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
    /// its exit code. Without a job (or without node.exe on PATH) nothing is
    /// started: an uncontained node could outlive the shim.
    pub fn hand_over(entry: &Path, args: &[OsString]) -> ! {
        let Some(node) = node_on_path(std::env::var_os("PATH")) else {
            exit_with(Outcome::BundleFailed("no node.exe on PATH".into()))
        };
        if let Err(e) = contain_in_job() {
            exit_with(Outcome::BundleFailed(format!("cannot create its job object: {e}")))
        }
        // SAFETY: registers a handler that only returns a value.
        unsafe { SetConsoleCtrlHandler(Some(outlive_console_breaks), 1) };
        match super::Command::new(&node).arg(entry).args(args).status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(e) => exit_with(Outcome::BundleFailed(format!("{}: {e}", node.display()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory tree under the test's temp dir.
    struct Tree(PathBuf);

    impl Tree {
        fn new(tag: &str) -> Tree {
            let root = std::env::temp_dir().join(format!("wmsf-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Tree(root)
        }

        fn file(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, b"").unwrap();
            p
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            p
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn index_beside_the_binary_counts_only_with_the_version_marker() {
        let t = Tree::new("marker");
        let bin = t.dir("mcp");
        let index = t.file("mcp/index.js");
        assert!(find_bundle(&bin).is_err());
        t.file("mcp/.wmux-mcp-version");
        assert_eq!(find_bundle(&bin), Ok(index));
    }

    #[test]
    fn the_packaged_layout_is_a_sibling_mcp_bundle() {
        let t = Tree::new("packaged");
        let bin = t.dir("resources/native-hooks");
        let index = t.file("resources/mcp-bundle/index.js");
        assert_eq!(
            find_bundle(&bin).map(|p| p.canonicalize().unwrap()),
            Ok(index.canonicalize().unwrap())
        );
    }

    #[test]
    fn a_development_build_runs_the_repository_entry_script() {
        let t = Tree::new("dev");
        let entry = t.file("repo/dist/mcp/mcp/entry.js");
        t.file("repo/dist/mcp/mcp/index.js");
        for profile in ["debug", "release"] {
            let bin = t.dir(&format!("repo/core/wmux-native/target/{profile}"));
            assert_eq!(find_bundle(&bin), Ok(entry.clone()), "{profile}");
        }
        // Anywhere else, the entry script is not looked for.
        let elsewhere = t.dir("repo/core/other/target/debug");
        let looked = find_bundle(&elsewhere).unwrap_err();
        assert_eq!(looked.len(), 2);
    }

    #[test]
    fn no_bundle_lists_every_place_looked_at() {
        let t = Tree::new("none");
        let bin = t.dir("x/core/wmux-native/target/debug");
        let looked = find_bundle(&bin).unwrap_err();
        assert_eq!(looked.len(), 3);
        assert!(looked[0].ends_with("index.js") && looked[2].ends_with("entry.js"));
    }

    #[test]
    fn node_is_the_first_node_exe_in_an_absolute_path_entry() {
        let t = Tree::new("node");
        let first = t.dir("a");
        let second = t.dir("b");
        t.file("b/node.exe");
        t.file("c/node.exe");
        t.file("b/node.cmd");
        let path = std::env::join_paths([first.clone(), PathBuf::from("c"), second.clone(), t.0.join("c")]).unwrap();
        // The relative `c` is skipped although ./c/node.exe may exist.
        assert_eq!(node_on_path(Some(path)), Some(second.join("node.exe")));
        let only_cmd = std::env::join_paths([first]).unwrap();
        assert_eq!(node_on_path(Some(only_cmd)), None);
        assert_eq!(node_on_path(None), None);
    }
}
