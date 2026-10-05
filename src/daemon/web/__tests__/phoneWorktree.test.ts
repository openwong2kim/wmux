import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildGitEnv, createGitRunner, type GitRunner } from '../sessionDiff';
import { createAddRunner, PhoneWorktreeService, scanTree, type PhoneWorktreeOptions } from '../phoneWorktree';
import { pathWithin, samePath } from '../phoneGitRead';
import { PHONE_WORKTREE_RECEIPTS_FILE, PHONE_WORKTREE_RECEIPTS_PER_OWNER, PhoneWorktreeReceipts } from '../phoneWorktreeReceipts';
import { parseWorktreeCreateBody, PHONE_WORKTREE_RECEIPT_TTL_MS, PHONE_WORKTREE_RETRY_AFTER_MS } from '../../../shared/phoneGitV1';
import { windowsDirectoryHold } from '../../../shared/directoryHold';

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root: string;
let wmuxDir: string;
let repo: string;
let audit: Array<[string, string]>;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: buildGitEnv(), encoding: 'utf8' }).trim();
const commit = (cwd: string, files: Record<string, string | Buffer>, message = 'change') => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), text);
  }
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-q', '-m', message);
};
const init = (dir: string, files: Record<string, string | Buffer> | null = { 'a.txt': 'a' }) => {
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Phone Test');
  run(dir, 'config', 'user.email', 'phone@example.invalid');
  if (files) commit(dir, files, 'base');
  return dir;
};
// The desktop's repoHash: realpathSync of git's own toplevel (Windows spells the
// temp dir with its long name there, not os.tmpdir()'s 8.3 short name).
const projectId = (dir: string) => createHash('sha256').update(fs.realpathSync(run(dir, 'rev-parse', '--show-toplevel'))).digest('hex').slice(0, 12);
/** Where the service puts a phone worktree: under the native realpath of wmuxDir. */
const phoneDir = (dir: string, slug: string) => {
  fs.mkdirSync(wmuxDir, { recursive: true });
  return path.join(fs.realpathSync.native(wmuxDir), 'worktrees', projectId(dir), `phone-${slug}`);
};
const branches = (dir: string) => run(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/phone').split('\n').filter(Boolean);
const service = (over: Partial<PhoneWorktreeOptions> = {}) =>
  new PhoneWorktreeService({ wmuxDir, git: createGitRunner(), audit: (d, r) => { audit.push([d, r]); }, ...over });

async function create(svc: PhoneWorktreeService, cwd: string, slug: string, opts: { owner?: string; sessionId?: string; requestId?: string } = {}) {
  const requestId = opts.requestId ?? randomUUID();
  const answer = svc.submit({ owner: opts.owner ?? 'operator', deviceId: '', sessionId: opts.sessionId ?? 's1', cwd, body: { slug, requestId } });
  await answer.done;
  await svc.receipts.flush();
  return { answer, requestId, receipt: svc.receipt(opts.owner ?? 'operator', opts.sessionId ?? 's1', requestId) };
}

// Windows runners spawn git slowly enough to blow the 5 s default.
describe('phone worktree creation', { timeout: 60_000 }, () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-wt-')));
    // Global git config is the temp root: nothing from the runner's ~/.gitconfig.
    process.env.HOME = root; process.env.USERPROFILE = root;
    wmuxDir = path.join(root, '.wmux-test');
    repo = init(path.join(root, 'repo'));
    audit = [];
  });
  afterEach(() => {
    process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses every slug outside the rule and every extra key, before anything runs', () => {
    const requestId = randomUUID();
    for (const slug of ['+x', 'a:b', 'refs/heads/main', '..', '../x', '-x', 'x-', 'a--b', 'A', 'a b', 'a/b', 'x'.repeat(41), '', 'main~1', '@{-1}']) {
      expect(parseWorktreeCreateBody({ slug, requestId })).toEqual({ ok: false, error: 'invalid-slug' });
    }
    for (const extra of [{ path: '/tmp/x' }, { ref: 'main' }, { base: 'HEAD~1' }, { branch: 'phone/x' }, { cwd: '/' }]) {
      expect(parseWorktreeCreateBody({ slug: 'ok', requestId, ...extra })).toEqual({ ok: false, error: 'invalid-git-request' });
    }
    let calls = 0;
    const counting: GitRunner = async () => { calls += 1; return { ok: true, stdout: '', stderr: '' }; };
    const svc = service({ git: counting, addGit: counting });
    for (const body of [{ slug: '..', requestId }, { slug: 'ok', requestId, path: root }, null, []]) {
      expect(svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body }).status).toBe(400);
    }
    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE))).toBe(false);
  });

  it('creates phone/<slug> at the session HEAD in the server-derived directory, and replays', async () => {
    const head = run(repo, 'rev-parse', 'HEAD');
    const svc = service();
    // An uppercase request id (iOS) is the same request as its lowercase form.
    const upper = randomUUID().toUpperCase();
    const first = await create(svc, repo, 'fix-login', { requestId: upper });
    const requestId = upper.toLowerCase();
    expect(first.answer.status).toBe(202);
    expect(first.answer.body).toEqual({ requestId, replayed: false, state: 'pending' });
    const dir = phoneDir(repo, 'fix-login');
    expect(first.receipt).toEqual({
      requestId, state: 'created', projectId: projectId(repo), branch: 'phone/fix-login', base: head, cwd: dir, leaf: 'phone-fix-login',
    });
    expect(run(repo, 'rev-parse', 'refs/heads/phone/fix-login')).toBe(head);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a');
    expect(audit).toEqual([['', 'created']]);
    const replay = svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body: { slug: 'fix-login', requestId } });
    expect(replay).toEqual({ status: 200, body: { ...first.receipt, replayed: true } });
    expect(svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body: { slug: 'other', requestId } }).status).toBe(409);
    expect(svc.submit({ owner: 'operator', deviceId: '', sessionId: 's2', cwd: repo, body: { slug: 'fix-login', requestId } }).status).toBe(409);
    expect(svc.receipt('device:other', 's1', requestId)).toEqual({ requestId, state: 'none' });
    expect(svc.receipt('operator', 's2', requestId)).toEqual({ requestId, state: 'none' });
    expect(service().receipt('operator', 's1', upper)).toEqual(first.receipt);
  });

  it('runs the add with hooks, global attributes, transports and filter drivers switched off', async () => {
    let argv: string[] = [];
    const real = createGitRunner();
    // A filter driver in the repository's own config that would leave a marker if it ran.
    const marker = path.join(root, 'marker');
    const filtered = init(path.join(root, 'filtered'), { '.gitattributes': '*.txt filter=mark\n', 'x.txt': 'x' });
    run(filtered, 'config', 'filter.mark.smudge', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'')" && cat`);
    // Even if the tree scan were to miss the attribute, no driver runs on checkout.
    const svc = service({ scan: async () => ({ filters: 'unused', longest: 1, longestDir: 0 }), addGit: async (args, cwd) => { argv = [...args]; return real(args, cwd); } });
    expect((await create(svc, filtered, 'no-driver')).receipt).toMatchObject({ state: 'created' });
    expect(fs.existsSync(marker)).toBe(false);
    const value = (key: string) => argv[argv.findIndex((a) => a.startsWith(`${key}=`))]?.slice(key.length + 1);
    const empty = path.join(wmuxDir, '.phone-git-empty');
    expect(value('core.hooksPath')).toBe(path.join(empty, 'hooks'));
    expect(value('core.attributesFile')).toBe(path.join(empty, 'attributes'));
    expect(value('protocol.allow')).toBe('never');
    expect(value('filter.mark.smudge')).toBe('');
    expect(value('filter.mark.required')).toBe('false');
    expect(fs.readdirSync(path.join(empty, 'hooks'))).toEqual([]);
  });

  it('records each refusal in the receipt without writing or leaving a project directory', async () => {
    const svc = service();
    await create(svc, repo, 'taken');
    expect((await create(svc, repo, 'taken')).receipt).toMatchObject({ state: 'refused', error: 'branch-exists' });
    fs.mkdirSync(phoneDir(repo, 'occupied'));
    expect((await create(svc, repo, 'occupied')).receipt).toMatchObject({ state: 'refused', error: 'worktree-path-exists' });

    const blocked = init(path.join(root, 'blocked'));
    run(blocked, 'branch', 'phone');
    expect((await create(svc, blocked, 'x')).receipt).toMatchObject({ state: 'refused', error: 'branch-namespace-blocked' });
    const unborn = init(path.join(root, 'unborn'), null);
    expect((await create(svc, unborn, 'x')).receipt).toMatchObject({ state: 'refused', error: 'unborn-head' });
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect((await create(svc, plain, 'x')).receipt).toMatchObject({ state: 'refused', error: 'not-a-git-repo' });
    const sub = init(path.join(root, 'sub'), { '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = ../x\n' });
    expect((await create(svc, sub, 'x')).receipt).toMatchObject({ state: 'refused', error: 'submodules-unsupported' });
    const merging = init(path.join(root, 'merging'));
    fs.writeFileSync(path.join(merging, '.git', 'MERGE_HEAD'), `${run(merging, 'rev-parse', 'HEAD')}\n`);
    expect((await create(svc, merging, 'x')).receipt).toMatchObject({ state: 'refused', error: 'git-operation-in-progress' });

    expect(branches(repo)).toEqual(['phone/taken']);
    for (const dir of [blocked, unborn, sub, merging]) {
      expect(fs.existsSync(path.join(wmuxDir, 'worktrees', projectId(dir)))).toBe(false);
    }
    expect(audit.map(([, reason]) => reason)).toEqual(['created', 'branch-exists', 'worktree-path-exists', 'branch-namespace-blocked',
      'unborn-head', 'not-a-git-repo', 'submodules-unsupported', 'git-operation-in-progress']);
  });

  it('refuses a content filter used anywhere in the whole tree, however the attributes file is stored', async () => {
    const declared = init(path.join(root, 'declared'), { '.gitattributes': '*.bin filter=lfs\n', 'a.txt': 'a' });
    const nested = init(path.join(root, 'nested'), { 'sub/.gitattributes': '*.bin filter=lfs\n', 'sub/x.bin': 'x', 'app/a.txt': 'a' });
    const binaryAttrs = init(path.join(root, 'binary'), {
      '.gitattributes': Buffer.from('*.dat filter=lfs\n\0\n'), 'x.dat': 'x',
    });
    const markedBinary = init(path.join(root, 'marked'), { '.gitattributes': '.gitattributes binary\n*.dat filter=lfs\n', 'x.dat': 'x' });
    const info = init(path.join(root, 'info'), { 'x.dat': 'x' });
    fs.mkdirSync(path.join(info, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(info, '.git', 'info', 'attributes'), '*.dat filter=custom\n');
    // A global `git lfs install` whose driver would fail if it ever ran.
    fs.writeFileSync(path.join(root, '.gitconfig'),
      '[filter "lfs"]\n\tclean = false-command %f\n\tsmudge = false-command %f\n\tprocess = false-command\n\trequired = true\n');
    const svc = service();
    expect((await create(svc, repo, 'global-lfs')).receipt).toMatchObject({ state: 'created' });
    expect((await create(svc, declared, 'unused-filter')).receipt).toMatchObject({ state: 'created' });
    // The session runs in a subdirectory the filtered paths are not under.
    expect((await create(svc, path.join(nested, 'app'), 'nested')).receipt).toMatchObject({ state: 'refused', error: 'git-filters-require-desktop' });
    expect((await create(svc, binaryAttrs, 'binary')).receipt).toMatchObject({ state: 'refused', error: 'git-filters-require-desktop' });
    expect((await create(svc, markedBinary, 'marked')).receipt).toMatchObject({ state: 'refused', error: 'git-filters-require-desktop' });
    expect((await create(svc, info, 'info')).receipt).toMatchObject({ state: 'refused', error: 'git-filters-require-desktop' });
    expect((await scanTree(declared, run(declared, 'rev-parse', 'HEAD'), [])).filters).toBe('unused');
  });

  it('refuses a symbolic link anywhere between the trusted root and the worktree', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(wmuxDir, { recursive: true });
    fs.symlinkSync(outside, path.join(wmuxDir, 'worktrees'), 'dir');
    const svc = service();
    expect((await create(svc, repo, 'escape')).receipt).toMatchObject({ state: 'refused', error: 'worktree-path-unsafe' });
    fs.unlinkSync(path.join(wmuxDir, 'worktrees'));
    fs.mkdirSync(path.join(wmuxDir, 'worktrees'));
    fs.symlinkSync(outside, path.join(wmuxDir, 'worktrees', projectId(repo)), 'dir');
    expect((await create(svc, repo, 'escape2')).receipt).toMatchObject({ state: 'refused', error: 'worktree-path-unsafe' });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(branches(repo)).toEqual([]);
  });

  it('refuses an old git and, on Windows, a tree whose longest path would pass MAX_PATH', async () => {
    const real = createGitRunner();
    const old: GitRunner = async (args, cwd) => (args[0] === 'version' ? { ok: true, stdout: 'git version 2.39.5\n', stderr: '' } : real(args, cwd));
    expect((await create(service({ git: old }), repo, 'old')).receipt).toMatchObject({ state: 'refused', error: 'git-version-unsupported' });
    // The scan reports the longest tree path; a real one this long cannot even
    // be committed on a Windows runner, so the length is the scan's answer.
    const longTree = async () => ({ filters: 'unused' as const, longest: 250, longestDir: 0 });
    expect((await create(service({ platform: 'win32', scan: longTree }), repo, 'deep')).receipt).toMatchObject({ state: 'refused', error: 'path-too-long' });
    expect((await create(service({ platform: 'linux', scan: longTree }), repo, 'deep2')).receipt).toMatchObject({ state: 'created' });
  });

  it('refuses an add that failed and left nothing, and cleans its empty project directory', async () => {
    const svc = service({ addGit: async () => ({ ok: false, ran: true, code: 128, stdout: '', stderr: 'fatal: no space' }) });
    expect((await create(svc, repo, 'nospace')).receipt).toMatchObject({ state: 'refused', error: 'git-operation-failed' });
    expect(fs.existsSync(path.join(wmuxDir, 'worktrees', projectId(repo)))).toBe(false);
    // Git failed the checkout and kept only the branch it had just made: that
    // untouched branch is dropped, so the answer is a plain refusal.
    const branchOnly = service({
      addGit: async () => { run(repo, 'branch', 'phone/objects', 'HEAD'); return { ok: false, ran: true, code: 128, stdout: '', stderr: 'fatal: missing object' }; },
    });
    expect((await create(branchOnly, repo, 'objects')).receipt).toMatchObject({ state: 'refused', error: 'git-operation-failed' });
    expect(branches(repo)).toEqual([]);
  });

  it('reads an interrupted add that left anything behind as unknown, and a repeat recovers it', async () => {
    const real = createGitRunner();
    const scenario = async (slug: string, after: (dir: string) => void, expected: 'created' | 'worktree-path-exists') => {
      const requestId = randomUUID();
      const killed = service({
        addGit: async (args, cwd) => {
          const result = await real(args, cwd);
          after(args[args.indexOf('--') + 1]);
          return result.ok ? { ok: false, ran: false, stdout: '', stderr: 'killed' } : result;
        },
      });
      expect((await create(killed, repo, slug, { requestId })).receipt).toMatchObject({ state: 'unknown', error: 'git-outcome-unknown' });
      // A repeat of the same request (on a daemon that no longer kills it).
      const second = await create(service(), repo, slug, { requestId });
      expect(second.answer.status).toBe(202);
      if (expected === 'created') expect(second.receipt).toMatchObject({ state: 'created', branch: `phone/${slug}`, cwd: phoneDir(repo, slug) });
      else expect(second.receipt).toMatchObject({ state: 'refused', error: expected });
    };
    // Finished checkout, killed before it answered: adopted.
    await scenario('finished', () => undefined, 'created');
    // Git's own "still initializing" lock left behind: removed and created again.
    await scenario('locked', (dir) => { run(repo, 'worktree', 'lock', '--reason', 'initializing', dir); }, 'created');
    // Only the branch was left (the directory is gone): the branch is dropped and created again.
    await scenario('branch-only', (dir) => { run(repo, 'worktree', 'remove', '--force', dir); }, 'created');
    // Someone already has changes in it: left alone.
    await scenario('dirty', (dir) => { fs.writeFileSync(path.join(dir, 'mine.txt'), 'work'); }, 'worktree-path-exists');
    expect(fs.readFileSync(path.join(phoneDir(repo, 'dirty'), 'mine.txt'), 'utf8')).toBe('work');
  });

  // A git runner that records every argv, and whether an argv with this
  // command sequence was ever issued.
  const recording = (calls: string[][]): GitRunner => {
    const real = createGitRunner();
    return async (args, cwd) => { calls.push([...args]); return real(args, cwd); };
  };
  const issued = (calls: string[][], ...command: string[]) =>
    calls.some((argv) => argv.some((_, i) => command.every((word, k) => argv[i + k] === word)));
  // An add that finished its checkout and was then cut off before it could
  // unlock the worktree: what a Windows daemon crash leaves behind once the
  // orphaned `git reset --hard` is done. `damage` can make the checkout partial.
  const cutOff = async (slug: string, damage: (dir: string) => void = () => undefined) => {
    const requestId = randomUUID();
    const real = createGitRunner();
    const killed = service({
      addGit: async (args, cwd) => {
        const result = await real(args, cwd);
        const dir = args[args.indexOf('--') + 1];
        run(repo, 'worktree', 'lock', '--reason', 'initializing', dir);
        damage(dir);
        return result.ok ? { ok: false, ran: false, stdout: '', stderr: 'killed' } : result;
      },
    });
    expect((await create(killed, repo, slug, { requestId })).receipt).toMatchObject({ state: 'unknown' });
    return { requestId, dir: phoneDir(repo, slug) };
  };
  const retryable = (requestId: string) => ({ requestId, state: 'unknown', error: 'git-outcome-unknown', retryAfterMs: PHONE_WORKTREE_RETRY_AFTER_MS });
  // The checkout's administrative directory, from its `.git` file.
  const adminOf = (dir: string) => path.resolve(dir, fs.readFileSync(path.join(dir, '.git'), 'utf8').replace(/^gitdir: /, '').trim());
  // What the add leaves when it stops before its checkout begins: the `.git`
  // file and the registration, no index and no file of the tree.
  const unstarted = (dir: string) => {
    fs.rmSync(path.join(adminOf(dir), 'index'));
    for (const name of fs.readdirSync(dir)) if (name !== '.git') fs.rmSync(path.join(dir, name), { recursive: true });
  };

  it('touches nothing in a locked checkout a process still holds, keeps it retryable, then adopts it', async () => {
    for (const hold of ['in-use', 'refused'] as const) {
      const slug = `held-${hold}`;
      const { requestId, dir } = await cutOff(slug);
      const calls: string[][] = [];
      const probed: string[] = [];
      const busy = service({ git: recording(calls), directoryHold: async (d) => { probed.push(d); return hold; } });
      const again = await create(busy, repo, slug, { requestId });
      expect(again.answer.status).toBe(202);
      expect(again.receipt).toEqual(retryable(requestId));
      expect(probed).toEqual([dir]);
      expect(issued(calls, 'worktree', 'unlock') || issued(calls, 'worktree', 'remove')).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a');
      expect(run(repo, 'worktree', 'list', '--porcelain')).toContain('locked initializing');
      // Once nothing holds it, the same request adopts the finished checkout.
      const later: string[][] = [];
      const free = service({ git: recording(later), directoryHold: async () => 'free' });
      expect((await create(free, repo, slug, { requestId })).receipt).toMatchObject({ state: 'created', cwd: dir, branch: `phone/${slug}` });
      expect(issued(later, 'worktree', 'remove')).toBe(false);
    }
    // A locked checkout whose checkout never began is removed and made again.
    const partial = await cutOff('partial', unstarted);
    const calls: string[][] = [];
    const free = service({ git: recording(calls), directoryHold: async () => 'free' });
    expect((await create(free, repo, 'partial', { requestId: partial.requestId })).receipt).toMatchObject({ state: 'created', cwd: partial.dir });
    expect(issued(calls, 'worktree', 'remove')).toBe(true);
    expect(fs.readFileSync(path.join(partial.dir, 'a.txt'), 'utf8')).toBe('a');
  });

  it('recovers as before when the hold probe itself fails', async () => {
    const { requestId, dir } = await cutOff('probe-fails');
    const probed: string[] = [];
    const svc = service({ directoryHold: async (d) => { probed.push(d); throw new Error('probe failed'); } });
    expect((await create(svc, repo, 'probe-fails', { requestId })).receipt).toMatchObject({ state: 'created', cwd: dir });
    expect(probed).toEqual([dir]);
  });

  it('settles a locked checkout before looking at the main checkout, where a rebase may be stopped', async () => {
    const done = await cutOff('rebasing');
    const partial = await cutOff('rebasing-partial', unstarted);
    // A rebase stopped on a conflict in the session's own checkout.
    run(repo, 'checkout', '-q', '-b', 'other');
    commit(repo, { 'a.txt': 'other' }, 'other');
    run(repo, 'checkout', '-q', 'main');
    commit(repo, { 'a.txt': 'main' }, 'main');
    expect(() => run(repo, 'rebase', 'other')).toThrow();
    const held = service({ directoryHold: async () => 'in-use' });
    expect((await create(held, repo, 'rebasing', { requestId: done.requestId })).receipt).toEqual(retryable(done.requestId));
    const free = service({ directoryHold: async () => 'free' });
    expect((await create(free, repo, 'rebasing', { requestId: done.requestId })).receipt).toMatchObject({ state: 'created', cwd: done.dir });
    // A half-made one goes with its untouched branch; making it again meets the
    // rebase, a plain refusal that leaves nothing behind.
    expect((await create(free, repo, 'rebasing-partial', { requestId: partial.requestId })).receipt)
      .toMatchObject({ state: 'refused', error: 'git-operation-in-progress' });
    expect(fs.existsSync(partial.dir)).toBe(false);
    expect(branches(repo)).not.toContain('phone/rebasing-partial');
    run(repo, 'rebase', '--abort');
    expect((await create(free, repo, 'rebasing-partial')).receipt).toMatchObject({ state: 'created', cwd: partial.dir });
  });

  it('keeps the request retryable when a recovery step does not run, and a removal cut short stays locked', async () => {
    const real = createGitRunner();
    const notRunning = (word: string): GitRunner => async (args, cwd) =>
      (args.includes(word) ? { ok: false, ran: false, stdout: '', stderr: 'timed out' } : real(args, cwd));
    const block = (dir: string) => run(repo, 'worktree', 'list', '--porcelain').split(/\n\n/).find((b) => b.includes(path.basename(dir))) ?? '';
    const stalled = await cutOff('stalled');
    expect((await create(service({ git: notRunning('list'), directoryHold: async () => 'free' }), repo, 'stalled', { requestId: stalled.requestId })).receipt)
      .toEqual(retryable(stalled.requestId));
    const cut = await cutOff('cut-short', unstarted);
    expect((await create(service({ git: notRunning('remove'), directoryHold: async () => 'free' }), repo, 'cut-short', { requestId: cut.requestId })).receipt)
      .toEqual(retryable(cut.requestId));
    expect(block(cut.dir)).toContain('locked initializing');
    // The next repeats get through.
    for (const { requestId, dir } of [stalled, cut]) {
      expect((await create(service({ directoryHold: async () => 'free' }), repo, path.basename(dir).slice('phone-'.length), { requestId })).receipt)
        .toMatchObject({ state: 'created', cwd: dir });
    }
  });

  // The real thing on Windows: a process holding the half-made worktree.
  it.runIf(process.platform === 'win32')('leaves a locked checkout alone while a process holds it on Windows', async () => {
    const { requestId, dir } = await cutOff('held-win');
    // The holder enters the directory itself and only then says so. Probing
    // while a child starts there races its loader: the probe opens the
    // directory for DELETE, the child's open of its startup cwd then fails,
    // and Windows starts it in the system directory, which holds nothing.
    const holder = spawn(process.execPath, ['-e', 'process.chdir(process.argv[1]); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let stderr = '';
      holder.stderr.on('data', (d) => { stderr += String(d); });
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
        holder.once('error', reject);
        holder.once('exit', (code) => reject(new Error(`holder exited (${String(code)}) before holding the directory: ${stderr}`)));
      });
      expect(await windowsDirectoryHold(dir)).toBe('in-use');
      const calls: string[][] = [];
      expect((await create(service({ git: recording(calls) }), repo, 'held-win', { requestId })).receipt).toEqual(retryable(requestId));
      expect(issued(calls, 'worktree', 'unlock') || issued(calls, 'worktree', 'remove')).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a');
    } finally {
      holder.kill();
      await once(holder, 'exit');
    }
    await vi.waitFor(async () => expect(await windowsDirectoryHold(dir)).toBe('free'), { timeout: 10_000, interval: 50 });
    expect((await create(service(), repo, 'held-win', { requestId })).receipt).toMatchObject({ state: 'created', cwd: dir });
  });

  it('keeps the retry hint of an unknown receipt across a restart, and fails closed on a malformed one', async () => {
    const store = new PhoneWorktreeReceipts(wmuxDir);
    const requestId = randomUUID();
    store.begin('operator', requestId, 's1', 'hint');
    store.settle('operator', requestId, { state: 'unknown', error: 'git-outcome-unknown', retryAfterMs: PHONE_WORKTREE_RETRY_AFTER_MS });
    await store.flush();
    expect(new PhoneWorktreeReceipts(wmuxDir).find('operator', requestId)?.receipt).toEqual(retryable(requestId));
    const file = path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, Record<string, unknown>> };
    for (const bad of [0, -1, 1.5, '5000']) {
      for (const entry of Object.values(saved.entries)) entry.retryAfterMs = bad;
      fs.writeFileSync(file, JSON.stringify(saved));
      expect(new PhoneWorktreeReceipts(wmuxDir).available).toBe(false);
    }
  });

  it('turns a journaled pending receipt into unknown at start, and fails closed on an unreadable file', () => {
    const store = new PhoneWorktreeReceipts(wmuxDir);
    const requestId = randomUUID();
    store.begin('device:d1', requestId, 's1', 'crashed');
    store.journal('device:d1', requestId, { phase: 'add', repo: path.join(repo, '.git'), dir: phoneDir(repo, 'crashed'), branch: 'phone/crashed', base: 'a'.repeat(40) });
    const svc = service();
    expect(svc.available).toBe(true);
    expect(svc.receipt('device:d1', 's1', requestId)).toEqual({ requestId, state: 'unknown', error: 'git-outcome-unknown' });
    for (const text of ['{not json', JSON.stringify({ version: 2, entries: {} }), JSON.stringify({ version: 1, entries: { bad: {} } })]) {
      fs.writeFileSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE), text);
      const warnings: string[] = [];
      const off = service({ log: (_level, msg) => { warnings.push(msg); } });
      expect(off.available).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(off.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body: { slug: 'x', requestId: randomUUID() } }))
        .toEqual({ status: 503, body: { error: 'git-receipts-unavailable' } });
      expect(fs.readFileSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE), 'utf8')).toBe(text);
    }
  });

  it('bounds receipts per caller, evicting finished ones first', () => {
    const store = new PhoneWorktreeReceipts(wmuxDir);
    const ids = Array.from({ length: PHONE_WORKTREE_RECEIPTS_PER_OWNER }, () => randomUUID());
    for (const id of ids) store.begin('device:a', id, 's1', 'x');
    expect(() => store.begin('device:a', randomUUID(), 's1', 'x')).toThrow('quota');
    // Another caller is unaffected.
    store.begin('device:b', randomUUID(), 's1', 'x');
    store.settle('device:a', ids[0], { state: 'refused', error: 'branch-exists' });
    store.begin('device:a', randomUUID(), 's1', 'x');
    expect(store.find('device:a', ids[0])).toBeNull();
    expect(store.find('device:a', ids[1])?.receipt.state).toBe('pending');
  });

  it('runs one creation per caller and two overall, and survives an audit sink that throws', async () => {
    const real = createGitRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = service({ addGit: async (args, cwd) => { await gate; return real(args, cwd); }, audit: () => { throw new Error('disk full'); } });
    const submit = (owner: string, slug: string) =>
      svc.submit({ owner, deviceId: '', sessionId: 's1', cwd: repo, body: { slug, requestId: randomUUID() } });
    const a = submit('device:a', 'one');
    expect(submit('device:a', 'two')).toEqual({ status: 429, body: { error: 'git-busy' } });
    const b = submit('device:b', 'three');
    expect(submit('device:c', 'four')).toEqual({ status: 429, body: { error: 'git-busy' } });
    release();
    await Promise.all([a.done, b.done]);
    expect(branches(repo)).toEqual(['phone/one', 'phone/three']);
  });

  it('serializes two sessions of one repository (different worktrees)', async () => {
    const linked = path.join(root, 'linked');
    run(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const other = init(path.join(root, 'other'));
    const real = createGitRunner();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = null as string | null;
    const svc = service({
      addGit: async (args, cwd) => {
        const slug = path.basename(args[args.indexOf('--') + 1]);
        events.push(`start ${slug}`);
        if (slug !== 'phone-third' && gated === null) { gated = slug; await gate; }
        const result = await real(args, cwd);
        events.push(`end ${slug}`);
        return result;
      },
    });
    const submit = (cwd: string, slug: string, owner: string) =>
      svc.submit({ owner, deviceId: '', sessionId: 's', cwd, body: { slug, requestId: randomUUID() } });
    const first = submit(repo, 'first', 'device:1');
    const second = submit(linked, 'second', 'device:2');
    expect(submit(other, 'third', 'device:3').status).toBe(429);
    // Windows runners take seconds to reach the add; then give the other job
    // ample time to get there too, which it must not.
    await vi.waitFor(() => expect(gated).not.toBeNull(), { timeout: 30_000, interval: 50 });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(events).toEqual([`start ${gated}`]);
    release();
    await Promise.all([first.done, second.done]);
    const later = gated === 'phone-first' ? 'phone-second' : 'phone-first';
    expect(events).toEqual([`start ${gated}`, `end ${gated}`, `start ${later}`, `end ${later}`]);
    expect(branches(repo)).toEqual(['phone/first', 'phone/second']);
    const third = submit(other, 'third', 'device:3');
    await third.done;
    expect(branches(other)).toEqual(['phone/third']);
  });

  it('writes a request to disk only once its add starts, and recovers only what that request created', async () => {
    const store = new PhoneWorktreeReceipts(wmuxDir);
    const early = randomUUID();
    const started = randomUUID();
    store.begin('device:a', early, 's1', 'early');
    store.begin('device:b', started, 's1', 'started');
    store.journal('device:b', started, { phase: 'add', repo: path.join(repo, '.git'), dir: phoneDir(repo, 'started'), branch: 'phone/started', base: run(repo, 'rev-parse', 'HEAD') });
    const saved = JSON.parse(fs.readFileSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE), 'utf8')) as { entries: Record<string, { slug: string }> };
    expect(Object.values(saved.entries).map((e) => e.slug)).toEqual(['started']);
    // After a restart the request still in its pre-checks is simply gone.
    const svc = service();
    expect(svc.receipt('device:a', 's1', early)).toEqual({ requestId: early, state: 'none' });
    expect(svc.receipt('device:b', 's1', started)).toEqual({ requestId: started, state: 'unknown', error: 'git-outcome-unknown' });
    // An unknown request with no record of an add: a phone/<slug> branch made elsewhere is not its own.
    const unrecorded = randomUUID();
    svc.receipts.begin('operator', unrecorded, 's1', 'theirs');
    svc.receipts.settle('operator', unrecorded, { state: 'unknown', error: 'git-outcome-unknown' });
    run(repo, 'branch', 'phone/theirs');
    expect((await create(svc, repo, 'theirs', { requestId: unrecorded })).receipt).toMatchObject({ state: 'refused', error: 'branch-exists' });
    // A branch the add created and someone moved since is no longer this request's.
    const moved = randomUUID();
    const killed = service({
      addGit: async () => { run(repo, 'branch', 'phone/moved', 'HEAD'); return { ok: false, ran: false, stdout: '', stderr: 'killed' }; },
    });
    expect((await create(killed, repo, 'moved', { requestId: moved })).receipt).toMatchObject({ state: 'unknown' });
    commit(repo, { 'b.txt': 'b' });
    run(repo, 'branch', '-f', 'phone/moved', 'HEAD');
    expect((await create(service(), repo, 'moved', { requestId: moved })).receipt).toMatchObject({ state: 'refused', error: 'branch-exists' });
    expect(branches(repo)).toEqual(['phone/moved', 'phone/theirs']);
  });

  it('removes the branch a failed add left even when the repository keeps no reflogs', async () => {
    run(repo, 'config', 'core.logAllRefUpdates', 'false');
    const svc = service({
      addGit: async () => { run(repo, 'branch', 'phone/no-reflog', 'HEAD'); return { ok: false, ran: true, code: 128, stdout: '', stderr: 'fatal: missing object' }; },
    });
    expect((await create(svc, repo, 'no-reflog')).receipt).toMatchObject({ state: 'refused', error: 'git-operation-failed' });
    expect(branches(repo)).toEqual([]);
    expect((await create(service(), repo, 'no-reflog')).receipt).toMatchObject({ state: 'created' });
  });

  it('keeps a locked checkout that holds anything but what its own add wrote', async () => {
    const kept = (requestId: string) => expect.objectContaining({ requestId, state: 'refused', error: 'worktree-path-exists' });
    const block = (dir: string) => run(repo, 'worktree', 'list', '--porcelain').split(/\n\n/).find((b) => b.includes(path.basename(dir))) ?? '';
    // Someone else's lock.
    const mine = await cutOff('user-lock', unstarted);
    run(repo, 'worktree', 'unlock', mine.dir);
    run(repo, 'worktree', 'lock', '--reason', 'mine', mine.dir);
    expect((await create(service(), repo, 'user-lock', { requestId: mine.requestId })).receipt).toEqual(kept(mine.requestId));
    expect(block(mine.dir)).toContain('locked mine');
    // A file added to a checkout that never began.
    const added = await cutOff('user-file', (dir) => { unstarted(dir); fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine'); });
    expect((await create(service(), repo, 'user-file', { requestId: added.requestId })).receipt).toEqual(kept(added.requestId));
    expect(fs.readFileSync(path.join(added.dir, 'notes.txt'), 'utf8')).toBe('mine');
    // A finished checkout with a change in it.
    const changed = await cutOff('changed', (dir) => fs.rmSync(path.join(dir, 'a.txt')));
    expect((await create(service(), repo, 'changed', { requestId: changed.requestId })).receipt).toEqual(kept(changed.requestId));
    expect(block(changed.dir)).toContain('locked initializing');
    // A session running inside it.
    const used = await cutOff('in-pane', unstarted);
    const sub = path.join(used.dir, 'sub');
    expect((await create(service({ liveCwds: () => [used.dir] }), repo, 'in-pane', { requestId: used.requestId })).receipt).toEqual(kept(used.requestId));
    expect(fs.existsSync(used.dir)).toBe(true);
    // A checkout git is still writing: nothing is touched until its index lock is gone.
    const writing = await cutOff('writing');
    const lock = path.join(adminOf(writing.dir), 'index.lock');
    fs.writeFileSync(lock, '');
    const calls: string[][] = [];
    expect((await create(service({ git: recording(calls), liveCwds: () => [sub] }), repo, 'writing', { requestId: writing.requestId })).receipt)
      .toEqual(retryable(writing.requestId));
    expect(issued(calls, 'worktree', 'unlock') || issued(calls, 'worktree', 'remove')).toBe(false);
    fs.rmSync(lock);
    expect((await create(service(), repo, 'writing', { requestId: writing.requestId })).receipt).toMatchObject({ state: 'created', cwd: writing.dir });
    expect(branches(repo)).toEqual(['phone/changed', 'phone/in-pane', 'phone/user-file', 'phone/user-lock', 'phone/writing']);
  });

  it('touches no other registration of the repository, and clears its own whose directory is gone', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    run(repo, 'worktree', 'add', '-q', '-b', 'side', elsewhere);
    // Git lists it by its long, canonical spelling (on Windows the temp dir can be an 8.3 name).
    const elsewhereReal = fs.realpathSync.native(elsewhere);
    fs.rmSync(elsewhere, { recursive: true });
    const gone = await cutOff('gone');
    run(repo, 'worktree', 'unlock', gone.dir);
    fs.rmSync(gone.dir, { recursive: true });
    const lockedGone = await cutOff('locked-gone');
    fs.rmSync(lockedGone.dir, { recursive: true });
    for (const { requestId, dir } of [gone, lockedGone]) {
      const calls: string[][] = [];
      const slug = path.basename(dir).slice('phone-'.length);
      expect((await create(service({ git: recording(calls) }), repo, slug, { requestId })).receipt).toMatchObject({ state: 'created', cwd: dir });
      expect(issued(calls, 'worktree', 'prune')).toBe(false);
    }
    const listed = run(repo, 'worktree', 'list', '--porcelain').split('\n')
      .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
    expect(listed.some((p) => samePath(p, elsewhereReal))).toBe(true);
  });

  it('leaves the request retryable when the outcome cannot be decided, and refuses only a confirmed failure', async () => {
    const real = createGitRunner();
    const failing = (match: (args: readonly string[]) => boolean, answer: { ran: boolean; code?: number }): GitRunner => async (args, cwd) =>
      (match(args) ? { ok: false, ...answer, stdout: '', stderr: 'no' } : real(args, cwd));
    const failedAdd = async () => ({ ok: false, ran: true, code: 128, stdout: '', stderr: 'fatal: no space' });
    // The worktree list does not answer after a failed add: whether anything is registered is unknown.
    const unlisted = service({ addGit: failedAdd, git: failing((a) => a.includes('list'), { ran: true, code: 129 }) });
    expect((await create(unlisted, repo, 'unlisted')).receipt).toMatchObject({ state: 'unknown', error: 'git-outcome-unknown' });
    // The branch lookup after the add does not run.
    const unread = service({ addGit: failedAdd, git: failing((a) => a.includes('refs/heads/phone/unread'), { ran: false }) });
    expect((await create(unread, repo, 'unread')).receipt).toMatchObject({ state: 'unknown', error: 'git-outcome-unknown' });
    // The reflog read that decides whether a left-over branch is untouched does not run.
    const noLog = service({
      addGit: async () => { run(repo, 'branch', 'phone/no-log', 'HEAD'); return failedAdd(); },
      git: failing((a) => a.includes('reflog'), { ran: false }),
    });
    const left = await create(noLog, repo, 'no-log');
    expect(left.receipt).toEqual(retryable(left.requestId));
    expect(branches(repo)).toContain('phone/no-log');
    // Recovery: the worktree list answers with nothing usable.
    const listless = await cutOff('listless', unstarted);
    expect((await create(service({ git: failing((a) => a.includes('list'), { ran: true, code: 129 }) }), repo, 'listless', { requestId: listless.requestId })).receipt)
      .toEqual(retryable(listless.requestId));
    // Recovery: the removal ran and failed; the next repeat finishes it.
    const stuck = await cutOff('stuck', unstarted);
    expect((await create(service({ git: failing((a) => a.includes('remove'), { ran: true, code: 1 }) }), repo, 'stuck', { requestId: stuck.requestId })).receipt)
      .toEqual(retryable(stuck.requestId));
    expect((await create(service(), repo, 'stuck', { requestId: stuck.requestId })).receipt).toMatchObject({ state: 'created', cwd: stuck.dir });
    // Recovery: the configuration whose filter drivers the status disarms cannot be read.
    const cfg = await cutOff('cfg');
    expect((await create(service({ git: failing((a) => a.includes('config') && a.includes('--list'), { ran: true, code: 1 }) }), repo, 'cfg', { requestId: cfg.requestId })).receipt)
      .toEqual(retryable(cfg.requestId));
    expect(run(repo, 'worktree', 'list', '--porcelain')).toContain('locked initializing');
    expect((await create(service(), repo, 'cfg', { requestId: cfg.requestId })).receipt).toMatchObject({ state: 'created', cwd: cfg.dir });
    expect((await create(service(), repo, 'listless', { requestId: listless.requestId })).receipt).toMatchObject({ state: 'created', cwd: listless.dir });
  });

  it('drops expired receipts before counting, and never evicts an unknown one', () => {
    let now = 1_000_000;
    const store = new PhoneWorktreeReceipts(wmuxDir, () => now);
    const ids = Array.from({ length: PHONE_WORKTREE_RECEIPTS_PER_OWNER }, () => randomUUID());
    for (const id of ids) {
      store.begin('device:a', id, 's1', 'x');
      store.settle('device:a', id, { state: 'unknown', error: 'git-outcome-unknown' });
    }
    expect(() => store.begin('device:a', randomUUID(), 's1', 'x')).toThrow('quota');
    expect(store.find('device:a', ids[0])?.receipt.state).toBe('unknown');
    // The whole store full of receipts that have all expired takes a new one.
    for (let owner = 0; owner < 19; owner += 1) {
      for (let i = 0; i < PHONE_WORKTREE_RECEIPTS_PER_OWNER; i += 1) store.begin(`device:${owner}`, randomUUID(), 's1', 'x');
    }
    now += PHONE_WORKTREE_RECEIPT_TTL_MS + 1;
    expect(() => store.begin('device:new', randomUUID(), 's1', 'x')).not.toThrow();
  });

  it.runIf(process.platform !== 'win32')('stops every process the add started when it passes its bound', async () => {
    const pidFile = path.join(root, 'pid');
    const runner = createAddRunner(1_000);
    const result = await runner(['-c', `alias.hang=!sh -c 'sleep 30 & echo $! > "${pidFile}"; wait'`, 'hang'], root);
    expect(result).toMatchObject({ ok: false, ran: false });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000, interval: 50 });
  });

  it('scans a tree larger than a pipe buffer, and bounds every directory on Windows', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: buildGitEnv(), input: 'x' }).toString().trim();
    const names = Array.from({ length: 3000 }, (_, i) => `${String(i).padStart(4, '0')}-${'n'.repeat(120)}`);
    const inner = execFileSync('git', ['mktree'], { cwd: repo, env: buildGitEnv(), input: names.map((n) => `100644 blob ${blob}\t${n}\n`).join('') }).toString().trim();
    const dirName = 'd'.repeat(60);
    const outer = execFileSync('git', ['mktree'], { cwd: repo, env: buildGitEnv(), input: `040000 tree ${inner}\t${dirName}\n` }).toString().trim();
    const big = execFileSync('git', ['commit-tree', outer, '-m', 'big'], { cwd: repo, env: buildGitEnv() }).toString().trim();
    expect(await scanTree(repo, big, [])).toEqual({ filters: 'unused', longest: dirName.length + 1 + names[0].length, longestDir: dirName.length });
    const deepDirs = async () => ({ filters: 'unused' as const, longest: 10, longestDir: 240 });
    expect((await create(service({ platform: 'win32', scan: deepDirs }), repo, 'dirs')).receipt).toMatchObject({ state: 'refused', error: 'path-too-long' });
    expect((await create(service({ platform: 'linux', scan: deepDirs }), repo, 'dirs2')).receipt).toMatchObject({ state: 'created' });
  });
});

