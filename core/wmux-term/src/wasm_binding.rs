//! wasm-bindgen binding layer — wasm32 target only (renderer worker).
//!
//! Compiled only under cfg(target_arch = "wasm32"). Thin adapter wrapping core logic (`Grid`)
//! as a JS class. Same surface as the napi layer (§6 contract minimal subset).

use crate::grid::Grid;
use wasm_bindgen::prelude::*;

/// feed() return — dirty aggregate exposed to JS.
#[wasm_bindgen]
pub struct FeedResult {
    dirty_rows: u32,
    writeback_len: u32,
}

#[wasm_bindgen]
impl FeedResult {
    #[wasm_bindgen(getter)]
    pub fn dirty_rows(&self) -> u32 {
        self.dirty_rows
    }

    #[wasm_bindgen(getter)]
    pub fn writeback_len(&self) -> u32 {
        self.writeback_len
    }
}

/// Terminal grid — JS `new WmuxTerm(cols, rows)`.
#[wasm_bindgen]
pub struct WmuxTerm {
    inner: Grid,
}

#[wasm_bindgen]
impl WmuxTerm {
    #[wasm_bindgen(constructor)]
    pub fn new(cols: u32, rows: u32) -> WmuxTerm {
        WmuxTerm {
            inner: Grid::new(cols, rows),
        }
    }

    /// Feed a byte slice (JS `Uint8Array` → `&[u8]`).
    pub fn feed(&mut self, bytes: &[u8]) -> FeedResult {
        let r = self.inner.feed(bytes);
        FeedResult {
            dirty_rows: r.dirty_rows,
            writeback_len: r.writeback_len,
        }
    }

    pub fn snapshot_row(&self, y: u32) -> String {
        self.inner.snapshot_row(y)
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[wasm_bindgen(getter)]
    pub fn cols(&self) -> u32 {
        self.inner.cols()
    }

    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> u32 {
        self.inner.rows()
    }
}
