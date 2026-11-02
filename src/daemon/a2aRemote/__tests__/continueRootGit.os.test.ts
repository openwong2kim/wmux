// The receiver's reads of a spawn root tell what the root is (no origin, not
// the top level) apart from what could not be read now (which throws).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Git, GitOut } from '../../../main/a2aRemote/spawnWorktree';
import { rootIsRepoTop, rootOriginKey } from '../continueRootGit';

let root: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-continue-root-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A git that answers each command by its first argument that names it. */
const fakeGit = (answers: Record<string, GitOut>): Git => async (args) => {
  const name = args.find((a) => a in answers);
  if (!name) throw new Error(`unexpected git ${args.join(' ')}`);
  return answers[name];
};
const ok = (stdout: string): GitOut => ({ code: 0, stdout, stderr: '' });
const notRepo: GitOut = { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
const timedOut: GitOut = { code: 1, stdout: '', stderr: 'timed out' };
const noStart: GitOut = { code: 1, stdout: '', stderr: 'Error: spawn /usr/bin/git ENOENT' };
const originList = (url: string): string => `local\0remote.origin.url\n${url}\0`;

describe('rootOriginKey', () => {
  it('names the origin as the asker keys its own, and none for a folder with no origin or no repository', async () => {
    expect(await rootOriginKey(fakeGit({ '--git-common-dir': ok('.git\n'), config: ok(originList('git@github.com:Acme/Widget.git')) }), root)).toBe('github.com/acme/widget');
    expect(await rootOriginKey(fakeGit({ '--git-common-dir': ok('.git\n'), config: ok('') }), root)).toBeNull();
    expect(await rootOriginKey(fakeGit({ '--git-common-dir': notRepo }), root)).toBeNull();
  });

  it('throws when git could not be read now, rather than answering no origin', async () => {
    await expect(rootOriginKey(fakeGit({ '--git-common-dir': timedOut }), root)).rejects.toThrow('timed out');
    await expect(rootOriginKey(fakeGit({ '--git-common-dir': ok('.git\n'), config: timedOut }), root)).rejects.toThrow('timed out');
  });

  it('answers none for a root folder that is gone, where git cannot start; throws when it cannot start in one that is there', async () => {
    expect(await rootOriginKey(fakeGit({ '--git-common-dir': noStart }), path.join(root, 'deleted'))).toBeNull();
    await expect(rootOriginKey(fakeGit({ '--git-common-dir': noStart }), root)).rejects.toThrow('ENOENT');
  });
});

describe('rootIsRepoTop', () => {
  it('true only when git names this folder as the top level; false inside another repository or none', async () => {
    expect(await rootIsRepoTop(fakeGit({ '--show-toplevel': ok(`${root}\n`) }), root)).toBe(true);
    expect(await rootIsRepoTop(fakeGit({ '--show-toplevel': ok(`${path.dirname(root)}\n`) }), root)).toBe(false);
    expect(await rootIsRepoTop(fakeGit({ '--show-toplevel': notRepo }), root)).toBe(false);
    expect(await rootIsRepoTop(fakeGit({ '--show-toplevel': ok(`${path.join(root, 'gone')}\n`) }), root)).toBe(false);
  });

  it('throws when git could not be read now', async () => {
    await expect(rootIsRepoTop(fakeGit({ '--show-toplevel': timedOut }), root)).rejects.toThrow('timed out');
  });

  it('false for a root folder that is gone, where git cannot start; throws when it cannot start in one that is there', async () => {
    expect(await rootIsRepoTop(fakeGit({ '--show-toplevel': noStart }), path.join(root, 'deleted'))).toBe(false);
    await expect(rootIsRepoTop(fakeGit({ '--show-toplevel': noStart }), root)).rejects.toThrow('ENOENT');
  });
});
