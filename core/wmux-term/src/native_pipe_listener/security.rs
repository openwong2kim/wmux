//! The pipe's security descriptor (owner-only access) and token reads.

use super::sys::*;
use std::ffi::c_void;

/// A copied SID, in u32 storage for the SID's 4-byte alignment.
pub(crate) struct Sid(Vec<u32>);

impl Sid {
    /// Copies a SID that the caller keeps valid for the call.
    fn copy_from(sid: *const c_void) -> Option<Self> {
        // SAFETY: `sid` points at a SID for the duration of the call.
        unsafe {
            if sid.is_null() || IsValidSid(sid) == 0 {
                return None;
            }
            let len = GetLengthSid(sid);
            let mut storage = vec![0u32; (len as usize).div_ceil(4)];
            (CopySid(len, storage.as_mut_ptr().cast(), sid) != 0).then_some(Self(storage))
        }
    }
    pub(crate) fn as_ptr(&self) -> *const c_void {
        self.0.as_ptr().cast()
    }
    pub(crate) fn equals(&self, other: &Sid) -> bool {
        // SAFETY: both are valid copied SIDs.
        unsafe { EqualSid(self.as_ptr(), other.as_ptr()) != 0 }
    }
    /// The SID's string form ("S-1-5-21-...").
    pub(crate) fn to_sddl_string(&self) -> Result<String, String> {
        let mut out: *mut u16 = std::ptr::null_mut();
        // SAFETY: a valid SID; the returned string is LocalAlloc'ed and freed below.
        unsafe {
            if ConvertSidToStringSidW(self.as_ptr(), &mut out) == 0 || out.is_null() {
                return Err(os_error("ConvertSidToStringSidW", last_error()));
            }
            let mut len = 0;
            while *out.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(out, len));
            LocalFree(out.cast());
            Ok(text)
        }
    }
}

/// A token information block in u64 storage (aligned for its pointers).
fn token_information(token: Handle, class: u32) -> Result<Vec<u64>, u32> {
    let mut needed = 0u32;
    // SAFETY: a size query with no buffer.
    unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(last_error());
    }
    let mut storage = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `storage` holds at least `needed` bytes.
    let ok = unsafe {
        GetTokenInformation(
            token,
            class,
            storage.as_mut_ptr().cast(),
            (storage.len() * 8) as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(storage)
}

/// The token's user SID (TokenUser).
pub(crate) fn token_user(token: Handle) -> Result<Sid, u32> {
    let info = token_information(token, TOKEN_USER_CLASS)?;
    // SAFETY: TokenUser starts with a SID_AND_ATTRIBUTES whose SID lives in `info`.
    let sid = unsafe { (*(info.as_ptr() as *const SidAndAttributes)).sid };
    Sid::copy_from(sid).ok_or(0)
}

/// The RID of the token's mandatory integrity label (TokenIntegrityLevel).
pub(crate) fn token_integrity_rid(token: Handle) -> Result<u32, u32> {
    let info = token_information(token, TOKEN_INTEGRITY_LEVEL_CLASS)?;
    // SAFETY: TOKEN_MANDATORY_LABEL is one SID_AND_ATTRIBUTES whose SID lives in `info`.
    unsafe {
        let sid = (*(info.as_ptr() as *const SidAndAttributes)).sid;
        if sid.is_null() || IsValidSid(sid) == 0 {
            return Err(0);
        }
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return Err(0);
        }
        Ok(*GetSidSubAuthority(sid, u32::from(count) - 1))
    }
}

/// Opens a process's token for query; Err carries the Win32 error.
pub(crate) fn open_token(process: Handle) -> Result<OwnedHandle, u32> {
    let mut token: Handle = std::ptr::null_mut();
    // SAFETY: writes one handle.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error());
    }
    OwnedHandle::from_raw(token).ok_or(0)
}

/// This process's token user.
pub(crate) fn current_user() -> Result<Sid, String> {
    // SAFETY: the pseudo handle of this process.
    let token = open_token(unsafe { GetCurrentProcess() })
        .map_err(|code| os_error("OpenProcessToken", code))?;
    token_user(token.raw()).map_err(|code| os_error("GetTokenInformation(TokenUser)", code))
}

/// Owner = the user; protected DACL with full access for the user and
/// SYSTEM only. No Administrators and no Everyone entry. A Medium mandatory
/// label with no-write-up and no-read-up keeps processes below Medium
/// integrity (Low, AppContainer) from opening it at all, reading included.
/// A label at or below the creator's own integrity needs no privilege, so a
/// High-integrity creator sets it as well.
pub(crate) fn owner_only_sddl(user_sid: &str) -> String {
    format!("O:{user_sid}D:P(A;;GA;;;{user_sid})(A;;GA;;;SY)S:(ML;;NWNR;;;ME)")
}

/// A self-relative security descriptor from SDDL, freed with LocalFree.
pub(crate) struct SecurityDescriptor(*mut c_void);
// SAFETY: an immutable heap block after creation.
unsafe impl Send for SecurityDescriptor {}
unsafe impl Sync for SecurityDescriptor {}

impl SecurityDescriptor {
    pub(crate) fn from_sddl(sddl: &str) -> Result<Self, String> {
        let text = wide(sddl);
        let mut descriptor: *mut c_void = std::ptr::null_mut();
        // SAFETY: NUL-terminated SDDL; writes one pointer freed in Drop.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 || descriptor.is_null() {
            return Err(os_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
                last_error(),
            ));
        }
        Ok(Self(descriptor))
    }
    /// Non-inheritable attributes that point at this descriptor.
    pub(crate) fn attributes(&self) -> SecurityAttributes {
        SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: self.0,
            inherit_handle: 0,
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe { LocalFree(self.0) };
    }
}
