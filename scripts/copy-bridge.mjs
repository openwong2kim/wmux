#!/usr/bin/env node
// Copy the Claude Code hook bridge into the CLI bundle so it ships as an
// extraResource. `forge.config.ts` packages the whole `dist/cli-bundle/`
// directory, so placing the bridge there gets it into the packaged app for
// free, next to the bundled CLI (`index.js`). `wmux setup-hooks` then finds it
// via an upward-walk and copies it to the stable `~/.wmux/hooks/` location.
//
// Cross-platform: pure Node built-ins, no shell `cp`. Creates the destination
// directory (mkdir -p equivalent) before copying.

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(repoRoot, 'dist', 'cli-bundle');

// Self-contained agent bridges shipped in the CLI bundle (extraResource):
//   - Claude Code hook bridge (installed to ~/.wmux/hooks by `wmux setup-hooks`)
//   - Codex resume-capture notify bridge (installed + registered by McpRegistrar)
const bridges = [
  join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
  join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-statusline.mjs'),
  join(repoRoot, 'integrations', 'codex', 'bin', 'wmux-codex-notify.mjs'),
];

mkdirSync(destDir, { recursive: true });
for (const src of bridges) {
  if (!existsSync(src)) {
    console.error(`copy-bridge: source not found: ${src}`);
    process.exit(1);
  }
  const dest = join(destDir, src.split(/[\\/]/).pop());
  copyFileSync(src, dest);
  console.log(`copy-bridge: ${src} -> ${dest}`);
}