describe('path comparison', () => {
  it('reads a Windows path git prints as the same path, whatever its separators and letter case', () => {
    const w = path.win32;
    expect(samePath('C:/Users/runneradmin/AppData/Local/Temp/x/elsewhere', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x\\elsewhere', w)).toBe(true);
    expect(samePath('c:/users/RunnerAdmin/x', 'C:\\Users\\runneradmin\\x', w)).toBe(true);
    expect(samePath('C:/Users/runneradmin/x', 'C:\\Users\\runneradmin\\y', w)).toBe(false);
    expect(pathWithin('C:/Users/a/wt/phone-x/src', 'c:\\users\\A\\wt\\phone-x', w)).toBe(true);
    expect(pathWithin('C:/Users/a/wt/phone-x2', 'C:\\Users\\a\\wt\\phone-x', w)).toBe(false);
  });

  it('keeps letter case on POSIX', () => {
    const p = path.posix;
    expect(samePath('/tmp/a/./b/', '/tmp/a/b', p)).toBe(true);
    expect(samePath('/tmp/A', '/tmp/a', p)).toBe(false);
    expect(pathWithin('/tmp/a/b', '/tmp/a', p)).toBe(true);
    expect(pathWithin('/tmp/ab', '/tmp/a', p)).toBe(false);
  });
});
