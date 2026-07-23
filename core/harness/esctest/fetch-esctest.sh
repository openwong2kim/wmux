#!/usr/bin/env bash
# E0 harness M3 — esctest2 vendor fetch (GPL isolation policy: engine-core-decision-2026-07-09.md §5-3)
#
# esctest2 (ThomasDickey/esctest2) is GPL-2.0. Source is **not committed** to the repo —
# this script clones into vendor/ at a pinned commit and verifies the pin hash at runtime.
# vendor/ is .gitignore'd (no GPL files in repo · CI cache · artifacts · releases).
#
# Clean-room rule: this script and the adapter use only esctest "usage" (run args · I/O channels).
# DECRQCRA checksum logic is NOT ported from vendor/ source — derived only from DEC STD 070 / xterm
# ctlseqs spec (sources cited in adapter.ts comments).
set -euo pipefail

# ── commit pin ─────────────────────────────────────────────────────────────────
# 2025-08-24 Thomas E. Dickey. On upgrade, replace this hash only (reproducibility fixed).
ESCTEST_REPO="https://github.com/ThomasDickey/esctest2.git"
ESCTEST_PIN="664be3cf2c1e3f06bc93a8bafb48a0db83c607db"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor"

# Reuse if already at the correct pin (avoid repeat network contact).
# Review feedback: HEAD match alone is insufficient — dirty worktree (local tamper) or wrong origin
# breaks "unmodified pin execution" guarantee. Re-clone if any check fails.
if [ -d "$VENDOR_DIR/.git" ]; then
  current="$(git -C "$VENDOR_DIR" rev-parse HEAD 2>/dev/null || echo none)"
  origin="$(git -C "$VENDOR_DIR" remote get-url origin 2>/dev/null || echo none)"
  dirty="$(git -C "$VENDOR_DIR" status --porcelain 2>/dev/null | head -1)"
  if [ "$current" = "$ESCTEST_PIN" ] && [ "$origin" = "$ESCTEST_REPO" ] && [ -z "$dirty" ]; then
    echo "[fetch-esctest] vendor already at pin $ESCTEST_PIN (clean, origin ok) — reuse"
    exit 0
  fi
  echo "[fetch-esctest] vendor invalid (head=$current origin=$origin dirty=${dirty:+yes}) — re-fetching"
  rm -rf "$VENDOR_DIR"
fi

echo "[fetch-esctest] cloning $ESCTEST_REPO @ $ESCTEST_PIN"
# Shallow history — fetch pin only. Requires network.
git clone --no-checkout --filter=blob:none "$ESCTEST_REPO" "$VENDOR_DIR"
git -C "$VENDOR_DIR" checkout --quiet "$ESCTEST_PIN"

# Pin verification (MITM · tag drift defense).
got="$(git -C "$VENDOR_DIR" rev-parse HEAD)"
if [ "$got" != "$ESCTEST_PIN" ]; then
  echo "[fetch-esctest] PIN MISMATCH: got $got expected $ESCTEST_PIN" >&2
  exit 1
fi

# Confirm GPL license exists (factual basis for isolation policy).
if ! grep -qi "GNU GENERAL PUBLIC LICENSE" "$VENDOR_DIR/LICENSE" 2>/dev/null; then
  echo "[fetch-esctest] WARNING: expected GPL LICENSE not found in vendor" >&2
fi

echo "[fetch-esctest] OK — vendored at $VENDOR_DIR (pin $ESCTEST_PIN, GPL-2.0, gitignored)"
