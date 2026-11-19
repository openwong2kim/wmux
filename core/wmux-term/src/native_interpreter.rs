//! Additive ABI-1 output-interpreter binding. The pure implementation is also
//! compiled without N-API so its tests run without a Node process.
use crate::fallible::{self, napi_error, CallError, CallResult, ErrorCode};
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
/// 256 MiB cap, decoded. The daemon seeds a recovered ring as one string,
/// and each invalid byte there becomes U+FFFD (3 bytes of UTF-8).
const MAX_FEED_BYTES: usize = 3 * 256 * 1024 * 1024;

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
    ) -> Result<Option<NativeOscBatch>, ErrorCode> {
        let text = string_from_js(&text)?;
        Ok(self.apply(&text, end, include_osc)?.map(batch))
    }
    #[napi(catch_unwind)]
    pub fn feed_chunk(
        &mut self,
        chunk: &NativeOutputChunk,
        end: f64,
    ) -> Result<Option<NativeOscBatch>, ErrorCode> {
        let text = std::str::from_utf8(&chunk.bytes)
            .map_err(|_| napi_error(Error::from_reason("Invalid normalized output")))?;
        Ok(self.apply(text, end, true)?.map(batch))
    }
    #[napi(catch_unwind)]
    pub fn is_set(&self, mode: u32) -> Result<bool, ErrorCode> {
        Ok(self.get()?.is_set(mode))
    }
    #[napi(getter, catch_unwind)]
    pub fn alt_screen(&self) -> Result<bool, ErrorCode> {
        Ok(self.get()?.alt_screen())
    }
    #[napi(catch_unwind)]
    pub fn preamble(&self, start: f64) -> Result<String, ErrorCode> {
        Ok(self.get()?.preamble(start))
    }
    #[napi(catch_unwind)]
    pub fn reset(&mut self) -> Result<(), ErrorCode> {
        self.get_mut()?.reset_modes();
        Ok(())
    }
    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.inner = None;
    }
}
impl NativeOutputInterpreter {
    fn get(&self) -> CallResult<&OutputInterpreter> {
        self.inner
            .as_ref()
            .ok_or_else(|| CallError::reason("Output interpreter disposed"))
    }
    fn get_mut(&mut self) -> CallResult<&mut OutputInterpreter> {
        self.inner
            .as_mut()
            .ok_or_else(|| CallError::reason("Output interpreter disposed"))
    }
    /// The batch's codes and texts, before they become a NativeOscBatch.
    fn apply(&mut self, text: &str, end: f64, osc: bool) -> CallResult<Option<Events>> {
        if !end.is_finite() || end < 0.0 || end.fract() != 0.0 || end > 9_007_199_254_740_991.0 {
            return Err(CallError::reason("Invalid ring stream offset"));
        }
        // The batch is built before the interpreter keeps the chunk's
        // modes and OSC state: a refused batch changes nothing either.
        let events = self.get_mut()?.feed_with(text, end, osc, |events| {
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
            Ok(Some(Events { codes, data }))
        })?;
        Ok(events)
    }
}

/// A batch's codes and texts (NativeOscBatch's, without the typed array).
struct Events {
    codes: Vec<f64>,
    data: Vec<String>,
}

fn batch(events: Events) -> NativeOscBatch {
    NativeOscBatch {
        codes: events.codes.into(),
        data: events.data,
    }
}

/// The UTF-8 of a JS string, as napi-rs's `String` conversion reads it
/// (napi_get_value_string_utf8: a lone surrogate becomes U+FFFD), into a
/// buffer reserved fallibly.
fn string_from_js(text: &JsString) -> Result<String, ErrorCode> {
    let value = text.value();
    let len = text
        .utf8_len()
        .map_err(|error| Error::new(ErrorCode::Status(error.status), "The output text is not a string"))?;
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
                ErrorCode::Status(Status::from(status)),
                "Failed to read the output text",
            ));
        }
        Ok(written)
    })
}

