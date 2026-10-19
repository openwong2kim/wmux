#!/usr/bin/env bash
# Build the wmux-server artifact for one arch inside a glibc 2.28 image, so it
# runs on Ubuntu 20.04, Debian 11 and RHEL 8 as well as newer hosts.
#
#   bash scripts/build-server-artifact-container.sh <x64|arm64> [out-dir]
#
# Run from the repo root on a host of the same arch with docker and Node
# (node-pty is native and never cross-built; docker --platform emulation works
# but is slow). The whole build happens in the container: `npm ci` (which
# compiles node-pty against the image's glibc), the CLI and daemon bundles, and
# scripts/build-server-artifact.mjs. It runs on the same pinned Node it ships,
# fetched and sha256-checked on the host first. The build fails if anything in
# the artifact needs a glibc newer than 2.28.
#
# The images are pinned by digest; bump both together (docker pull, then
# `docker inspect --format '{{index .RepoDigests 0}}'`).
set -euo pipefail

ARCH="${1:?usage: build-server-artifact-container.sh <x64|arm64> [out-dir]}"
OUT="${2:-out/server}"
MAX_GLIBC=2.28
case "$ARCH" in
  x64)
    PLATFORM=linux/amd64
    IMAGE=quay.io/pypa/manylinux_2_28_x86_64@sha256:4131ddd7acb9c6c966af02fe7e71edc51e078c2d41f475966697676430bfa2ae
    ;;
  arm64)
    PLATFORM=linux/arm64
    IMAGE=quay.io/pypa/manylinux_2_28_aarch64@sha256:abd1230aa9e4058a74b89d27cd14ba18c0db036d7bfe6e6f219a29ea63c24eb6
    ;;
  *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
esac

# Inside the repo, so the container sees it through the same mount.
CACHE=out/server-node
NODE_TARBALL="$(node scripts/build-server-artifact.mjs fetch-node --arch "$ARCH" --cache "$CACHE" | tail -n 1)"
NODE_TARBALL="${NODE_TARBALL#"$PWD"/}"

# The host's uid, so nothing in the checkout ends up owned by root.
docker run --rm --platform "$PLATFORM" \
  --user "$(id -u):$(id -g)" \
  -v "$PWD":/src -w /src \
  -e HOME=/tmp/home \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  -e ARCH="$ARCH" -e OUT="$OUT" -e CACHE="$CACHE" -e NODE_TARBALL="$NODE_TARBALL" -e MAX_GLIBC="$MAX_GLIBC" \
  "$IMAGE" bash -euo pipefail -c '
    mkdir -p /tmp/node "$HOME"
    tar -xzf "$NODE_TARBALL" -C /tmp/node --strip-components=1
    export PATH="/tmp/node/bin:$PATH"
    echo "building with node $(node --version), npm $(npm --version), $(ldd --version | head -n 1)"
    npm ci --no-audit --no-fund
    # node-pty ships Linux prebuilds since 1.2 (#2398), so npm ci no longer
    # compiles it; rebuild it here against this image glibc. The artifact
    # stages build/Release/pty.node, and its glibc scan and PTY smoke check it.
    npm_config_build_from_source=true npm rebuild node-pty
    npm run build:cli
    npm run build:daemon
    node scripts/build-server-artifact.mjs build --arch "$ARCH" --out "$OUT" --cache "$CACHE" --max-glibc "$MAX_GLIBC"
  '
