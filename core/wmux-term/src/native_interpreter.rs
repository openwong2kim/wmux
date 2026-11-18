//! Additive ABI-1 output-interpreter binding. The pure implementation is also
//! compiled without N-API so its tests run without a Node process.
use crate::fallible;
use crate::native_output::NativeOutputChunk;
use crate::output_interpreter::OutputInterpreter;
use napi::bindgen_prelude::*;
use napi::{sys, JsString, JsValue};
use napi_derive::napi;

/// The batch's codes and texts: one each per event, at most the chunk's OSC
/// count.
const BATCH: &str = "an OSC event batch";
/// The copy of the text `feed` takes: its UTF-8 and a NUL, at most
/// MAX_FEED_BYTES + 1.
const FEED_TEXT: &str = "output text to interpret";
/// The longest text (in UTF-8 bytes) `feed` takes in one call: the ring's
/// 256 MiB cap.
const MAX_FEED_BYTES: usize = 256 * 1024 * 1024;

// Batch codes as one typed array: a native object conversion for every OSC
// dominates event-heavy streams. The adapter constructs ordinary event objects.
#[napi(object)]
pub struct NativeOscBatch {
    pub codes: Float64Array,
    pub data: Vec<String>,
}
#[napi]
pub struct NativeOutputInterpreter {
    inner: Option<OutputInterpreter>,
}
#[napi]
impl NativeOutputInterpreter {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self {
            inner: Some(OutputInterpreter::default()),
        }
    }
    /// `text` is a whole PTY chunk: napi-rs's own `String` conversion
    /// would copy it with an infallible allocation (#3440), so it arrives as
    /// the JS string and is copied here (`string_from_js`).
    #[napi(catch_unwind)]
    pub fn feed(
        &mut self,
        text: JsString,
        end: f64,
        include_osc: bool,
    ) -> Result<Option<NativeOscBatch>> {
        let text = string_from_js(&text)?;
        self.apply(&text, end, include_osc)
    }
    #[napi(catch_unwind)]
    pub fn feed_chunk(
        &mut self,
        chunk: &NativeOutputChunk,
        end: f64,
    ) -> Result<Option<NativeOscBatch>> {
        self.apply(
            std::str::from_utf8(&chunk.bytes)
                .map_err(|_| Error::from_reason("Invalid normalized output"))?,
            end,
            true,
        )
    }
    #[napi(catch_unwind)]
    pub fn is_set(&self, mode: u32) -> Result<bool> {
        Ok(self.get()?.is_set(mode))
    }
    #[napi(getter, catch_unwind)]
    pub fn alt_screen(&self) -> Result<bool> {
        Ok(self.get()?.alt_screen())
    }
    #[napi(catch_unwind)]
    pub fn preamble(&self, start: f64) -> Result<String> {
        Ok(self.get()?.preamble(start))
    }
    #[napi(catch_unwind)]
    pub fn reset(&mut self) -> Result<()> {
        self.get_mut()?.reset_modes();
        Ok(())
    }
    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.inner = None;
    }
}
impl NativeOutputInterpreter {
    fn get(&self) -> Result<&OutputInterpreter> {
        self.inner
            .as_ref()
            .ok_or_else(|| Error::from_reason("Output interpreter disposed"))
    }
    fn get_mut(&mut self) -> Result<&mut OutputInterpreter> {
        self.inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("Output interpreter disposed"))
    }
    fn apply(&mut self, text: &str, end: f64, osc: bool) -> Result<Option<NativeOscBatch>> {
        if !end.is_finite() || end < 0.0 || end.fract() != 0.0 || end > 9_007_199_254_740_991.0 {
            return Err(Error::from_reason("Invalid ring stream offset"));
        }
        let events = self.get_mut()?.feed(text, end, osc)?;
        if events.is_empty() {
            return Ok(None);
        }
        // One code per event: at most the chunk's OSC count.
        let mut codes: Vec<f64> = fallible::try_with_capacity(events.len(), BATCH)?;
        let mut data: Vec<String> = fallible::try_with_capacity(events.len(), BATCH)?;
        for event in events {
            codes.push(event.code);
            data.push(event.data);
        }
        Ok(Some(NativeOscBatch {
            codes: codes.into(),
            data,
        }))
    }
}

