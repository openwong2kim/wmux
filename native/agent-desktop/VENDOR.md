# Vendored: agent-desktop

This directory is an unmodified copy of a subset of
[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop),
licensed under the Apache License 2.0 (see `LICENSE` here). wmux builds its
`agent-desktop` binary from it and ships that binary inside the macOS
computer-use helper bundle. This file is the only one wmux added.

- Upstream commit: `b43ac4f6e892ef608f8851428613c4009f0e84c7` (version 1.2.0)
- Kept, byte for byte: `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`,
  `clippy.toml`, `deny.toml`, `LICENSE`, `README.md`, `.gitignore`, `crates/`,
  `src/`, `skills/`
- `skills/` is Markdown only. It is kept because
  `crates/core/src/commands/skills.rs` embeds it with `include_str!` (for
  upstream's `skills` command, which wmux never runs), so the source builds
  without being modified.
- Left out (not needed to build the binary): `assets/`, `probes/`,
  `AGENTS.md`, `.agents/`, `.claude`, `.github/`, `.githooks/`,
  `.gitleaks.toml`, `.gitleaksignore`, `.gitattributes`, `apps/`,
  `benchmarks/`, `docs/`, `npm/`, `scripts/`, `tests/`, `CHANGELOG.md`,
  `CONCEPTS.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  `SUPPORT.md`

Build (from this directory; `rust-toolchain.toml` pins the toolchain):

    cargo build --locked --release -p agent-desktop

`native/computer-use-macos/build.sh` runs that build (for arm64) and signs the
result. The binary is built at upstream's default minimum macOS version; the
helper bundle it ships in still requires macOS 14 (its Info.plist).

## Updating

Replace the kept paths with the same paths from a new upstream commit, update
the commit above, rebuild, and regenerate the notices
(`node scripts/generate-notices.mjs`). Do not edit files here; a change wmux
needs belongs in wmux's own code around the binary.
