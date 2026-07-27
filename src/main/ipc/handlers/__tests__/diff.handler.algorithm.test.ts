// diff:read pins the diff algorithm on the argv.
//
// The rest of the diff.handler suite drives real git, which cannot prove WHICH
// algorithm was requested: on most inputs Myers and histogram agree, so an
// output comparison would pass even if the flag were dropped. This file stubs
// the git helper and asserts the argv instead — the flag is the contract.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

// Every git invocation is recorded and answered from a script, so the handler
// runs its full read path without a repository on disk.
const calls: string[][] = [];
const HEAD_OID = '1111111111111111111111111111111111111111';
const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  '',
].join('\n');

vi.mock('../../../git/git', () => ({
  git: vi.fn(async (args: string[]) => {
    calls.push(args);
    const line = args.join(' ');
    const okr = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    if (line.includes('--git-common-dir')) return okr('/fake/repo/.git');
    if (line.includes('--show-toplevel')) return okr('/fake/repo');
    if (line.includes('--abbrev-ref')) return okr('main');
    if (line.includes('rev-parse HEAD')) return okr(HEAD_OID);
    if (args[0] === 'merge-base') return okr(HEAD_OID);
    if (args.includes('--numstat')) return okr('1\t1\ta.txt\n');
    if (args[0] === 'diff') return okr(PATCH);
    return okr('');
  }),
}));

import { registerDiffHandlers } from '../diff.handler';
import { IPC } from '../../../../shared/constants';

describe('diff:read — 알고리즘 argv', () => {
  // resolveAccessiblePath realpaths its input, so the cwd must exist even
  // though no git command will ever look inside it.
  let dir: string;
  beforeEach(() => {
    captured.clear();
    calls.length = 0;
    registerDiffHandlers();
    dir = mkdtempSync(join(tmpdir(), 'wmux-diffalgo-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('task 모드의 patch·numstat 모두 --histogram으로 요청', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, dir, HEAD_OID)) as { ok: boolean };
    expect(res.ok).toBe(true);

    const diffs = calls.filter((c) => c[0] === 'diff');
    expect(diffs).toHaveLength(2);
    for (const c of diffs) expect(c).toContain('--histogram');
    // The numstat must describe the same diff the panel renders, or the file
    // tree's +/- counts disagree with the hunks under them.
    expect(diffs.some((c) => c.includes('--numstat'))).toBe(true);
  });

  it('workspace 모드도 동일하게 --histogram으로 요청', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, dir, '', 'workspace')) as { ok: boolean };
    expect(res.ok).toBe(true);

    const diffs = calls.filter((c) => c[0] === 'diff');
    expect(diffs).toHaveLength(2);
    for (const c of diffs) expect(c).toContain('--histogram');
  });
});
