use super::WinChild;
use crate::cmdbuilder::CommandBuilder;
use crate::win::procthreadattr::ProcThreadAttributeList;
use anyhow::{bail, ensure, Error};
use filedescriptor::{FileDescriptor, OwnedHandle};
use std::ffi::OsString;
use std::io::Error as IoError;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::sync::Mutex;
use winapi::um::jobapi2::*;
use winapi::um::winnt::{JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
use winapi::um::winbase::CREATE_SUSPENDED;
use std::{mem, ptr};
use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::{HRESULT, S_OK};
use winapi::um::handleapi::*;
use winapi::um::processthreadsapi::*;
use winapi::um::winbase::{
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use winapi::shared::windef::HWND;
use winapi::um::wincon::COORD;
use winapi::um::winnt::HANDLE;

pub type HPCON = HANDLE;

type CreateFn = unsafe extern "system" fn(COORD, HANDLE, HANDLE, DWORD, *mut HPCON) -> HRESULT;
type ResizeFn = unsafe extern "system" fn(HPCON, COORD) -> HRESULT;
type CloseFn = unsafe extern "system" fn(HPCON);
type ClearFn = unsafe extern "system" fn(HPCON) -> HRESULT;
type ReparentFn = unsafe extern "system" fn(HPCON, HWND) -> HRESULT;
#[allow(non_snake_case)]
struct ConPtyFuncs {
    library: winapi::shared::minwindef::HMODULE,
    CreatePseudoConsole: CreateFn,
    ResizePseudoConsole: ResizeFn,
    ClosePseudoConsole: CloseFn,
    clear: Option<ClearFn>,
    release: Option<ClearFn>,
    reparent: Option<ReparentFn>,
}
unsafe impl Send for ConPtyFuncs {}
impl Drop for ConPtyFuncs {
    fn drop(&mut self) { unsafe { winapi::um::libloaderapi::FreeLibrary(self.library); } }
}
fn load_conpty(dll: Option<&Path>) -> Result<ConPtyFuncs, Error> {
    use winapi::um::libloaderapi::{LoadLibraryExW, GetProcAddress, FreeLibrary};
    let system;
    let file = if let Some(dll) = dll { dll } else {
        let mut dir = vec![0u16; 32768];
        let n = unsafe { winapi::um::sysinfoapi::GetSystemDirectoryW(dir.as_mut_ptr(), dir.len() as u32) } as usize;
        ensure!(n > 0 && n < dir.len(), "Failed to locate system ConPTY");
        system = std::path::PathBuf::from(OsString::from_wide(&dir[..n])).join("kernel32.dll");
        &system
    };
    ensure!(file.is_absolute(), "Failed to load conpty.dll: absolute path required");
    let wide: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
    // Search adjacent dependencies and System32 only, never child CWD or PATH.
    let library = unsafe { LoadLibraryExW(wide.as_ptr(), ptr::null_mut(), 0x100 | 0x800) };
    ensure!(!library.is_null(), "Failed to load conpty.dll: {}", IoError::last_os_error());
    let prefix = if dll.is_some() { "Conpty" } else { "" };
    let symbol = |name: &str| {
        let name = std::ffi::CString::new(format!("{}{}", prefix, name)).unwrap();
        unsafe { GetProcAddress(library, name.as_ptr()) }
    };
    let create = symbol("CreatePseudoConsole");
    let resize = symbol("ResizePseudoConsole");
    let close = symbol("ClosePseudoConsole");
    if create.is_null() || resize.is_null() || close.is_null() {
        unsafe { FreeLibrary(library); }
        bail!("Failed to load conpty.dll: required exports missing");
    }
    let clear = symbol("ClearPseudoConsole");
    let release = symbol("ReleasePseudoConsole");
    // Only the bundled conpty.dll exports it (ConptyReparentPseudoConsole); kernel32 has none.
    let reparent = symbol("ReparentPseudoConsole");
    Ok(ConPtyFuncs { library,
        CreatePseudoConsole: unsafe { mem::transmute(create) },
        ResizePseudoConsole: unsafe { mem::transmute(resize) },
        ClosePseudoConsole: unsafe { mem::transmute(close) },
        clear: if clear.is_null() { None } else { Some(unsafe { mem::transmute(clear) }) },
        release: if release.is_null() { None } else { Some(unsafe { mem::transmute(release) }) },
        reparent: if reparent.is_null() { None } else { Some(unsafe { mem::transmute(reparent) }) },
    })
}

pub struct PsuedoCon {
    con: HPCON,
    functions: ConPtyFuncs,
}

unsafe impl Send for PsuedoCon {}
unsafe impl Sync for PsuedoCon {}

impl Drop for PsuedoCon {
    fn drop(&mut self) {
        unsafe { (self.functions.ClosePseudoConsole)(self.con) };
    }
}

impl PsuedoCon {
    pub fn new(size: COORD, input: FileDescriptor, output: FileDescriptor, dll: Option<&Path>) -> Result<Self, Error> {
        let functions = load_conpty(dll)?;
        let mut con: HPCON = INVALID_HANDLE_VALUE;
        let result = unsafe {
            (functions.CreatePseudoConsole)(
                size,
                input.as_raw_handle() as _,
                output.as_raw_handle() as _,
                0,
                &mut con,
            )
        };
        ensure!(
            result == S_OK,
            "Cannot launch conpty: HRESULT {}",
            result
        );
        Ok(Self { con, functions })
    }

    pub fn resize(&self, size: COORD) -> Result<(), Error> {
        let result = unsafe { (self.functions.ResizePseudoConsole)(self.con, size) };
        ensure!(
            result == S_OK,
            "failed to resize console to {}x{}: HRESULT: {}",
            size.X,
            size.Y,
            result
        );
        Ok(())
    }

    pub fn clear(&self) {
        if let Some(clear) = self.functions.clear { unsafe { clear(self.con); } }
    }

    /// Ask ConPTY to make `hwnd` the owner of the window GetConsoleWindow() returns, so a
    /// window a console program parents to it (a sign-in prompt) stacks above `hwnd`.
    /// ConPTY applies it asynchronously. False when this ConPTY has no reparent call.
    pub fn reparent(&self, hwnd: HWND) -> bool {
        match self.functions.reparent {
            Some(reparent) => (unsafe { reparent(self.con, hwnd) }) >= 0,
            None => false,
        }
    }

    pub fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<WinChild> {
        let mut si: STARTUPINFOEXW = unsafe { mem::zeroed() };
        si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        // Explicitly set the stdio handles as invalid handles otherwise
        // we can end up with a weird state where the spawned process can
        // inherit the explicitly redirected output handles from its parent.
        // For example, when daemonizing wezterm-mux-server, the stdio handles
        // are redirected to a log file and the spawned process would end up
        // writing its output there instead of to the pty we just created.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;

        let mut attrs = ProcThreadAttributeList::with_capacity(1)?;
        attrs.set_pty(self.con)?;
        si.lpAttributeList = attrs.as_mut_ptr();

        let mut pi: PROCESS_INFORMATION = unsafe { mem::zeroed() };

        let (mut exe, mut cmdline) = cmd.cmdline()?;
        let cmd_os = OsString::from_wide(&cmdline);

        let cwd = cmd.current_directory();

        let res = unsafe {
            CreateProcessW(
                exe.as_mut_slice().as_mut_ptr(),
                cmdline.as_mut_slice().as_mut_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                cmd.environment_block().as_mut_slice().as_mut_ptr() as *mut _,
                cwd.as_ref()
                    .map(|c| c.as_slice().as_ptr())
                    .unwrap_or(ptr::null()),
                &mut si.StartupInfo,
                &mut pi,
            )
        };
        if res == 0 {
            let err = IoError::last_os_error();
            let msg = format!(
                "CreateProcessW `{:?}` in cwd `{:?}` failed: {}",
                cmd_os,
                cwd.as_ref().map(|c| OsString::from_wide(c)),
                err
            );
            log::error!("{}", msg);
            bail!("{}", msg);
        }

        // Make sure we close out the thread handle so we don't leak it;
        // we do this simply by making it owned
        let _main_thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread as _) };
        let proc = unsafe { OwnedHandle::from_raw_handle(pi.hProcess as _) };

        let job_raw = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
        if job_raw.is_null() {
            unsafe { TerminateProcess(pi.hProcess, 1); }
            return Err(IoError::last_os_error().into());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(job_raw as _) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe { SetInformationJobObject(job_raw, JobObjectExtendedLimitInformation, &mut limits as *mut _ as _, mem::size_of_val(&limits) as u32) } == 0
            || unsafe { AssignProcessToJobObject(job_raw, pi.hProcess) } == 0 {
            let err = IoError::last_os_error();
            unsafe { TerminateProcess(pi.hProcess, 1); }
            return Err(err.into());
        }
        if unsafe { ResumeThread(pi.hThread) } == u32::MAX {
            let err = IoError::last_os_error();
            unsafe { TerminateJobObject(job_raw, 1); }
            return Err(err.into());
        }
        if let Some(release) = self.functions.release { unsafe { release(self.con); } }
        Ok(WinChild { proc: Mutex::new(proc), job: Mutex::new(job) })
    }
}
