// Drift guard for the generated API reference. inventory.md sells
// docs/api/reference.md as the table set that "can never silently drift from
// source" — that promise is only real if something actually runs --check.
// This is that something: it fails the suite whenever rpc.ts, events.ts,
// methodCapabilityMap.ts, or the PipeServer caps change without regenerating
// the doc (`node scripts/gen-api-reference.mjs`).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-api-reference.mjs');

describe('docs/api/reference.md drift guard', () => {
  it('is up to date with the RPC/event/capability sources (gen-api-reference --check)', () => {
    try {
      execFileSync(process.execPath, [SCRIPT, '--check'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        timeout: 30_000,
      });
    } catch (err) {
      const detail = [err.stdout, err.stderr]
        .filter(Boolean)
        .map((b) => b.toString())
        .join('\n');
      expect.fail(
        `docs/api/reference.md is stale — run \`node scripts/gen-api-reference.mjs\` and commit the result.\n${detail}`,
      );
    }
  });
});
