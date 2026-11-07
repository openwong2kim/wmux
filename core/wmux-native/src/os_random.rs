//! 16 bytes from the OS generator, for crypto.randomUUID()-shaped request ids.

#[cfg(unix)]
pub fn bytes16() -> [u8; 16] {
    use std::io::Read;
    let mut b = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .is_err()
    {
        b = fallback();
    }
    b
}

#[cfg(windows)]
pub fn bytes16() -> [u8; 16] {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(alg: *mut core::ffi::c_void, buf: *mut u8, len: u32, flags: u32) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 2;
    let mut b = [0u8; 16];
    // SAFETY: b is a valid 16-byte buffer; a null algorithm handle is allowed
    // with BCRYPT_USE_SYSTEM_PREFERRED_RNG.
    let status = unsafe {
        BCryptGenRandom(
            core::ptr::null_mut(),
            b.as_mut_ptr(),
            16,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        b = fallback();
    }
    b
}

/// std's per-process random hash keys. The id only pairs a reply with its
/// request, so uniqueness is what matters here, not secrecy.
fn fallback() -> [u8; 16] {
    use std::hash::{BuildHasher, Hasher};
    let mut out = [0u8; 16];
    for (i, half) in out.chunks_mut(8).enumerate() {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_usize(i);
        half.copy_from_slice(&h.finish().to_le_bytes());
    }
    out
}
