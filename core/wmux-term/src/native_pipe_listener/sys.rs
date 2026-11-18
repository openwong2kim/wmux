//! Raw kernel32/advapi32/ntdll declarations and small owned-handle helpers.
//! No bindings crate, as in process_table/windows.rs.

use std::ffi::c_void;
use std::sync::OnceLock;

pub(super) type Handle = *mut c_void;
pub(super) type Bool = i32;

pub(super) const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
pub(super) const INFINITE: u32 = u32::MAX;
pub(super) const WAIT_OBJECT_0: u32 = 0;
pub(super) const WAIT_TIMEOUT: u32 = 258;

pub(super) const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
pub(super) const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
pub(super) const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
pub(super) const PIPE_TYPE_BYTE: u32 = 0;
pub(super) const PIPE_READMODE_BYTE: u32 = 0;
pub(super) const PIPE_WAIT: u32 = 0;
pub(super) const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
pub(super) const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

pub(super) const ERROR_ACCESS_DENIED: u32 = 5;
pub(super) const ERROR_HANDLE_EOF: u32 = 38;
pub(super) const ERROR_BROKEN_PIPE: u32 = 109;
pub(super) const ERROR_PIPE_BUSY: u32 = 231;
pub(super) const ERROR_NO_DATA: u32 = 232;
pub(super) const ERROR_PIPE_NOT_CONNECTED: u32 = 233;
pub(super) const ERROR_MORE_DATA: u32 = 234;
pub(super) const ERROR_PIPE_CONNECTED: u32 = 535;
pub(super) const ERROR_OPERATION_ABORTED: u32 = 995;
pub(super) const ERROR_IO_PENDING: u32 = 997;

pub(super) const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
pub(super) const STILL_ACTIVE: u32 = 259;
pub(super) const TOKEN_QUERY: u32 = 0x0008;
pub(super) const TOKEN_USER_CLASS: u32 = 1;
pub(super) const TOKEN_INTEGRITY_LEVEL_CLASS: u32 = 25;
pub(super) const SDDL_REVISION_1: u32 = 1;
pub(super) const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;

/// FILETIME ticks (100 ns since 1601) at the Unix epoch.
pub(super) const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[repr(C)]
pub(super) struct Overlapped {
    pub internal: usize,
    pub internal_high: usize,
    pub offset: u32,
    pub offset_high: u32,
    pub event: Handle,
}

impl Overlapped {
    pub(super) fn with_event(event: Handle) -> Box<Self> {
        Box::new(Self {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event,
        })
    }
    pub(super) fn rearm(&mut self) {
        self.internal = 0;
        self.internal_high = 0;
        self.offset = 0;
        self.offset_high = 0;
        // SAFETY: the event is owned by the caller for the life of this struct.
        unsafe { ResetEvent(self.event) };
    }
}

