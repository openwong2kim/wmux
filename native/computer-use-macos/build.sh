#!/usr/bin/env bash
# Builds and signs native/computer-use-macos/dist/wmux Computer Use.app (the
# path a dev build of wmux spawns) and stages a copy at
# dist/computer-use-macos/ in the repo root, which forge ships as the
# Resources/computer-use-macos extraResource.
#
#   npm run build:computer-use-macos                     # ad-hoc signature
#   npm run build:computer-use-macos -- --identity <id>  # Apple Development / Developer ID
#   npm run build:computer-use-macos -- --dev-any-parent # let an unsigned (dev) wmux drive it
#
# The helper is signed here, inside-out, on its own: hardened runtime, a
# secure timestamp (real identities), the permanent identifier and NO
# entitlements. forge's osxSign must skip it (forge.config.ts), because it
# would hand the helper wmux's Electron entitlements.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IDENTIFIER="com.electron.wmux.computer-use"
AGENT_DESKTOP_IDENTIFIER="com.electron.wmux.agent-desktop"
APP_NAME="wmux Computer Use.app"
IDENTITY="${WMUX_COMPUTER_USE_IDENTITY:--}"
# A release helper runs only under signed wmux (Sources/wmux-computer-use/Parent.swift).
# Dev wmux is unsigned, so dev builds of the helper opt out explicitly.
SWIFT_FLAGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --identity=*) IDENTITY="${1#--identity=}"; shift ;;
    --dev-any-parent) SWIFT_FLAGS=(-Xswiftc -DWMUX_ALLOW_ANY_PARENT); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[computer-use-macos] not macOS; nothing to build" >&2
  exit 0
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"

echo "[computer-use-macos] swift build (release, arm64)"
swift build --package-path "$HERE" -c release --arch arm64 --product wmux-computer-use ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"}
BIN="$(swift build --package-path "$HERE" -c release --arch arm64 --show-bin-path ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"})/wmux-computer-use"

# agent-desktop (native/agent-desktop, vendored; see its VENDOR.md), which the
# helper's runner mode starts. Built inside its own tree so its
# rust-toolchain.toml picks the compiler; rustup installs that toolchain and
# the arm64 target when they are missing.
AGENT_DESKTOP_SRC="$ROOT/native/agent-desktop"
echo "[computer-use-macos] cargo build agent-desktop (release, arm64)"
(
  cd "$AGENT_DESKTOP_SRC"
  rustup toolchain install --no-self-update
  rustup target add aarch64-apple-darwin
  cargo build --locked --release -p agent-desktop --target aarch64-apple-darwin
)
AGENT_DESKTOP_BIN="$AGENT_DESKTOP_SRC/target/aarch64-apple-darwin/release/agent-desktop"

APP="$HERE/dist/$APP_NAME"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/wmux-computer-use"
cp "$AGENT_DESKTOP_BIN" "$APP/Contents/MacOS/agent-desktop"
sed "s/__VERSION__/$VERSION/g" "$HERE/Support/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# The icon System Settings shows next to the helper in the Privacy lists,
# made from the app icon with the stock tools (sips, iconutil).
ICONSET="$HERE/.build/AppIcon.iconset"
mkdir -p "$ICONSET" "$APP/Contents/Resources"
for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$ROOT/assets/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -s format png -z "$double" "$double" "$ROOT/assets/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

if [ "$IDENTITY" = "-" ]; then
  echo "[computer-use-macos] signing ad-hoc"
  TIMESTAMP="--timestamp=none"
else
  echo "[computer-use-macos] signing with $IDENTITY"
  TIMESTAMP="--timestamp"
fi
# Inside-out: the nested agent-desktop binary first, with the same identity,
# hardened runtime, no entitlements and the identifier the runner requires of
# it (Runner.swift, ChildGate). Signing the bundle then signs the executable
# and seals Info.plist, the icon and the nested binary with it.
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" \
  --identifier "$AGENT_DESKTOP_IDENTIFIER" "$APP/Contents/MacOS/agent-desktop"
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" \
  --identifier "$IDENTIFIER" "$APP"
codesign --verify --strict --verbose=1 "$APP"

for CODE in "$APP" "$APP/Contents/MacOS/agent-desktop"; do
  ENTITLEMENTS="$(codesign -d --entitlements - "$CODE" 2>/dev/null || true)"
  if [ -n "$ENTITLEMENTS" ]; then
    echo "[computer-use-macos] $CODE must carry no entitlements, found:" >&2
    echo "$ENTITLEMENTS" >&2
    exit 1
  fi
done

STAGE="$ROOT/dist/computer-use-macos"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# ditto keeps the bundle byte-for-byte, so the signature survives the copy.
ditto "$APP" "$STAGE/$APP_NAME"
echo "[computer-use-macos] built $APP (staged at dist/computer-use-macos)"
