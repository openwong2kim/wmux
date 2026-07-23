//! napi-rs binding layer — native (.node) target only.
//!
//! Compiled only under cfg(not(wasm32)). Thin adapter wrapping core logic (`Grid`) as an
//! N-API class — no duplicated logic (plumbing proof principle).

use crate::grid::Grid;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// feed() return — JS exposure of §6 contract minimal subset.
#[napi(object)]
pub struct FeedResult {
    pub dirty_rows: u32,
    pub writeback_len: u32,
}

/// Terminal grid — JS `new WmuxTerm(cols, rows)`.
#[napi(js_name = "WmuxTerm")]
pub struct WmuxTerm {
    inner: Grid,
}

#[napi]
impl WmuxTerm {
    #[napi(constructor)]
    pub fn new(cols: u32, rows: u32) -> Self {
        WmuxTerm {
            inner: Grid::new(cols, rows),
        }
    }

    /// Feed bytes and return dirty aggregate.
    /// JS passes Uint8Array/Buffer → native slice round-trip.
    #[napi]
    pub fn feed(&mut self, bytes: Uint8Array) -> FeedResult {
        let r = self.inner.feed(&bytes);
        FeedResult {
            dirty_rows: r.dirty_rows,
            writeback_len: r.writeback_len,
        }
    }

    #[napi]
    pub fn snapshot_row(&self, y: u32) -> String {
        self.inner.snapshot_row(y)
    }

    #[napi]
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[napi(getter)]
    pub fn cols(&self) -> u32 {
        self.inner.cols()
    }

    #[napi(getter)]
    pub fn rows(&self) -> u32 {
        self.inner.rows()
    }
}
