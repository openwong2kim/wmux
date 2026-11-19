//! Fallible allocation for buffers whose size comes from session data.
//!
//! Rust's infallible allocations abort the whole process when the system
//! refuses one (`handle_alloc_error`), and `catch_unwind` cannot see an
//! abort: under commit pressure, one pane's modest copy would end every
//! session in the daemon (#3440). Every buffer sized by a session's data is
//! reserved through these helpers instead, and a refusal becomes an error for
//! that one call or session (`AllocFailed`).
//!
//! The seam to JS: a refusal reaches JS as a thrown error (or a rejected
//! promise) whose `code` is `ALLOC_FAILED` (ALLOC_FAILED_CODE, a napi custom
//! status, `ErrorCode`). Its message, `ALLOC_FAILED: could not allocate <N>
//! bytes for <what>` (`message`), is for diagnostics only: once nothing at
//! all can be allocated it is shorter, or empty, and the code still holds.

use std::cell::Cell;
use std::collections::VecDeque;
use std::fmt::{self, Write as _};

/// The prefix of a refusal's diagnostic message (`message`).
pub(crate) const ALLOC_FAILED: &str = "ALLOC_FAILED: ";

/// The `code` JS classifies a refused allocation by. A `&'static str`, set
/// without allocating, so it survives when the message cannot be built.
pub(crate) const ALLOC_FAILED_CODE: &str = "ALLOC_FAILED";

/// A refused allocation: what it was for and how many bytes it asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AllocFailed {
    pub what: &'static str,
    pub bytes: usize,
}

/// The capacity of a thread's spare message buffer (`message`): the prefix,
/// `could not allocate `, 20 digits, ` bytes for ` and a purpose of up to 96
/// bytes (the longest is about 50).
const SPARE_MESSAGE: usize = 160;

thread_local! {
    /// The buffer this thread's next seam message is written into, taken
    /// right after a refusal without asking the allocator for anything. It
    /// is refilled after a fallible allocation succeeds (`keep_spare`).
    static SPARE: Cell<Option<String>> = const { Cell::new(None) };
}

/// Gives this thread a spare message buffer if it has none; a refused one
/// is left for the next success.
fn keep_spare() {
    let _ = SPARE.try_with(|spare| {
        let kept = spare.take().or_else(|| {
            let mut buffer = String::new();
            buffer.try_reserve_exact(SPARE_MESSAGE).ok()?;
            Some(buffer)
        });
        spare.set(kept);
    });
}

/// Fills this thread's spare message buffer now (tests).
#[cfg(test)]
pub(crate) fn refill_spare() {
    keep_spare();
}

/// Decimal digits in `n`.
fn digits(mut n: usize) -> usize {
    let mut count = 1;
    while n >= 10 {
        n /= 10;
        count += 1;
    }
    count
}

impl AllocFailed {
    /// The diagnostic message, shared by the thrown error and the
    /// transport's recorded read error. Built right after a refusal, so it
    /// is written into this thread's spare buffer, moved out without an
    /// allocation. With no spare (a second refusal before any success on
    /// this thread), it asks for exactly its own length; refused, for the
    /// prefix alone; refused again, it is empty. JS classifies the refusal
    /// by its `code` (ALLOC_FAILED_CODE), never by this text, so an empty
    /// message loses only the diagnostic, rather than aborting.
    pub(crate) fn message(&self) -> String {
        let len = ALLOC_FAILED.len()
            + "could not allocate ".len()
            + digits(self.bytes)
            + " bytes for ".len()
            + self.what.len();
        refusal_message(len, self)
    }
}

/// An OS call that failed because the system is out of memory (it reported
/// a commit-limit or out-of-memory code): the same refusal as a refused
/// allocation, code ALLOC_FAILED, not an error of the call itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OsRefused {
    /// The OS call, for the diagnostic message.
    pub call: &'static str,
    pub code: OsCode,
}

/// The code an OS call failed with.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OsCode {
    /// A Win32 error (GetLastError), shown in decimal.
    Win32(u32),
    /// An NTSTATUS, shown in hex.
    Nt(u32),
}

impl OsRefused {
    /// The diagnostic message, `ALLOC_FAILED: <call> failed (<code>)`, built
    /// as AllocFailed's (`AllocFailed::message`): JS reads the code only.
    pub(crate) fn message(&self) -> String {
        let code = match self.code {
            OsCode::Win32(code) => digits(code as usize),
            OsCode::Nt(_) => "0x".len() + 8,
        };
        let len = ALLOC_FAILED.len() + self.call.len() + " failed ()".len() + code;
        refusal_message(len, self)
    }
}