/// A string of `len` UTF-8 bytes, read by `fill` into a buffer of `len + 1`
/// bytes (room for its NUL) reserved fallibly. `fill` returns how many
/// bytes it wrote, the NUL not counted.
/// Generic over the error, so the tests run it without napi (CallError).
fn copy_utf8<E: From<CallError>>(
    len: usize,
    fill: impl FnOnce(*mut u8, usize) -> std::result::Result<usize, E>,
) -> std::result::Result<String, E> {
    if len > MAX_FEED_BYTES {
        return Err(CallError::reason(
            "Output interpreter input exceeds the 768 MiB per-call limit",
        )
        .into());
    }
    // At most MAX_FEED_BYTES + 1: no overflow.
    let size = len + 1;
    let mut buffer: Vec<u8> = fallible::try_with_capacity(size, FEED_TEXT)
        .map_err(|failed| CallError::from(failed).into())?;
    let written = fill(buffer.as_mut_ptr(), size)?;
    if written > len {
        return Err(CallError::reason("The output text changed length").into());
    }
    // SAFETY: `fill` initialized the first `written` bytes, within capacity.
    unsafe { buffer.set_len(written) };
    String::from_utf8(buffer).map_err(|_| CallError::reason("The output text is not UTF-8").into())
}

#[cfg(test)]
mod tests {
    use super::{copy_utf8, NativeOutputInterpreter, BATCH, FEED_TEXT, MAX_FEED_BYTES};
    use crate::fallible::{fail_what, CallError, CallResult, ALLOC_FAILED};

    /// `fill` as napi_get_value_string_utf8 behaves: the bytes, then a NUL.
    fn read(text: &str) -> CallResult<String> {
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
        let error: CallError = copy_utf8(5, |_, _| panic!("nothing is read")).unwrap_err();
        assert!(matches!(error, CallError::Alloc(_)), "{error:?}");
        assert_eq!(
            error.message(),
            "ALLOC_FAILED: could not allocate 6 bytes for output text to interpret"
        );
    }

    #[test]
    fn a_fed_string_past_the_cap_is_refused_before_any_allocation() {
        let error: CallError =
            copy_utf8(MAX_FEED_BYTES + 1, |_, _| panic!("nothing is read")).unwrap_err();
        assert!(!error.message().starts_with(ALLOC_FAILED), "{error:?}");
        assert!(
            copy_utf8::<CallError>(4, |_, _| Ok(5)).is_err(),
            "more than measured"
        );
        assert!(copy_utf8::<CallError>(1, |buffer, _| {
            // SAFETY: room for 2 bytes.
            unsafe { *buffer = 0xff };
            Ok(1)
        })
        .is_err());
    }

    #[test]
    fn a_refused_event_batch_changes_nothing_and_the_retry_reads_as_once() {
        let chunk = "le\x07\x1b[?1049h\x1b]0;x\x07";
        let mut once = NativeOutputInterpreter::new();
        once.apply("\x1b]2;tit", 0.0, true).unwrap();
        let expected = once.apply(chunk, 10.0, true).unwrap().expect("two events");
        let mut interpreter = NativeOutputInterpreter::new();
        interpreter.apply("\x1b]2;tit", 0.0, true).unwrap();
        {
            let _fail = fail_what(BATCH);
            let error = interpreter
                .apply(chunk, 10.0, true)
                .err()
                .expect("the batch is refused");
            assert!(matches!(error, CallError::Alloc(_)), "{error:?}");
            assert!(error.message().starts_with(ALLOC_FAILED), "{error:?}");
        }
        let inner = interpreter.get().unwrap();
        assert!(!inner.alt_screen(), "the chunk's mode change is not kept");
        let batch = interpreter
            .apply(chunk, 10.0, true)
            .unwrap()
            .expect("two events");
        assert_eq!(batch.data, ["title", "x"]);
        assert_eq!(batch.data, expected.data);
        assert_eq!(batch.codes, expected.codes);
        assert!(interpreter.get().unwrap().alt_screen());
        assert_eq!(
            interpreter.get().unwrap().preamble(0.0),
            once.get().unwrap().preamble(0.0)
        );
    }
}
