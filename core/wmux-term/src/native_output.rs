//! A short-lived, normalized PTY chunk. JS chooses when to retain it; bytes
//! cross into JS only when a consumer needs them for delivery.
use crate::fallible::{self, AllocFailed};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// The decoder's output buffer: the read plus at most 3 held bytes, up to
/// three times that when invalid bytes become U+FFFD.
const DECODED: &str = "decoded PTY output";
/// The longest input `NativeOutputDecoder::feed` takes in one call: the
/// ring's 256 MiB cap. The transport feeds it at most 16 reads (256 KiB).
const MAX_FEED_BYTES: usize = 256 * 1024 * 1024;

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
    pub fn read_bytes(&self) -> Result<Buffer> {
        // Bounded by the chunk: one decoded read batch (DECODED).
        Ok(fallible::try_copy(&self.bytes, "a copy of a PTY output chunk")?.into())
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
    /// The incomplete character the last chunk ended in: at most 3 bytes
    /// (incomplete_suffix), so holding it never allocates.
    pending: [u8; 3],
    pending_len: usize,
}
#[napi]
impl NativeOutputDecoder {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self::default()
    }
    #[napi(catch_unwind)]
    pub fn feed(&mut self, bytes: Uint8Array, finish: bool) -> Result<NativeOutputChunk> {
        if bytes.len() > MAX_FEED_BYTES {
            return Err(Error::from_reason(
                "Output decoder input exceeds the 256 MiB per-call limit",
            ));
        }
        // Bounded by MAX_FEED_BYTES.
        let bytes = fallible::try_copy(&bytes, "PTY output to decode")?;
        self.try_decode(bytes, finish)
            .map_err(|(failed, _)| failed.into())
    }
}
impl NativeOutputDecoder {
    /// Decode `bytes` after the held prefix. All or nothing: on a refusal the
    /// decoder is unchanged and `bytes` comes back as it was passed in.
    pub(crate) fn try_decode(
        &mut self,
        mut bytes: Vec<u8>,
        finish: bool,
    ) -> std::result::Result<NativeOutputChunk, (AllocFailed, Vec<u8>)> {
        let prefix = self.pending_len;
        if prefix > 0 {
            // The read plus the held (at most 3) bytes.
            if let Err(failed) = fallible::try_reserve(&mut bytes, prefix, DECODED) {
                return Err((failed, bytes));
            }
            bytes.extend_from_slice(&self.pending[..prefix]);
            bytes.rotate_right(prefix);
        }
        // StringDecoder delays structurally incomplete suffixes, including an
        // invalid codepoint prefix (e.g. E0 80), until its nominal final byte.
        // Preserve that timing as well as the eventual replacement characters.
        let suffix = if finish { 0 } else { incomplete_suffix(&bytes) };
        let body = bytes.len() - suffix;
        let replaced = match std::str::from_utf8(&bytes[..body]) {
            Ok(_) => None,
            Err(_) => match lossy(&bytes[..body]) {
                Ok(text) => Some(text),
                Err(failed) => {
                    bytes.drain(..prefix);
                    return Err((failed, bytes));
                }
            },
        };
        // Nothing below allocates: the decoder changes only from here.
        self.pending[..suffix].copy_from_slice(&bytes[body..]);
        self.pending_len = suffix;
        let bytes = match replaced {
            Some(text) => text,
            None => {
                bytes.truncate(body);
                bytes
            }
        };
        Ok(NativeOutputChunk { bytes })
    }
}