#[repr(C)]
pub(super) struct SecurityAttributes {
    pub length: u32,
    pub descriptor: *mut c_void,
    pub inherit_handle: Bool,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
pub(super) struct FileTime {
    pub low: u32,
    pub high: u32,
}

impl FileTime {
    pub(super) fn ticks(self) -> u64 {
        (u64::from(self.high) << 32) | u64::from(self.low)
    }
}

#[repr(C)]
pub(super) struct SidAndAttributes {
    pub sid: *mut c_void,
    pub attributes: u32,
}

#[repr(C)]
pub(super) struct ProcessBasicInformation {
    pub exit_status: i32,
    pub peb_base_address: *mut c_void,
    pub affinity_mask: usize,
    pub base_priority: i32,
    pub unique_process_id: usize,
    pub inherited_from_unique_process_id: usize,
}

#[link(name = "kernel32")]
extern "system" {
    pub(super) fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer_size: u32,
        in_buffer_size: u32,
        default_timeout: u32,
        security_attributes: *const SecurityAttributes,
    ) -> Handle;
    pub(super) fn ConnectNamedPipe(pipe: Handle, overlapped: *mut Overlapped) -> Bool;
    pub(super) fn DisconnectNamedPipe(pipe: Handle) -> Bool;
    pub(super) fn GetNamedPipeClientProcessId(pipe: Handle, pid: *mut u32) -> Bool;
    pub(super) fn GetNamedPipeClientSessionId(pipe: Handle, session: *mut u32) -> Bool;
    pub(super) fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> Bool;
    pub(super) fn CreateEventW(
        attributes: *const c_void,
        manual_reset: Bool,
        initial_state: Bool,
        name: *const u16,
    ) -> Handle;
    pub(super) fn SetEvent(event: Handle) -> Bool;
    pub(super) fn ResetEvent(event: Handle) -> Bool;
    pub(super) fn CreateSemaphoreW(
        attributes: *const c_void,
        initial: i32,
        maximum: i32,
        name: *const u16,
    ) -> Handle;
    pub(super) fn ReleaseSemaphore(semaphore: Handle, count: i32, previous: *mut i32) -> Bool;
    pub(super) fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    pub(super) fn WaitForMultipleObjects(
        count: u32,
        handles: *const Handle,
        wait_all: Bool,
        milliseconds: u32,
    ) -> u32;
    pub(super) fn GetOverlappedResult(
        file: Handle,
        overlapped: *mut Overlapped,
        transferred: *mut u32,
        wait: Bool,
    ) -> Bool;
    pub(super) fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> Bool;
    pub(super) fn ReadFile(
        file: Handle,
        buffer: *mut u8,
        len: u32,
        read: *mut u32,
        overlapped: *mut Overlapped,
    ) -> Bool;
    pub(super) fn WriteFile(
        file: Handle,
        buffer: *const u8,
        len: u32,
        written: *mut u32,
        overlapped: *mut Overlapped,
    ) -> Bool;
    pub(super) fn CloseHandle(handle: Handle) -> Bool;
    pub(super) fn GetLastError() -> u32;
    pub(super) fn GetCurrentProcess() -> Handle;
    pub(super) fn GetCurrentProcessId() -> u32;
    pub(super) fn OpenProcess(access: u32, inherit: Bool, pid: u32) -> Handle;
    pub(super) fn GetProcessTimes(
        process: Handle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> Bool;
    pub(super) fn GetExitCodeProcess(process: Handle, code: *mut u32) -> Bool;
    pub(super) fn GetSystemTimePreciseAsFileTime(time: *mut FileTime);
    pub(super) fn GetProcessHandleCount(process: Handle, count: *mut u32) -> Bool;
    pub(super) fn LocalFree(memory: *mut c_void) -> *mut c_void;
    pub(super) fn GetModuleHandleW(name: *const u16) -> Handle;
    pub(super) fn GetProcAddress(module: Handle, name: *const u8) -> *const c_void;
}

#[link(name = "advapi32")]
extern "system" {
    pub(super) fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> Bool;
    pub(super) fn GetTokenInformation(
        token: Handle,
        class: u32,
        info: *mut c_void,
        len: u32,
        returned: *mut u32,
    ) -> Bool;
    pub(super) fn EqualSid(a: *const c_void, b: *const c_void) -> Bool;
    pub(super) fn GetLengthSid(sid: *const c_void) -> u32;
    pub(super) fn CopySid(len: u32, dest: *mut c_void, source: *const c_void) -> Bool;
    pub(super) fn IsValidSid(sid: *const c_void) -> Bool;
    pub(super) fn GetSidSubAuthorityCount(sid: *const c_void) -> *mut u8;
    pub(super) fn GetSidSubAuthority(sid: *const c_void, index: u32) -> *mut u32;
    pub(super) fn ConvertSidToStringSidW(sid: *const c_void, out: *mut *mut u16) -> Bool;
    pub(super) fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> Bool;
}

type NtQueryInformationProcess =
    unsafe extern "system" fn(Handle, u32, *mut c_void, u32, *mut u32) -> i32;

pub(super) fn nt_query_information_process() -> Option<NtQueryInformationProcess> {
    static ADDR: OnceLock<usize> = OnceLock::new();
    let addr = *ADDR.get_or_init(|| {
        let module_name = wide("ntdll.dll");
        // SAFETY: NUL-terminated names; a null module or proc yields 0.
        unsafe {
            let module = GetModuleHandleW(module_name.as_ptr());
            if module.is_null() {
                return 0;
            }
            GetProcAddress(module, c"NtQueryInformationProcess".as_ptr().cast()) as usize
        }
    });
    // SAFETY: a non-zero address is ntdll's export with this documented signature.
    (addr != 0).then(|| unsafe { std::mem::transmute::<usize, NtQueryInformationProcess>(addr) })
}

pub(super) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(super) fn last_error() -> u32 {
    // SAFETY: no preconditions.
    unsafe { GetLastError() }
}

pub(super) fn os_error(operation: &str, code: u32) -> String {
    format!("{operation} failed ({code})")
}

/// A kernel handle this module owns and closes once.
pub(super) struct OwnedHandle(Handle);
// SAFETY: kernel handles are process-wide values, usable from any thread.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}
impl OwnedHandle {
    /// Takes ownership of `raw`; None for a null or INVALID_HANDLE_VALUE result.
    pub(super) fn from_raw(raw: Handle) -> Option<Self> {
        (!raw.is_null() && raw != INVALID_HANDLE_VALUE).then_some(Self(raw))
    }
    pub(super) fn raw(&self) -> Handle {
        self.0
    }
}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: only constructed from a valid, owned handle.
        unsafe { CloseHandle(self.0) };
    }
}

