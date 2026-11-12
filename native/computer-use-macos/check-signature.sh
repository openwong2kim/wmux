#!/usr/bin/env bash
# Asserts the computer-use helper's signature is the one TCC grants and
# src/main/computer/verifyHelper.ts expect:
#   - identifier com.electron.wmux.computer-use, hardened runtime;
#   - NO entitlements (never wmux's Electron ones);
#   - the nested agent-desktop binary: identifier com.electron.wmux.agent-desktop,
#     hardened runtime, no entitlements, sealed into the bundle, built for a
#     minimum macOS no later than the helper's own (14.0);
#   - nothing else in the bundle: no vendored source (native/agent-desktop)
#     ships, only the binary built from it;
#   - with --release: signed by the wmux team (the requirement main checks)
#     and not a --dev-any-parent build.
#
#   check-signature.sh "<path>/wmux Computer Use.app" [--release]
set -euo pipefail

APP="${1:?usage: check-signature.sh <app> [--release]}"
RELEASE="${2:-}"
IDENTIFIER="com.electron.wmux.computer-use"
REQUIREMENT='anchor apple generic and certificate leaf[subject.OU] = "8RGHH2F237" and identifier "com.electron.wmux.computer-use"'
NESTED="$APP/Contents/MacOS/agent-desktop"
NESTED_IDENTIFIER="com.electron.wmux.agent-desktop"
NESTED_REQUIREMENT='anchor apple generic and certificate leaf[subject.OU] = "8RGHH2F237" and identifier "com.electron.wmux.agent-desktop"'

fail() { echo "::error::computer-use helper signature: $*" >&2; exit 1; }

[ -x "$APP/Contents/MacOS/wmux-computer-use" ] || fail "no executable in $APP"
codesign --verify --strict "$APP" || fail "codesign --verify --strict failed"

INFO="$(codesign -dv "$APP" 2>&1)"
grep -qx "Identifier=$IDENTIFIER" <<<"$INFO" || fail "identifier is not $IDENTIFIER"
grep -q 'flags=.*runtime' <<<"$INFO" || fail "hardened runtime is off"

ENTITLEMENTS="$(codesign -d --entitlements - "$APP" 2>/dev/null || true)"
[ -z "$ENTITLEMENTS" ] || fail "carries entitlements: $ENTITLEMENTS"
[ -x "$NESTED" ] || fail "no agent-desktop in $APP"
codesign --verify --strict "$NESTED" || fail "agent-desktop: codesign --verify --strict failed"
NESTED_INFO="$(codesign -dv "$NESTED" 2>&1)"
grep -qx "Identifier=$NESTED_IDENTIFIER" <<<"$NESTED_INFO" || fail "agent-desktop: identifier is not $NESTED_IDENTIFIER"
grep -q 'flags=.*runtime' <<<"$NESTED_INFO" || fail "agent-desktop: hardened runtime is off"
NESTED_ENTITLEMENTS="$(codesign -d --entitlements - "$NESTED" 2>/dev/null || true)"
[ -z "$NESTED_ENTITLEMENTS" ] || fail "agent-desktop carries entitlements: $NESTED_ENTITLEMENTS"
# The build host's macOS is later than the oldest one the helper supports, so
# a minimum taken from the host would only show on a user's older Mac.
NESTED_MINOS="$(vtool -show-build "$NESTED" 2>/dev/null | awk '$1 == "minos" { print $2; exit }')"
[ -n "$NESTED_MINOS" ] || fail "agent-desktop: no minimum macOS version in its build info"
awk -v v="$NESTED_MINOS" 'BEGIN { split(v, p, "."); exit !((p[1] + 0) < 14 || ((p[1] + 0) == 14 && (p[2] + 0) == 0 && (p[3] + 0) == 0)) }' \
  || fail "agent-desktop requires macOS $NESTED_MINOS; the helper supports 14.0"
# Exactly these files: anything else (vendored source, a stray build file)
# would ship inside wmux.
UNEXPECTED="$(cd "$APP" && find . \( -type f -o -type l \) | LC_ALL=C sort | grep -vxF \
  -e ./Contents/Info.plist \
  -e ./Contents/MacOS/wmux-computer-use \
  -e ./Contents/MacOS/agent-desktop \
  -e ./Contents/Resources/AppIcon.icns \
  -e ./Contents/_CodeSignature/CodeResources || true)"
[ -z "$UNEXPECTED" ] || fail "unexpected files in the bundle: $(echo $UNEXPECTED)"

if [ "$RELEASE" = "--release" ]; then
  codesign --verify --strict "-R=$REQUIREMENT" "$APP" || fail "does not satisfy: $REQUIREMENT"
  codesign --verify --strict "-R=$NESTED_REQUIREMENT" "$NESTED" || fail "agent-desktop does not satisfy: $NESTED_REQUIREMENT"
  # A dev build (--dev-any-parent) lets any process drive the helper.
  if grep -q WMUX_COMPUTER_USE_DEV_ANY_PARENT "$APP/Contents/MacOS/wmux-computer-use"; then
    fail "is a dev build (--dev-any-parent)"
  fi
fi
echo "computer-use helper signature ok: $APP"
