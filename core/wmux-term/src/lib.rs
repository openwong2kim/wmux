//! wmux-term — E0 스파이크 S-A1 크레이트 스켈레톤.
//!
//! **단일 크레이트 cfg 분기**(결정 문서 D5): 코어 로직은 `grid` 공용 모듈 1개,
//! 바인딩 레이어만 타깃별로 분기한다.
//!   - `#[cfg(target_arch = "wasm32")]` → wasm-bindgen 바인딩(`wasm_binding`)
//!   - `#[cfg(not(target_arch = "wasm32"))]` → napi-rs 바인딩(`napi_binding`)
//!
//! 스파이크 목적: 이중 타깃 배관(napi .node + wasm) 실증. VT 정확도는 E1 몫.

mod grid;

// 순수 라이브러리 표면(바인딩 없이도 grid를 노출 — cargo test·마이크로벤치용).
pub use grid::{FeedResult, Grid};

// 바인딩 레이어는 `bindings` 피처에서만 컴파일(마이크로벤치는 순수 Grid만 링크).
#[cfg(all(feature = "bindings", target_arch = "wasm32"))]
mod wasm_binding;

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
mod napi_binding;

#[cfg(all(
    feature = "native-core",
    feature = "bindings",
    not(target_arch = "wasm32")
))]
mod native_core;

#[cfg(all(
    feature = "native-core",
    feature = "bindings",
    not(target_arch = "wasm32")
))]
mod native_serialize;

#[cfg(all(
    feature = "native-core",
    feature = "bindings",
    not(target_arch = "wasm32")
))]
mod native_transport;

#[cfg(all(
    feature = "native-core",
    feature = "bindings",
    not(target_arch = "wasm32")
))]
mod native_output;

#[cfg(any(test, feature = "native-core"))]
mod output_interpreter;

#[cfg(any(
    test,
    all(
        feature = "native-core",
        feature = "bindings",
        not(target_arch = "wasm32")
    )
))]
mod wake_gate;

#[cfg(all(
    feature = "native-core",
    feature = "bindings",
    not(target_arch = "wasm32")
))]
mod native_interpreter;

#[cfg(all(
    windows,
    any(
        test,
        all(
            feature = "native-core",
            feature = "bindings",
            not(target_arch = "wasm32")
        )
    )
))]
mod process_table;
