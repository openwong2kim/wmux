#!/usr/bin/env bash
# Asserts the computer-use helper's signature is the one TCC grants and
# src/main/computer/verifyHelper.ts expect:
#   - identifier com.electron.wmux.computer-use, hardened runtime;
#   - NO entitlements (never wmux's Electron ones);
#   - with --release: signed by the wmux team (the requirement main checks)
#     and not a --dev-any-parent build.
#
#   check-signature.sh "<path>/wmux Computer Use.app" [--release]
set -euo pipefail

APP="${1:?usage: check-signature.sh <app> [--release]}"
RELEASE="${2:-}"
IDENTIFIER="com.electron.wmux.computer-use"
REQUIREMENT='anchor apple generic and certificate leaf[subject.OU] = "8RGHH2F237" and identifier "com.electron.wmux.computer-use"'

fail() { echo "::error::computer-use helper signature: $*" >&2; exit 1; }

[ -x "$APP/Contents/MacOS/wmux-computer-use" ] || fail "no executable in $APP"
codesign --verify --strict "$APP" || fail "codesign --verify --strict failed"

INFO="$(codesign -dv "$APP" 2>&1)"
grep -qx "Identifier=$IDENTIFIER" <<<"$INFO" || fail "identifier is not $IDENTIFIER"
grep -q 'flags=.*runtime' <<<"$INFO" || fail "hardened runtime is off"

ENTITLEMENTS="$(codesign -d --entitlements - "$APP" 2>/dev/null || true)"
[ -z "$ENTITLEMENTS" ] || fail "carries entitlements: $ENTITLEMENTS"

if [ "$RELEASE" = "--release" ]; then
  codesign --verify --strict "-R=$REQUIREMENT" "$APP" || fail "does not satisfy: $REQUIREMENT"
  # A dev build (--dev-any-parent) lets any process drive the helper.
  if grep -q WMUX_COMPUTER_USE_DEV_ANY_PARENT "$APP/Contents/MacOS/wmux-computer-use"; then
    fail "is a dev build (--dev-any-parent)"
  fi
fi
echo "computer-use helper signature ok: $APP"
