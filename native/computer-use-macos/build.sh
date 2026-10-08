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

APP="$HERE/dist/$APP_NAME"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/wmux-computer-use"
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
# The bundle has no nested code: signing it signs the executable and seals
# Info.plist and the icon with it.
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" \
  --identifier "$IDENTIFIER" "$APP"
codesign --verify --strict --verbose=1 "$APP"

ENTITLEMENTS="$(codesign -d --entitlements - "$APP" 2>/dev/null || true)"
if [ -n "$ENTITLEMENTS" ]; then
  echo "[computer-use-macos] the helper must carry no entitlements, found:" >&2
  echo "$ENTITLEMENTS" >&2
  exit 1
fi

STAGE="$ROOT/dist/computer-use-macos"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# ditto keeps the bundle byte-for-byte, so the signature survives the copy.
ditto "$APP" "$STAGE/$APP_NAME"
echo "[computer-use-macos] built $APP (staged at dist/computer-use-macos)"