pub(super) fn event(manual_reset: bool) -> Result<OwnedHandle, String> {
    // SAFETY: unnamed event, default security, not inheritable.
    let raw = unsafe {
        CreateEventW(
            std::ptr::null(),
            Bool::from(manual_reset),
            0,
            std::ptr::null(),
        )
    };
    OwnedHandle::from_raw(raw).ok_or_else(|| os_error("CreateEventW", last_error()))
}

pub(super) fn set_event(event: &OwnedHandle) {
    // SAFETY: a valid event handle.
    unsafe { SetEvent(event.raw()) };
}

/// Index of the signalled handle, or None on timeout.
pub(super) fn wait_any(handles: &[Handle], milliseconds: u32) -> Result<Option<usize>, String> {
    // SAFETY: `handles` holds valid waitable handles for the call's duration.
    let result =
        unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, milliseconds) };
    if result == WAIT_TIMEOUT {
        return Ok(None);
    }
    let index = result.wrapping_sub(WAIT_OBJECT_0) as usize;
    if index < handles.len() {
        Ok(Some(index))
    } else {
        Err(os_error("WaitForMultipleObjects", last_error()))
    }
}

pub(super) fn now_ticks() -> u64 {
    let mut time = FileTime::default();
    // Precise: the coarse clock can lag a process creation time stamped
    // just before it.
    // SAFETY: writes one FILETIME.
    unsafe { GetSystemTimePreciseAsFileTime(&mut time) };
    time.ticks()
}

pub(super) fn epoch_ms(ticks: u64) -> f64 {
    (ticks as f64 - UNIX_EPOCH_TICKS as f64) / 10_000.0
}

/// Creation time of a process handle in FILETIME ticks.
pub(super) fn process_created(process: Handle) -> Option<u64> {
    let (mut creation, mut exit, mut kernel, mut user) = Default::default();
    // SAFETY: out-pointers are locals of the declared layout.
    let ok = unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
    (ok != 0).then(|| FileTime::ticks(creation))
}

/// The open handle count of this process (a test hook for leak checks).
pub(crate) fn process_handle_count() -> u32 {
    let mut count = 0;
    // SAFETY: the pseudo handle of this process; writes one u32.
    unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) };
    count
}