impl fmt::Display for OsRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            OsCode::Win32(code) => write!(f, "{ALLOC_FAILED}{} failed ({code})", self.call),
            OsCode::Nt(code) => write!(f, "{ALLOC_FAILED}{} failed (0x{code:08X})", self.call),
        }
    }
}

/// A refusal's message of `len` bytes (`AllocFailed::message`).
fn refusal_message(len: usize, refusal: &dyn fmt::Display) -> String {
    let spare = SPARE.try_with(Cell::take).ok().flatten();
    let mut text = match spare {
        Some(buffer) if buffer.capacity() >= len => buffer,
        spare => {
            if let Some(buffer) = spare {
                let _ = SPARE.try_with(|cell| cell.set(Some(buffer)));
            }
            let mut buffer = String::new();
            if buffer.try_reserve_exact(len).is_err() {
                let mut prefix = String::new();
                if prefix.try_reserve_exact(ALLOC_FAILED.len()).is_ok() {
                    prefix.push_str(ALLOC_FAILED);
                }
                return prefix;
            }
            buffer
        }
    };
    text.clear();
    // Within the capacity checked above: no allocation.
    let _ = write!(text, "{refusal}");
    text
}

impl fmt::Display for AllocFailed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{ALLOC_FAILED}could not allocate {} bytes for {}",
            self.bytes, self.what
        )
    }
}

/// A native call's error before it crosses to JS, where it becomes a
/// `napi::Error<ErrorCode>`: code ALLOC_FAILED for a refusal (a refused
/// allocation or an OS call refused for want of memory), GenericFailure
/// otherwise, with the same message. The call bodies return this rather than
/// `napi::Error`: dropping a `napi::Error` links napi's C symbols, which only
/// Node provides, so the unit tests that drive the bodies could not link on
/// Linux or macOS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallError {
    Alloc(AllocFailed),
    /// Made by the Windows process table only.
    #[cfg_attr(not(windows), allow(dead_code))]
    OsRefused(OsRefused),
    Reason(std::borrow::Cow<'static, str>),
}

pub(crate) type CallResult<T> = Result<T, CallError>;

impl CallError {
    pub(crate) fn reason(reason: impl Into<std::borrow::Cow<'static, str>>) -> Self {
        Self::Reason(reason.into())
    }

    /// The message JS sees.
    #[cfg(test)]
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Alloc(failed) => failed.message(),
            Self::OsRefused(refused) => refused.message(),
            Self::Reason(reason) => reason.to_string(),
        }
    }
}

impl From<AllocFailed> for CallError {
    fn from(failed: AllocFailed) -> Self {
        Self::Alloc(failed)
    }
}

/// The `code` of an error a native call throws or rejects with: a napi
/// custom status. ALLOC_FAILED for a refused allocation; napi's own status
/// (GenericFailure, InvalidArg, ...) for anything else, so those codes are
/// unchanged. Both are `&'static str`s: a code is never built.
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    AllocFailed,
    Status(napi::Status),
}

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
impl AsRef<str> for ErrorCode {
    fn as_ref(&self) -> &str {
        match self {
            Self::AllocFailed => ALLOC_FAILED_CODE,
            Self::Status(status) => status.as_ref(),
        }
    }
}

/// `code` with `reason` moved in: `napi::Error::new` would copy it. The
/// error still takes a small fixed allocation on its way to JS: napi-derive's
/// `throw_into` copies the code (`status.as_ref().to_string()`), and a
/// `CallError::Reason` borrowed from a `&'static str` is copied into the
/// error's `String` (`into_js`). Neither is sized by the session.
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
fn coded_error(code: ErrorCode, reason: String) -> napi::Error<ErrorCode> {
    let mut error = napi::Error::from_status(code);
    error.reason = reason;
    error
}

