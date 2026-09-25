// diff:summary — Fleet's Ready to review counts, against a real task worktree.
// Committed and uncommitted changes come from numstat against the merge base,
// untracked files are counted without a size cap, and the state key lets a
// repeat ask skip the counting until the worktree actually changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { registerDiffHandlers } from '../diff.handler';
import { IPC } from '../../../../shared/constants';
import type { DiffSummaryResult } from '../../../../shared/diffParse';

vi.setConfig({ testTimeout: 30_000 });

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let base: string;
let wt: string;

beforeEach(() => {
  captured.clear();
  registerDiffHandlers();
  base = mkdtempSync(join(tmpdir(), 'wmux-diffsum-'));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  g(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'a.txt'), 'a1\na2\na3\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  wt = join(base, 'wt');
  g(repo, ['worktree', 'add', '-q', '-b', 'wtask/x', wt, 'HEAD']);
  g(wt, ['config', 'user.email', 't@t']);
  g(wt, ['config', 'user.name', 't']);
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

async function summary(known = ''): Promise<DiffSummaryResult> {
  const fn = captured.get(IPC.DIFF_SUMMARY)!;
  return (await fn({}, wt, known)) as DiffSummaryResult;
}

describe('diff:summary', () => {
  it('counts committed, uncommitted and untracked changes (no size cap on untracked)', async () => {
    writeFileSync(join(wt, 'committed.txt'), 'c1\nc2\n');
    g(wt, ['add', 'committed.txt']);
    g(wt, ['commit', '-q', '-m', 'task commit']);
    writeFileSync(join(wt, 'a.txt'), 'a1\nCHANGED\na3\n');
    // 3 MB untracked text file: past diff:read's per-file cap, still counted.
    writeFileSync(join(wt, 'big.txt'), 'x'.repeat(99) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(30_000));
    writeFileSync(join(wt, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
    const res = await summary();
    expect(res).toMatchObject({ ok: true, files: 4, untracked: 2, binary: 1, additions: 2 + 1 + 30_001, deletions: 1 });
  });

  it('answers unchanged for the same state and recounts after an edit', async () => {
    writeFileSync(join(wt, 'a.txt'), 'a1\nCHANGED\na3\n');
    const first = await summary();
    if (!first.ok || first.unchanged) throw new Error('expected counts');
    expect(first.additions).toBe(1);

    const again = await summary(first.stateKey);
    expect(again).toEqual({ ok: true, stateKey: first.stateKey, unchanged: true });

    // Same status line (" M a.txt"), different content: the key still moves.
    writeFileSync(join(wt, 'a.txt'), 'a1\nCHANGED\nMORE\nLINES\n');
    utimesSync(join(wt, 'a.txt'), new Date(), new Date(Date.now() + 5_000));
    const after = await summary(first.stateKey);
    expect(after.ok && !after.unchanged && after.additions).toBe(3);
  });

  it('refuses a missing path', async () => {
    const fn = captured.get(IPC.DIFF_SUMMARY)!;
    expect(await fn({}, '')).toMatchObject({ ok: false });
  });
});
