#!/usr/bin/env bash
# S-A1 spike verification: run V1 through V5 sequentially and exit nonzero on any failure.
# Review follow-up: force a build before verification to prevent stale artifacts from passing.
# Only artifacts rebuilt from the current source are verified; incremental cargo/wasm-pack builds
# keep repeated runs inexpensive.
set -uo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
ELECTRON="$REPO_ROOT/node_modules/.bin/electron"

cd "$CRATE_DIR"

echo "==> Forcing build before verification (prevent stale artifacts)"
bash "$CRATE_DIR/build.sh" || { echo ">>> build failed — aborting verification"; exit 1; }
FAIL=0
run() { echo ""; echo "======== $1 ========"; shift; "$@"; local rc=$?; if [ $rc -ne 0 ]; then echo ">>> failed (exit $rc)"; FAIL=1; fi; }

echo "==> cargo test (shared grid logic)"
cargo test --release 2>&1 | tail -8 || FAIL=1

run "V1 pure Node napi" node "$CRATE_DIR/spike/v1-node-napi.mjs"
run "V2 Electron main napi" "$ELECTRON" "$CRATE_DIR/spike/v2-electron-main.cjs"
run "V3 Electron renderer wasm" "$ELECTRON" "$CRATE_DIR/spike/v3-renderer/main.cjs"
run "V4a native vte throughput" "$CRATE_DIR/target/release/bench_native"
run "V4b wasm throughput" node "$CRATE_DIR/spike/v4b-wasm-bench.cjs"
run "V5 wasm memory order" node "$CRATE_DIR/spike/v5-wasm-memory.cjs"

echo ""
if [ $FAIL -eq 0 ]; then echo "==> all 5 verifications passed"; exit 0; else echo "==> some verifications failed"; exit 1; fi
