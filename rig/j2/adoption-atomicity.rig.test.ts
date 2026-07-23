// Verification rig — J2 adoption atomicity + re-serialization integrity (design §5, ship blocker)
//
// Contract (§3 all-or-nothing): a single git apply of selected hunks either fully succeeds or
// fully fails. There is no partial-apply state, so if the process dies mid-apply the target is
// either "fully applied" or "fully unapplied".
//
// **Independent oracle** (§5 — no report dependency): capture a clean pre-apply snapshot, then
// re-check the target with real `git` after apply. Do not trust parser/handler reports.
//
// **Real detection hotspot** (§5): if re-serialization drops the no-newline marker, a trailing
// newline is corrupted at EOF (silent code corruption — worst failure). This rig catches that
// corruption via an independent oracle. Fault injection is enabled with WMUX_RIG_J2_DROP_NONEWLINE=1
// (EVIDENCE procedure):
//   injection ON → rig red (corruption detected) → injection OFF (revert) → green.
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff, reassembleFile, type DiffFile } from '../../src/shared/diffParse';

// Fault-injection toggle (EVIDENCE procedure only). Default OFF.
const DROP_NONEWLINE = process.env.WMUX_RIG_J2_DROP_NONEWLINE === '1';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Reassembly that mimics injected fault: drops no-newline marker lines (re-serialization hotspot).
function reassembleWithFault(file: DiffFile, idxs: number[]): string {
  const clean = reassembleFile(file, idxs);
  if (!DROP_NONEWLINE) return clean;
  // Remove "\ No newline at end of file" lines → git apply appends a trailing newline at EOF.
  return clean
    .split('\n')
    .filter((l) => !l.startsWith('\\ No newline'))
    .join('\n');
}

describe('J2 adoption atomicity — independent git oracle (design §5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-rig-j2-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Create a clean target repo + task worktree (uncommitted changes).
  function scenario(baseContent: Record<string, string>, changes: Record<string, string>) {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['config', 'user.email', 't@t']);
    g(repo, ['config', 'user.name', 't']);
    g(repo, ['config', 'core.autocrlf', 'false']);
    for (const [p, c] of Object.entries(baseContent)) writeFileSync(join(repo, p), c);
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'base']);
    const wt = join(dir, 'wt');
    g(repo, ['worktree', 'add', '-q', '-b', 'wtask/x', wt, 'HEAD']);
    for (const [p, c] of Object.entries(changes)) writeFileSync(join(wt, p), c);
    return { repo, wt };
  }

  it('after selective hunk adoption target reflects selection exactly — independent oracle', () => {
    const { repo, wt } = scenario({ 'a.txt': 'l1\nl2\nl3\n' }, { 'a.txt': 'l1\nCHANGED\nl3\n' });
    const diff = g(wt, ['diff']);
    const file = parseUnifiedDiff(diff).files[0];
    const patch = reassembleWithFault(file, [0]);
    const patchPath = join(dir, 'p.diff');
    writeFileSync(patchPath, patch);
    // Clean oracle: pre-apply target is base.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n');
    g(repo, ['apply', patchPath]);
    // Independent oracle: re-check target with real git.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('l1\nCHANGED\nl3\n');
  });

  it('no-newline file adoption — no trailing newline pollution (real detection hotspot)', () => {
    // Both base and change end without a trailing newline.
    const { repo, wt } = scenario({ 'a.txt': 'l1\nl2\nl3' }, { 'a.txt': 'l1\nCHANGED\nl3' });
    const diff = g(wt, ['diff']);
    expect(diff).toContain('\\ No newline at end of file');
    const file = parseUnifiedDiff(diff).files[0];
    const patch = reassembleWithFault(file, [0]);
    const patchPath = join(dir, 'p.diff');
    writeFileSync(patchPath, patch);
    g(repo, ['apply', patchPath]);
    // Independent oracle: result must end without newline, same as base.
    // With fault injection (marker drop), git appends a trailing newline and this assertion goes red.
    const result = readFileSync(join(repo, 'a.txt'), 'utf8');
    expect(result).toBe('l1\nCHANGED\nl3');
    expect(result.endsWith('\n'), 'no trailing newline pollution').toBe(false);
  });

  it('all-or-nothing — bad patch does not touch target at all (atomicity)'', () => {
    const { repo, wt } = scenario({ 'a.txt': 'l1\nl2\nl3\n' }, { 'a.txt': 'l1\nCHANGED\nl3\n' });
    const diff = g(wt, ['diff']);
    const file = parseUnifiedDiff(diff).files[0];
    // Pre-drift target so apply fails (context mismatch).
    writeFileSync(join(repo, 'a.txt'), 'DIFFERENT\nfile\ncontent\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'drift']);
    const before = readFileSync(join(repo, 'a.txt'), 'utf8');
    const patch = reassembleWithFault(file, [0]);
    const patchPath = join(dir, 'p.diff');
    writeFileSync(patchPath, patch);
    let failed = false;
    try {
      g(repo, ['apply', patchPath]);
    } catch {
      failed = true;
    }
    // Independent oracle: if apply failed, target is byte-identical to pre-apply (no partial apply).
    if (failed) {
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(before);
    }
  });
});
