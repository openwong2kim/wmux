// diff:status — the Git page Worktrees tab's "uncommitted changes" read,
// against a real worktree: git status only, so a huge untracked file costs
// nothing and is still counted, and a path that is not a worktree answers an
// error (the tab treats that as unknown, never as clean).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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

vi.setConfig({ testTimeout: 30_000 });

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let base: string;
let repo: string;

beforeEach(() => {
  captured.clear();
  registerDiffHandlers();
  base = mkdtempSync(join(tmpdir(), 'wmux-diffstatus-'));
  repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const status = async (p: string) => captured.get(IPC.DIFF_STATUS)!({}, p);

describe('diff:status', () => {
  it('a clean worktree has no changed paths; commits alone are not changes', async () => {
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'more']);
    expect(await status(repo)).toEqual({ ok: true, files: 0 });
  });

  it('counts staged, unstaged and untracked paths without reading them', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'staged.txt'), 's\n');
    g(repo, ['add', 'staged.txt']);
    // Past diff:read's per-file cap: diff:read would fail here; status does not.
    writeFileSync(join(repo, 'big.log'), 'x'.repeat(3 * 1024 * 1024));
    expect(await status(repo)).toEqual({ ok: true, files: 3 });
  });

  it('a folder that is not a worktree is an error, not clean', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const res = await status(plain) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});
