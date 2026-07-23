#!/usr/bin/env node
/**
 * J1 reboot survival demo (§0 pairing — single task round-trip + worktree fs check).
 *
 * Creates one real worktree in a real git repo and checks that the daemon-side
 * canonical store (WorkTaskService) survives mission.start → task.update materialization →
 * **daemon restart simulation (service recreation + boot replay)** with projection
 * (open·branch·worktreePath·paneGroupId) intact, and that worktreePath **exists on disk**.
 *
 * Success criteria (§0): daemon restart → projection restore (open·fields retained) +
 * worktree on disk (script fs check) + channel active. Disk existence is not an
 * "automatic guarantee" but a condition this script establishes and verifies (review G3).
 *
 * This script reproduces the round-trip with real git + real log, no compiled artifacts. Run:
 *   node scripts/j1-reboot-survival-demo.mjs
 * Internally runs a dedicated vitest spec driving src/ canonical modules directly.
 * Exit 0 = round-trip success, non-zero = failure.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'src/daemon/worktask/__tests__/j1-reboot-survival.demo.test.ts';

console.log('[j1-demo] Reboot survival round-trip starting — real git worktree + daemon restart replay + fs check');

const res = spawnSync(
  'npx',
  ['vitest', 'run', SPEC],
  { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
);

if (res.status === 0) {
  console.log('[j1-demo] PASS — projection restored after restart + worktree exists on disk');
  process.exit(0);
} else {
  console.error('[j1-demo] FAIL — round-trip verification failed (see vitest output above)');
  process.exit(res.status ?? 1);
}
