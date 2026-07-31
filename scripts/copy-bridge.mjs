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
//   - Claude Code hook/statusline bridges
//   - Codex lifecycle notify bridge
//   - OpenCode lifecycle plugin (renamed in the bundle to avoid generic wmux.js)
const bridges = [
  {
    src: join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
    dest: 'wmux-bridge.mjs',
  },
  {
    src: join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-statusline.mjs'),
    dest: 'wmux-statusline.mjs',
  },
  {
    src: join(repoRoot, 'integrations', 'codex', 'bin', 'wmux-codex-notify.mjs'),
    dest: 'wmux-codex-notify.mjs',
  },
  {
    src: join(repoRoot, 'integrations', 'opencode', 'plugins', 'wmux.js'),
    dest: 'wmux-opencode-plugin.js',
  },
];

mkdirSync(destDir, { recursive: true });
for (const { src, dest: destBasename } of bridges) {
  if (!existsSync(src)) {
    console.error(`copy-bridge: source not found: ${src}`);
    process.exit(1);
  }
  const dest = join(destDir, destBasename);
  copyFileSync(src, dest);
  console.log(`copy-bridge: ${src} -> ${dest}`);
}
