#!/usr/bin/env bash
# Prove a built wmux-server artifact runs the Rust terminal engine on a clean
# old-glibc host: extract the tarball into a fresh home the way "Add PC over
# SSH" installs it (~/.wmux/runtime/<ver>/), then run
# scripts/prove-server-artifact.mjs on the artifact's own Node.
#
#   bash scripts/prove-server-artifact.sh <x64|arm64> [out-dir]
#
# Run from the repo root after scripts/build-server-artifact-container.sh, on a
# host of the same arch with docker. The image is not the build image: Debian
# 11, with none of the build tools, as a host the artifact is made for. It is
# pinned by its multi-arch index digest; bump it with
# `docker buildx imagetools inspect debian:11-slim`.
set -euo pipefail

ARCH="${1:?usage: prove-server-artifact.sh <x64|arm64> [out-dir]}"
OUT="${2:-out/server}"
IMAGE=debian:11-slim@sha256:e5b6442dd2e9684cf5e87d8338b5968f3b348636fc0be6d7850a381e3731a2bd
case "$ARCH" in
  x64) PLATFORM=linux/amd64 ;;
  arm64) PLATFORM=linux/arm64 ;;
  *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
esac

VERSION="$(node -p 'require("./package.json").version')"
NAME="wmux-server-$VERSION-linux-$ARCH.tar.gz"
[ -f "$OUT/$NAME" ] || { echo "$OUT/$NAME is missing: build it first" >&2; exit 1; }

# Read-only mounts: the artifact and the two proof scripts, nothing else of
# the checkout. The host's uid, as an SSH install runs as a user, not root.
docker run --rm --platform "$PLATFORM" \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/$OUT":/artifact:ro \
  -v "$PWD/scripts/prove-server-artifact.mjs":/proof/prove-server-artifact.mjs:ro \
  -v "$PWD/scripts/verify-native-terminal-package.cjs":/proof/verify-native-terminal-package.cjs:ro \
  -e HOME=/tmp/home -e NAME="$NAME" -e VERSION="$VERSION" \
  "$IMAGE" bash -euo pipefail -c '
    echo "proving on $(ldd --version | head -n 1)"
    mkdir -p "$HOME/.wmux/runtime"
    tar -xzf "/artifact/$NAME" -C "$HOME/.wmux/runtime"
    RUNTIME="$HOME/.wmux/runtime/$VERSION"
    "$RUNTIME/node/bin/node" /proof/prove-server-artifact.mjs "$RUNTIME"
  '
