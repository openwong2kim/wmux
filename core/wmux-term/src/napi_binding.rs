//! napi-rs 바인딩 레이어 — 네이티브(.node) 타깃 전용.
//!
//! cfg(not(wasm32))에서만 컴파일. 코어 로직(`Grid`)을 N-API 클래스로 감싸는
//! 얇은 어댑터 — 로직 중복 없음(배관 실증 원칙).

use crate::grid::Grid;
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// feed() 반환 — §6 계약 최소 부분집합의 JS 노출.
#[napi(object)]
pub struct FeedResult {
    pub dirty_rows: u32,
    pub writeback_len: u32,
}

/// 터미널 그리드 — JS `new WmuxTerm(cols, rows)`.
#[napi(js_name = "WmuxTerm")]
pub struct WmuxTerm {
    inner: Grid,
}

#[napi]
impl WmuxTerm {
    #[napi(constructor, catch_unwind)]
    pub fn new(cols: u32, rows: u32) -> Self {
        WmuxTerm {
            inner: Grid::new(cols, rows),
        }
    }

    /// 바이트를 feed하고 dirty 집계 반환.
    /// JS에서 Uint8Array/Buffer로 전달 → 네이티브 슬라이스 왕복.
    #[napi(catch_unwind)]
    pub fn feed(&mut self, bytes: Uint8Array) -> FeedResult {
        let r = self.inner.feed(&bytes);
        FeedResult {
            dirty_rows: r.dirty_rows,
            writeback_len: r.writeback_len,
        }
    }

    #[napi(catch_unwind)]
    pub fn snapshot_row(&self, y: u32) -> String {
        self.inner.snapshot_row(y)
    }

    #[napi(catch_unwind)]
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    #[napi(getter, catch_unwind)]
    pub fn cols(&self) -> u32 {
        self.inner.cols()
    }

    #[napi(getter, catch_unwind)]
    pub fn rows(&self) -> u32 {
        self.inner.rows()
    }
}
