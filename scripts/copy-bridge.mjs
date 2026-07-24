#!/usr/bin/env node
// Copy agent bridges into the CLI bundle so they ship as an extraResource.
// `forge.config.ts` packages the whole `dist/cli-bundle/` directory, so placing
// the bridges there gets them into the packaged app next to the bundled CLI
// (`index.js`). `fmux setup-hooks` / `fmux setup-statusline` then copy them to
// the stable `~/.fmux/hooks/` location (as `fmux-bridge.mjs` /
// `fmux-statusline.mjs`). Codex notify is registered by McpRegistrar as
// `fmux-codex-notify.mjs` under the same hooks dir.
//
// Cross-platform: pure Node built-ins, no shell `cp`. Creates the destination
// directory (mkdir -p equivalent) before copying.

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const destDir = join(repoRoot, 'dist', 'cli-bundle');

// Self-contained agent bridges shipped in the CLI bundle (extraResource):
//   - Claude Code hook/statusline sources (upstream-named in-repo; installed as
//     fmux-* under ~/.fmux/hooks by setup-hooks / setup-statusline)
//   - Codex resume-capture notify bridge (fmux-codex-notify.mjs)
const bridges = [
  join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs'),
  join(repoRoot, 'integrations', 'claude', 'bin', 'wmux-statusline.mjs'),
  join(repoRoot, 'integrations', 'codex', 'bin', 'fmux-codex-notify.mjs'),
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
