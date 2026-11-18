//! Fallible allocation for buffers whose size comes from session data.
//!
//! Rust's infallible allocations abort the whole process when the system
//! refuses one (`handle_alloc_error`), and `catch_unwind` cannot see an
//! abort: under commit pressure, one pane's modest copy would end every
//! session in the daemon (#3440). Every buffer sized by a session's data is
//! reserved through these helpers instead, and a refusal becomes an error for
//! that one call or session (`AllocFailed`).
//!
//! The seam to JS: a refusal reaches JS as a thrown error whose message is
//! `ALLOC_FAILED: could not allocate <N> bytes for <what>` (`message`).

use std::collections::VecDeque;
use std::fmt;

/// The prefix JS matches a refused allocation by.
pub(crate) const ALLOC_FAILED: &str = "ALLOC_FAILED: ";

/// A refused allocation: what it was for and how many bytes it asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AllocFailed {
    pub what: &'static str,
    pub bytes: usize,
}

impl AllocFailed {
    /// The seam message, shared by the thrown error and the transport's
    /// recorded read error.
    pub(crate) fn message(&self) -> String {
        self.to_string()
    }
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

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
impl From<AllocFailed> for napi::Error {
    fn from(failed: AllocFailed) -> Self {
        napi::Error::new(napi::Status::GenericFailure, failed.message())
    }
}

#[cfg(test)]
thread_local! {
    /// Test injection: every allocation of at least this many bytes on this
    /// thread is refused.
    static FAIL_FROM: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
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

fn injected(_bytes: usize) -> bool {
    #[cfg(test)]
    {
        FAIL_FROM.with(|f| f.get().is_some_and(|from| _bytes >= from))
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
    if injected(failed.bytes) {
        return Err(failed);
    }
    v.try_reserve(additional).map_err(|_| failed)
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
    if injected(failed.bytes) {
        return Err(failed);
    }
    v.try_reserve_exact(additional).map_err(|_| failed)
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
    if injected(failed.bytes) {
        return Err(failed);
    }
    s.try_reserve(additional).map_err(|_| failed)
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
    if injected(failed.bytes) {
        return Err(failed);
    }
    d.try_reserve(additional).map_err(|_| failed)
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
    fn a_size_past_the_address_space_is_refused_not_aborted() {
        let mut v: Vec<u64> = Vec::new();
        let failed = try_reserve(&mut v, usize::MAX / 2, "huge").unwrap_err();
        assert_eq!(failed.bytes, usize::MAX);
        assert!(try_concat(&[], &[], "empty").unwrap().is_empty());
    }
}
