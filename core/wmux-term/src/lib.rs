//! wmux-term — E0 spike S-A1 crate skeleton.
//!
//! **Single crate cfg split** (decision doc D5): core logic lives in one shared `grid` module;
//! only binding layers branch by target.
//!   - `#[cfg(target_arch = "wasm32")]` → wasm-bindgen binding (`wasm_binding`)
//!   - `#[cfg(not(target_arch = "wasm32"))]` → napi-rs binding (`napi_binding`)
//!
//! Spike goal: prove dual-target plumbing (napi .node + wasm). VT accuracy is E1's job.

mod grid;

// Pure library surface (expose grid without bindings — for cargo test · microbench).
pub use grid::{FeedResult, Grid};

// Binding layers compile only with the `bindings` feature (microbench links pure Grid only).
#[cfg(all(feature = "bindings", target_arch = "wasm32"))]
mod wasm_binding;

#[cfg(all(feature = "bindings", not(target_arch = "wasm32")))]
mod napi_binding;
