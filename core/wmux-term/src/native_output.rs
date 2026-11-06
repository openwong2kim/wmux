//! A short-lived, normalized PTY chunk. JS chooses when to retain it; bytes
//! cross into JS only when a consumer needs them for delivery.
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub struct NativeOutputChunk {
    pub(crate) bytes: Vec<u8>,
}
#[napi]
impl NativeOutputChunk {
    #[napi(getter, catch_unwind)]
    pub fn text(&self) -> &str {
        // napi copies straight into a JS string; no intermediate Rust String.
        // Only the streaming decoder constructs these normalized bytes.
        std::str::from_utf8(&self.bytes).expect("Output decoder produces valid UTF-8")
    }
    #[napi(getter, catch_unwind)]
    pub fn byte_length(&self) -> u32 {
        self.bytes.len() as u32
    }
    #[napi(catch_unwind)]
    pub fn read_bytes(&self) -> Buffer {
        self.bytes.clone().into()
    }
    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.bytes = Vec::new();
    }
}

/// Like StringDecoder('utf8'): retain incomplete characters across reads and
/// replace invalid sequences. No pending byte outlives the terminal's final EOF.
#[napi]
#[derive(Default)]
pub struct NativeOutputDecoder {
    pending: Vec<u8>,
}
#[napi]
impl NativeOutputDecoder {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self::default()
    }
    #[napi(catch_unwind)]
    pub fn feed(&mut self, bytes: Uint8Array, finish: bool) -> NativeOutputChunk {
        self.decode(bytes.to_vec(), finish)
    }
}
impl NativeOutputDecoder {
    pub(crate) fn decode(&mut self, mut bytes: Vec<u8>, finish: bool) -> NativeOutputChunk {
        if !self.pending.is_empty() {
            let mut joined = std::mem::take(&mut self.pending);
            joined.extend_from_slice(&bytes);
            bytes = joined;
        }
        // StringDecoder delays structurally incomplete suffixes, including an
        // invalid codepoint prefix (e.g. E0 80), until its nominal final byte.
        // Preserve that timing as well as the eventual replacement characters.
        if !finish {
            let pending = incomplete_suffix(&bytes);
            self.pending
                .extend_from_slice(&bytes[bytes.len() - pending..]);
            bytes.truncate(bytes.len() - pending);
        }
        let bytes = match String::from_utf8(bytes) {
            Ok(text) => text.into_bytes(),
            Err(error) => String::from_utf8_lossy(error.as_bytes())
                .into_owned()
                .into_bytes(),
        };
        NativeOutputChunk { bytes }
    }
}

fn incomplete_suffix(bytes: &[u8]) -> usize {
    for back in 1..=3.min(bytes.len()) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let expected = if byte & 0x80 == 0 {
            1
        } else if byte & 0xe0 == 0xc0 {
            2
        } else if byte & 0xf0 == 0xe0 {
            3
        } else if byte & 0xf8 == 0xf0 {
            4
        } else {
            return 0;
        };
        return if expected > back { back } else { 0 };
    }
    0
}
