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
const src = join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');
const destDir = join(repoRoot, 'dist', 'cli-bundle');
const dest = join(destDir, 'wmux-bridge.mjs');

if (!existsSync(src)) {
  console.error(`copy-bridge: source not found: ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copy-bridge: ${src} -> ${dest}`);