impl CallError {
    /// The `code` and the message JS sees. The code of a refusal is
    /// ALLOC_FAILED whatever became of its message (`AllocFailed::message`).
    #[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
    pub(crate) fn into_js(self) -> (ErrorCode, String) {
        match self {
            Self::Alloc(failed) => (ErrorCode::AllocFailed, failed.message()),
            Self::OsRefused(refused) => (ErrorCode::AllocFailed, refused.message()),
            Self::Reason(reason) => (
                ErrorCode::Status(napi::Status::GenericFailure),
                reason.into_owned(),
            ),
        }
    }
}

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
impl From<AllocFailed> for napi::Error<ErrorCode> {
    fn from(failed: AllocFailed) -> Self {
        CallError::Alloc(failed).into()
    }
}

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
impl From<CallError> for napi::Error<ErrorCode> {
    fn from(error: CallError) -> Self {
        let (code, message) = error.into_js();
        coded_error(code, message)
    }
}

/// A napi error (a JS value conversion, a threadsafe function) in a call
/// whose errors carry an `ErrorCode`: its status and message are kept.
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
pub(crate) fn napi_error(error: napi::Error) -> napi::Error<ErrorCode> {
    let mut error = error;
    coded_error(
        ErrorCode::Status(error.status),
        std::mem::take(&mut error.reason),
    )
}

/// One value kept on this thread for its next refusal, made while memory
/// was available. Taking it and keeping it allocate nothing. It is never
/// dropped at thread exit (`ManuallyDrop`): a kept rejection refers to a JS
/// object whose environment is gone by then.
pub(crate) struct ReadySlot<T>(Cell<Option<std::mem::ManuallyDrop<T>>>);

impl<T> ReadySlot<T> {
    pub(crate) const fn new() -> Self {
        Self(Cell::new(None))
    }

    pub(crate) fn take(&self) -> Option<T> {
        self.0.take().map(std::mem::ManuallyDrop::into_inner)
    }

    /// Keeps `value` for the next `take`; if one is kept already, that one
    /// stays and `value` is dropped.
    pub(crate) fn keep(&self, value: T) {
        match self.0.take() {
            Some(kept) => self.0.set(Some(kept)),
            None => self.0.set(Some(std::mem::ManuallyDrop::new(value))),
        }
    }
}

/// The rejection made ready, or `make` when there is none.
pub(crate) fn ready_or<T>(ready: Option<T>, make: impl FnOnce() -> T) -> T {
    ready.unwrap_or_else(make)
}

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
thread_local! {
    /// The rejection a finished AsyncTask did not use, for the next one.
    static READY_REJECTION: ReadySlot<napi::Error> = const { ReadySlot::new() };
}

/// What a rejection made ready says. Its `code` is ALLOC_FAILED; the size and
/// purpose of the refused allocation are not in it, since nothing may be
/// allocated to write them once the refusal happened.
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
const READY_MESSAGE: &str = "ALLOC_FAILED: a native read was refused for want of memory";

/// A rejection for an AsyncTask that `compute` may refuse, made on the JS
/// thread when the task is created, while memory is available: this
/// thread's kept one, or a new one. A Task's `reject` returns
/// `napi::Error<Status>`, which cannot carry ALLOC_FAILED, so it is a JS
/// error object with that code which the rejection reuses (napi rejects with
/// the object an error refers to). Turning a JS object into a `napi::Error`
/// copies its text and allocates the reference, so it is done here and not
/// after the refusal.
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn ready_rejection(env: napi::Env) -> Option<napi::Error> {
    if let Some(kept) = READY_REJECTION.try_with(ReadySlot::take).ok().flatten() {
        return Some(kept);
    }
    let error = coded_error(ErrorCode::AllocFailed, READY_MESSAGE.to_owned());
    let mut ready = napi::Error::from(napi::JsError::from(error).into_unknown(env));
    // The JS object holds the message.
    ready.reason = String::new();
    ready.cause = None;
    Some(ready)
}

/// Keeps a finished task's unused rejection for the next task on this
/// thread (`Task::finally`).
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn keep_rejection(ready: Option<napi::Error>) {
    if let Some(ready) = ready {
        let _ = READY_REJECTION.try_with(|slot| slot.keep(ready));
    }
}

/// A refusal as an AsyncTask's rejection: the one made ready when the task
/// was created (`ready_rejection`), which allocates nothing now. Only
/// without one is a JS error made here, with the refusal's message.
#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn task_refusal(
    env: napi::Env,
    refused: CallError,
    ready: Option<napi::Error>,
) -> napi::Error {
    ready_or(ready, || {
        let error: napi::Error<ErrorCode> = refused.into();
        napi::Error::from(napi::JsError::from(error).into_unknown(env))
    })
}

