//! Additive ABI-1 output-interpreter binding. The pure implementation is also
//! compiled without N-API so its tests run without a Node process.
use crate::native_output::NativeOutputChunk;
use crate::output_interpreter::OutputInterpreter;
use napi::bindgen_prelude::*;
use napi_derive::napi;

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
    #[napi(catch_unwind)]
    pub fn feed(
        &mut self,
        text: String,
        end: f64,
        include_osc: bool,
    ) -> Result<Option<NativeOscBatch>> {
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
        let events = self.get_mut()?.feed(text, end, osc);
        if events.is_empty() {
            return Ok(None);
        }
        let (codes, data): (Vec<f64>, Vec<String>) =
            events.into_iter().map(|e| (e.code, e.data)).unzip();
        Ok(Some(NativeOscBatch {
            codes: codes.into(),
            data,
        }))
    }
}