/// The UTF-8 of a JS string, as napi-rs's `String` conversion reads it
/// (napi_get_value_string_utf8: a lone surrogate becomes U+FFFD), into a
/// buffer reserved fallibly.
fn string_from_js(text: &JsString) -> Result<String> {
    let value = text.value();
    let len = text
        .utf8_len()
        .map_err(|error| Error::new(error.status, "The output text is not a string"))?;
    copy_utf8(len, |buffer, size| {
        let mut written = 0;
        // SAFETY: `buffer` has room for `size` bytes; napi writes at most
        // `size - 1` of the string and a NUL.
        let status = unsafe {
            sys::napi_get_value_string_utf8(
                value.env,
                value.value,
                buffer.cast(),
                size,
                &mut written,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(Error::new(
                Status::from(status),
                "Failed to read the output text",
            ));
        }
        Ok(written)
    })
}

/// A string of `len` UTF-8 bytes, read by `fill` into a buffer of `len + 1`
/// bytes (room for its NUL) reserved fallibly. `fill` returns how many
/// bytes it wrote, the NUL not counted.
fn copy_utf8(len: usize, fill: impl FnOnce(*mut u8, usize) -> Result<usize>) -> Result<String> {
    if len > MAX_FEED_BYTES {
        return Err(Error::from_reason(
            "Output interpreter input exceeds the 256 MiB per-call limit",
        ));
    }
    // At most MAX_FEED_BYTES + 1: no overflow.
    let size = len + 1;
    let mut buffer: Vec<u8> = fallible::try_with_capacity(size, FEED_TEXT)?;
    let written = fill(buffer.as_mut_ptr(), size)?;
    if written > len {
        return Err(Error::from_reason("The output text changed length"));
    }
    // SAFETY: `fill` initialized the first `written` bytes, within capacity.
    unsafe { buffer.set_len(written) };
    String::from_utf8(buffer).map_err(|_| Error::from_reason("The output text is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::{copy_utf8, NativeOutputInterpreter, BATCH, FEED_TEXT, MAX_FEED_BYTES};
    use crate::fallible::{fail_what, ALLOC_FAILED};
    use napi::Result;

    /// `fill` as napi_get_value_string_utf8 behaves: the bytes, then a NUL.
    fn read(text: &str) -> Result<String> {
        copy_utf8(text.len(), |buffer, size| {
            assert_eq!(size, text.len() + 1, "room for the NUL");
            // SAFETY: the buffer has room for `size` bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(text.as_ptr(), buffer, text.len());
                *buffer.add(text.len()) = 0;
            }
            Ok(text.len())
        })
    }

    #[test]
    fn a_fed_string_is_copied_unchanged() {
        for text in ["", "plain ascii", "한글 漢字", "emoji 😀👍🏽", "a\u{fffd}b"] {
            assert_eq!(read(text).unwrap(), text);
        }
    }

    #[test]
    fn a_refused_copy_of_a_fed_string_is_an_error() {
        let _fail = fail_what(FEED_TEXT);
        let error = copy_utf8(5, |_, _| panic!("nothing is read")).unwrap_err();
        assert_eq!(
            error.reason,
            "ALLOC_FAILED: could not allocate 6 bytes for output text to interpret"
        );
        assert_eq!(error.status, napi::Status::GenericFailure);
    }

    #[test]
    fn a_fed_string_past_the_cap_is_refused_before_any_allocation() {
        let error = copy_utf8(MAX_FEED_BYTES + 1, |_, _| panic!("nothing is read")).unwrap_err();
        assert!(!error.reason.starts_with(ALLOC_FAILED), "{}", error.reason);
        assert!(copy_utf8(4, |_, _| Ok(5)).is_err(), "more than measured");
        assert!(copy_utf8(1, |buffer, _| {
            // SAFETY: room for 2 bytes.
            unsafe { *buffer = 0xff };
            Ok(1)
        })
        .is_err());
    }

    #[test]
    fn a_refused_event_batch_is_an_error_and_the_next_feed_reads() {
        let mut interpreter = NativeOutputInterpreter::new();
        {
            let _fail = fail_what(BATCH);
            let error = interpreter
                .apply("\x1b]2;a\x07", 0.0, true)
                .err()
                .expect("the batch is refused");
            assert!(error.reason.starts_with(ALLOC_FAILED), "{}", error.reason);
        }
        let batch = interpreter
            .apply("\x1b]2;b\x07", 6.0, true)
            .unwrap()
            .expect("one event");
        assert_eq!(batch.data, ["b"]);
    }
}