#[cfg(test)]
thread_local! {
    /// Test injection: every allocation of at least this many bytes on this
    /// thread is refused.
    static FAIL_FROM: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    /// Test injection: every allocation for this purpose on this thread is
    /// refused, whatever its size.
    static FAIL_WHAT: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    /// Test injection: this many more allocations for this purpose on this
    /// thread are refused.
    static FAIL_NEXT: std::cell::Cell<(&'static str, usize)> = const { std::cell::Cell::new(("", 0)) };
}

/// Refuses every allocation of at least `bytes` bytes on this thread until
/// the guard drops (tests only).
#[cfg(test)]
pub(crate) fn fail_from(bytes: usize) -> FailGuard {
    FailGuard(FAIL_FROM.with(|f| f.replace(Some(bytes))))
}

#[cfg(test)]
pub(crate) struct FailGuard(Option<usize>);

#[cfg(test)]
impl Drop for FailGuard {
    fn drop(&mut self) {
        FAIL_FROM.with(|f| f.set(self.0));
    }
}

/// Refuses every allocation for `what` on this thread until the guard
/// drops (tests only), so a test can reach one site past smaller and
/// larger allocations before it.
#[cfg(test)]
pub(crate) fn fail_what(what: &'static str) -> WhatGuard {
    WhatGuard(FAIL_WHAT.with(|f| f.replace(Some(what))))
}

#[cfg(test)]
pub(crate) struct WhatGuard(Option<&'static str>);

#[cfg(test)]
impl Drop for WhatGuard {
    fn drop(&mut self) {
        FAIL_WHAT.with(|f| f.set(self.0));
    }
}

/// Refuses the next `count` allocations for `what` on this thread (tests
/// only), so a test can see a site try again.
#[cfg(test)]
pub(crate) fn fail_next(what: &'static str, count: usize) {
    FAIL_NEXT.with(|f| f.set((what, count)));
}

fn injected(_failed: &AllocFailed) -> bool {
    #[cfg(test)]
    {
        let next = FAIL_NEXT.with(|f| {
            let (what, count) = f.get();
            let refused = count > 0 && what == _failed.what;
            if refused {
                f.set((what, count - 1));
            }
            refused
        });
        next || FAIL_FROM.with(|f| f.get().is_some_and(|from| _failed.bytes >= from))
            || FAIL_WHAT.with(|f| f.get() == Some(_failed.what))
    }
    #[cfg(not(test))]
    {
        false
    }
}

/// `count` elements of `T`, in bytes (saturated: a size past the address
/// space is refused like any other).
fn bytes_of<T>(count: usize) -> usize {
    count.saturating_mul(std::mem::size_of::<T>().max(1))
}

/// The capacity amortized growth asks for: at least double the current one.
fn amortized(len: usize, capacity: usize, additional: usize) -> usize {
    len.saturating_add(additional)
        .max(capacity.saturating_mul(2))
}

/// `Vec::try_reserve` (amortized growth). Spare capacity allocates nothing,
/// so it never fails, injected or not. A refusal reports the size of the
/// buffer asked for (here and below), not just the growth.
pub(crate) fn try_reserve<T>(
    v: &mut Vec<T>,
    additional: usize,
    what: &'static str,
) -> Result<(), AllocFailed> {
    if v.capacity() - v.len() >= additional {
        return Ok(());
    }
    let failed = AllocFailed {
        what,
        bytes: bytes_of::<T>(amortized(v.len(), v.capacity(), additional)),
    };
    if injected(&failed) {
        return Err(failed);
    }
    v.try_reserve(additional).map_err(|_| failed)?;
    keep_spare();
    Ok(())
}

/// `Vec::try_reserve_exact`.
pub(crate) fn try_reserve_exact<T>(
    v: &mut Vec<T>,
    additional: usize,
    what: &'static str,
) -> Result<(), AllocFailed> {
    if v.capacity() - v.len() >= additional {
        return Ok(());
    }
    let failed = AllocFailed {
        what,
        bytes: bytes_of::<T>(v.len().saturating_add(additional)),
    };
    if injected(&failed) {
        return Err(failed);
    }
    v.try_reserve_exact(additional).map_err(|_| failed)?;
    keep_spare();
    Ok(())
}

/// `String::try_reserve` (amortized growth).
pub(crate) fn try_reserve_str(
    s: &mut String,
    additional: usize,
    what: &'static str,
) -> Result<(), AllocFailed> {
    if s.capacity() - s.len() >= additional {
        return Ok(());
    }
    let failed = AllocFailed {
        what,
        bytes: amortized(s.len(), s.capacity(), additional),
    };
    if injected(&failed) {
        return Err(failed);
    }
    s.try_reserve(additional).map_err(|_| failed)?;
    keep_spare();
    Ok(())
}

/// `VecDeque::try_reserve` (amortized growth).
pub(crate) fn try_reserve_deque<T>(
    d: &mut VecDeque<T>,
    additional: usize,
    what: &'static str,
) -> Result<(), AllocFailed> {
    if d.capacity() - d.len() >= additional {
        return Ok(());
    }
    let failed = AllocFailed {
        what,
        bytes: bytes_of::<T>(amortized(d.len(), d.capacity(), additional)),
    };
    if injected(&failed) {
        return Err(failed);
    }
    d.try_reserve(additional).map_err(|_| failed)?;
    keep_spare();
    Ok(())
}

/// An empty vector with room for exactly `capacity` elements.
pub(crate) fn try_with_capacity<T>(
    capacity: usize,
    what: &'static str,
) -> Result<Vec<T>, AllocFailed> {
    let mut v = Vec::new();
    try_reserve_exact(&mut v, capacity, what)?;
    Ok(v)
}

/// `len` zeroed elements (a buffer the system fills), in one allocation.
#[cfg_attr(not(feature = "native-core"), allow(dead_code))]
pub(crate) fn try_zeroed<T: Copy + Default>(
    len: usize,
    what: &'static str,
) -> Result<Vec<T>, AllocFailed> {
    let mut v = try_with_capacity(len, what)?;
    // Within the capacity just reserved: no allocation.
    v.resize(len, T::default());
    Ok(v)
}

/// `HashMap::try_reserve`. A refusal reports the size of the entries asked
/// for, not the table's own overhead.
#[cfg_attr(not(feature = "native-core"), allow(dead_code))]
pub(crate) fn try_reserve_map<K: Eq + std::hash::Hash, V>(
    map: &mut std::collections::HashMap<K, V>,
    additional: usize,
    what: &'static str,
) -> Result<(), AllocFailed> {
    if map.capacity() - map.len() >= additional {
        return Ok(());
    }
    let failed = AllocFailed {
        what,
        bytes: bytes_of::<(K, V)>(map.len().saturating_add(additional)),
    };
    if injected(&failed) {
        return Err(failed);
    }
    map.try_reserve(additional).map_err(|_| failed)?;
    keep_spare();
    Ok(())
}

/// `String::from_utf16_lossy` into one allocation of exactly its length.
#[cfg_attr(not(feature = "native-core"), allow(dead_code))]
pub(crate) fn try_utf16_lossy(units: &[u16], what: &'static str) -> Result<String, AllocFailed> {
    let chars = || {
        char::decode_utf16(units.iter().copied()).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
    };
    let len = chars().map(char::len_utf8).sum();
    let mut text = String::new();
    try_reserve_str(&mut text, len, what)?;
    text.extend(chars());
    Ok(text)
}

/// A copy of `src`.
pub(crate) fn try_copy(src: &[u8], what: &'static str) -> Result<Vec<u8>, AllocFailed> {
    let mut v = try_with_capacity(src.len(), what)?;
    v.extend_from_slice(src);
    Ok(v)
}

/// Appends `src` to `dst`; on a refusal `dst` is unchanged.
pub(crate) fn try_extend(
    dst: &mut Vec<u8>,
    src: &[u8],
    what: &'static str,
) -> Result<(), AllocFailed> {
    try_reserve(dst, src.len(), what)?;
    dst.extend_from_slice(src);
    Ok(())
}

/// `a` followed by `b`, in one allocation of exactly their length.
pub(crate) fn try_concat(a: &[u8], b: &[u8], what: &'static str) -> Result<Vec<u8>, AllocFailed> {
    let len = a.len().checked_add(b.len()).ok_or(AllocFailed {
        what,
        bytes: usize::MAX,
    })?;
    let mut v = try_with_capacity(len, what)?;
    v.extend_from_slice(a);
    v.extend_from_slice(b);
    Ok(v)
}

/// Appends `c` to `s`; on a refusal `s` is unchanged.
pub(crate) fn try_push(s: &mut String, c: char, what: &'static str) -> Result<(), AllocFailed> {
    try_reserve_str(s, c.len_utf8(), what)?;
    s.push(c);
    Ok(())
}

/// Appends `add` to `s`; on a refusal `s` is unchanged.
pub(crate) fn try_push_str(
    s: &mut String,
    add: &str,
    what: &'static str,
) -> Result<(), AllocFailed> {
    try_reserve_str(s, add.len(), what)?;
    s.push_str(add);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An AsyncTask's refusal is rejected with the error made ready when the
    /// task was created: once memory is refused, taking it, rejecting with
    /// it and dropping the refusal allocate nothing, and the conversion that
    /// copies text and allocates (`make`, standing in for the napi one) is
    /// not run. A finished task's unused one is kept for the next.
    #[test]
    fn a_refusal_rejects_with_the_error_made_ready_without_allocating() {
        let slot = ReadySlot::new();
        slot.keep(String::from("made ready"));
        let refused = CallError::Alloc(AllocFailed {
            what: "the process rows for JS",
            bytes: 4096,
        });
        let mut made = false;
        let rejected = crate::test_allocator::refusing(1, || {
            ready_or(slot.take(), || {
                made = true;
                refused.message()
            })
        });
        assert_eq!(crate::test_allocator::refused(), 0);
        assert!(!made);
        assert_eq!(rejected, "made ready");
        // Nothing kept: the conversion runs.
        assert_eq!(
            ready_or(slot.take(), || String::from("made now")),
            "made now"
        );
        // A finished task keeps its unused one; a second one is dropped.
        slot.keep(String::from("first"));
        slot.keep(String::from("second"));
        assert_eq!(slot.take().as_deref(), Some("first"));
        assert_eq!(slot.take(), None);
    }

    #[test]
    fn the_seam_message_names_the_bytes_and_the_purpose() {
        let failed = AllocFailed {
            what: "a PTY read",
            bytes: 288216,
        };
        assert_eq!(
            failed.message(),
            "ALLOC_FAILED: could not allocate 288216 bytes for a PTY read"
        );
        assert!(failed.message().starts_with(ALLOC_FAILED));
    }

    #[test]
    fn injection_refuses_only_requests_at_or_past_its_size() {
        let _fail = fail_from(16);
        assert_eq!(try_copy(&[1; 15], "small").unwrap(), vec![1; 15]);
        assert_eq!(
            try_copy(&[1; 16], "large"),
            Err(AllocFailed {
                what: "large",
                bytes: 16
            })
        );
        let mut v = vec![1u8];
        assert!(try_extend(&mut v, &[2; 40], "grow").is_err());
        assert_eq!(v, vec![1], "a refused append leaves the vector as it was");
        let mut s = String::from("a");
        assert!(try_push_str(&mut s, &"b".repeat(40), "grow").is_err());
        assert_eq!(s, "a");
    }

    #[test]
    fn spare_capacity_never_fails() {
        let mut v: Vec<u8> = Vec::with_capacity(64);
        let _fail = fail_from(1);
        try_extend(&mut v, &[7; 64], "within capacity").unwrap();
        assert_eq!(v.len(), 64);
        assert!(try_extend(&mut v, &[7], "past capacity").is_err());
    }

    #[test]
    fn the_guard_restores_the_previous_injection() {
        {
            let _outer = fail_from(8);
            {
                let _inner = fail_from(1);
                assert!(try_copy(&[0; 2], "inner").is_err());
            }
            assert!(try_copy(&[0; 2], "outer").is_ok());
            assert!(try_copy(&[0; 8], "outer").is_err());
        }
        assert!(try_copy(&[0; 8], "none").is_ok());
    }

    #[test]
    fn injection_by_purpose_refuses_only_that_purpose() {
        {
            let _fail = fail_what("target");
            assert!(try_copy(&[0; 1], "other").is_ok());
            assert_eq!(
                try_copy(&[0; 1], "target"),
                Err(AllocFailed {
                    what: "target",
                    bytes: 1
                })
            );
        }
        assert!(try_copy(&[0; 1], "target").is_ok());
    }

    #[test]
    fn a_size_past_the_address_space_is_refused_not_aborted() {
        let mut v: Vec<u64> = Vec::new();
        let failed = try_reserve(&mut v, usize::MAX / 2, "huge").unwrap_err();
        assert_eq!(failed.bytes, usize::MAX);
        assert!(try_concat(&[], &[], "empty").unwrap().is_empty());
    }
}
