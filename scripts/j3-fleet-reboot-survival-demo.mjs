#!/usr/bin/env node
// ─── J3 fleet reboot survival demo runner (§5(a) — hard gate verdict) ─────────
//
// fanout N=4 → 4 real worktrees + artifact seeding → daemon restart replay →
// reproduces **full daemon state restore** (projection·materialized fields·worktree
// fs + artifacts·channel active).
//
// Demonstration scope rule (§5): this script's PASS only proves daemon state restore.
// Workspace·pane restore is verified separately via manual scenario docs (docs).
//
// Usage:
//   node scripts/j3-fleet-reboot-survival-demo.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'src/daemon/worktask/__tests__/j3-fleet-reboot-survival.demo.test.ts';

console.log('[j3-fleet-demo] Fleet reboot survival round-trip starting — N=4 real worktrees + artifact seeding + restart replay');

// On Windows `npx` is `npx.cmd`; spawning without shell yields ENOENT/EINVAL
// (recent Node .cmd spawn hardening). shell:true resolves the executable — args
// are the static constant SPEC, so no shell injection surface.
const res = spawnSync(
  'npx',
  ['vitest', 'run', SPEC],
  { cwd: REPO_ROOT, stdio: 'inherit', env: process.env, shell: true },
);

if (res.status === 0) {
  console.log('[j3-fleet-demo] PASS — full fleet of 4 daemon states restored after restart (projection·worktree·artifacts·channel)');
  process.exit(0);
} else {
  console.error('[j3-fleet-demo] FAIL — fleet round-trip verification failed (see vitest output above)');
  process.exit(res.status ?? 1);
}
