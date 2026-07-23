//! napi-build setup — runs only for native (.node) targets.
//!
//! Note (review feedback): `#[cfg(target_arch)]` inside build.rs is evaluated for the **build host**,
//! so it cannot be used to detect cross targets (wasm32) — use the target env vars cargo provides instead.

fn main() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_arch != "wasm32" {
        napi_build::setup();
    }
}
