#!/usr/bin/env bash
# S-A1 spike build — napi .node (darwin-arm64) + wasm (web/nodejs) + native bench binary.
# Local only (CI integration is S-A2). Requires cargo on PATH.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
NAPI="$REPO_ROOT/node_modules/.bin/napi"
WASM_PACK="$REPO_ROOT/node_modules/.bin/wasm-pack"
# wasm-bindgen CLI is downloaded, cached, and run by wasm-pack to match the wasm-bindgen
# version in Cargo.lock — do not inject home-cache PATH (avoids global-state dependency; review feedback).

cd "$CRATE_DIR"

echo "==> [1/4] napi .node (aarch64-apple-darwin)"
"$NAPI" build --manifest-path ./Cargo.toml --output-dir ./dist/napi \
  --platform --release --js index.cjs --dts index.d.ts

echo "==> [2/4] wasm web target (renderer)"
"$WASM_PACK" build --target web --release --out-dir ./dist/wasm-web --out-name wmux_term

echo "==> [3/4] wasm nodejs target (V4b bench + V5 memory — same .wasm as web)"
"$WASM_PACK" build --target nodejs --release --out-dir ./dist/wasm-node --out-name wmux_term

echo "==> [4/4] native bench binary (bench feature, bindings excluded)"
cargo build --release --no-default-features --features bench --bin bench_native

echo "==> Done. Artifacts:"
ls -la dist/napi/*.node dist/wasm-web/*.wasm dist/wasm-node/*.wasm target/release/bench_native 2>/dev/null || true