/// `String::from_utf8_lossy(bytes).into_owned()`, byte for byte, in one
/// fallible allocation of its exact size (at most three times the input).
fn lossy(bytes: &[u8]) -> std::result::Result<Vec<u8>, AllocFailed> {
    let replacement = char::REPLACEMENT_CHARACTER.len_utf8();
    let too_large = AllocFailed {
        what: DECODED,
        bytes: usize::MAX,
    };
    let mut len = 0usize;
    for chunk in bytes.utf8_chunks() {
        len = len.checked_add(chunk.valid().len()).ok_or(too_large)?;
        if !chunk.invalid().is_empty() {
            len = len.checked_add(replacement).ok_or(too_large)?;
        }
    }
    let mut out = fallible::try_with_capacity(len, DECODED)?;
    let mut units = [0; 4];
    let replacement = char::REPLACEMENT_CHARACTER
        .encode_utf8(&mut units)
        .as_bytes();
    for chunk in bytes.utf8_chunks() {
        out.extend_from_slice(chunk.valid().as_bytes());
        if !chunk.invalid().is_empty() {
            out.extend_from_slice(replacement);
        }
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::{lossy, NativeOutputChunk, NativeOutputDecoder};
    use crate::fallible::{fail_from, fail_what, ALLOC_FAILED};
    use napi::bindgen_prelude::Uint8Array;

    fn decode(decoder: &mut NativeOutputDecoder, bytes: &[u8], finish: bool) -> Vec<u8> {
        decoder
            .try_decode(bytes.to_vec(), finish)
            .unwrap_or_else(|(failed, _)| panic!("{failed}"))
            .bytes
    }

    #[test]
    fn lossy_matches_the_standard_library_byte_for_byte() {
        let cases: &[&[u8]] = &[
            b"plain",
            b"",
            b"\xff",
            b"a\xe0\x80b",
            b"\xf0\x9f\x98",
            b"\xed\xa0\x80x",
            "한글😀".as_bytes(),
            b"\xc3\x28\xa0\xa1\xe2\x28\xa1\xf0\x28\x8c\xbc",
        ];
        for case in cases {
            assert_eq!(
                lossy(case).unwrap(),
                String::from_utf8_lossy(case).into_owned().into_bytes()
            );
        }
    }

    #[test]
    fn a_character_split_across_reads_is_held_then_joined() {
        let mut decoder = NativeOutputDecoder::default();
        let smile = "😀".as_bytes();
        assert_eq!(decode(&mut decoder, &smile[..2], false), b"");
        assert_eq!(decode(&mut decoder, &smile[2..], false), smile);
        assert_eq!(
            decode(&mut decoder, b"\xe2\x82", true),
            "\u{fffd}".as_bytes()
        );
    }

    #[test]
    fn a_refused_join_leaves_the_decoder_and_returns_the_input() {
        let mut decoder = NativeOutputDecoder::default();
        let smile = "😀".as_bytes();
        assert_eq!(decode(&mut decoder, &smile[..3], false), b"");
        let input = [&smile[3..], b"tail".as_slice()].concat();
        {
            let _fail = fail_from(1);
            let Err((failed, back)) = decoder.try_decode(input.clone(), false) else {
                panic!("the decode is refused");
            };
            assert!(failed.message().starts_with(ALLOC_FAILED));
            assert_eq!(back, input, "the input comes back untouched");
        }
        // The held prefix survived: the retry decodes the whole character.
        assert_eq!(decode(&mut decoder, &input, false), "😀tail".as_bytes());
    }

    #[test]
    fn a_refused_replacement_leaves_the_decoder_and_returns_the_input() {
        let mut decoder = NativeOutputDecoder::default();
        assert_eq!(decode(&mut decoder, b"ok\xe2", false), b"ok");
        // The held E2 plus an invalid continuation needs the lossy copy.
        // Spare capacity: the join itself fits in place, the copy does not.
        let mut input = Vec::with_capacity(8);
        input.push(0x28);
        {
            let _fail = fail_from(1);
            let Err((failed, back)) = decoder.try_decode(input, false) else {
                panic!("the decode is refused");
            };
            assert_eq!(failed.what, "decoded PTY output");
            assert_eq!(failed.bytes, 4, "the exact size of U+FFFD and '('");
            assert_eq!(back, b"\x28");
        }
        assert_eq!(decode(&mut decoder, b"\x28", false), "\u{fffd}(".as_bytes());
    }

    #[test]
    fn a_refused_chunk_copy_is_an_error_and_the_chunk_reads_after() {
        let chunk = NativeOutputChunk {
            bytes: b"abc".to_vec(),
        };
        {
            let _fail = fail_from(1);
            let error = chunk.read_bytes().err().expect("the copy is refused");
            assert!(error.reason.starts_with(ALLOC_FAILED), "{}", error.reason);
            assert_eq!(error.status, napi::Status::GenericFailure);
        }
        assert_eq!(&chunk.read_bytes().unwrap()[..], b"abc");
        assert_eq!(chunk.byte_length(), 3);
    }

    #[test]
    fn a_refused_input_copy_leaves_the_decoder() {
        let mut decoder = NativeOutputDecoder::default();
        let smile = "😀".as_bytes();
        assert_eq!(decode(&mut decoder, &smile[..2], false), b"");
        {
            let _fail = fail_what("PTY output to decode");
            let error = decoder
                .feed(Uint8Array::new(smile[2..].to_vec()), false)
                .err()
                .expect("the copy is refused");
            assert!(error.reason.starts_with(ALLOC_FAILED), "{}", error.reason);
        }
        let chunk = decoder
            .feed(Uint8Array::new(smile[2..].to_vec()), false)
            .unwrap();
        assert_eq!(chunk.text(), "😀");
    }
}
