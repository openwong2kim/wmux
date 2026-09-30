import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGitEnv, createGitRunner, type GitRunner } from '../sessionDiff';
import { PhoneWorktreeService, scanTree, type PhoneWorktreeOptions } from '../phoneWorktree';
import { PHONE_WORKTREE_RECEIPTS_FILE, PHONE_WORKTREE_RECEIPTS_PER_OWNER, PhoneWorktreeReceipts } from '../phoneWorktreeReceipts';
import { parseWorktreeCreateBody } from '../../../shared/phoneGitV1';

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
    const svc = service({ scan: async () => ({ filters: 'unused', longest: 1 }), addGit: async (args, cwd) => { argv = [...args]; return real(args, cwd); } });
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
    const longTree = async () => ({ filters: 'unused' as const, longest: 250 });
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

  it('turns a journaled pending receipt into unknown at start, and fails closed on an unreadable file', () => {
    const store = new PhoneWorktreeReceipts(wmuxDir);
    const requestId = randomUUID();
    store.begin('device:d1', requestId, 's1', 'crashed');
    store.journal();
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
});
