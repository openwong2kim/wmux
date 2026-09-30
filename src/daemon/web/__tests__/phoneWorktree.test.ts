import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGitEnv, createGitRunner, type GitRunner } from '../sessionDiff';
import { PhoneWorktreeService, scanTreeFilters, type PhoneWorktreeOptions } from '../phoneWorktree';
import { PHONE_WORKTREE_RECEIPTS_FILE, PhoneWorktreeReceipts } from '../phoneWorktreeReceipts';
import { parseWorktreeCreateBody } from '../../../shared/phoneGitV1';

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root: string;
let wmuxDir: string;
let repo: string;
let audit: Array<[string, string]>;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: buildGitEnv(), encoding: 'utf8' }).trim();
const commit = (cwd: string, files: Record<string, string>, message = 'change') => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), text);
  }
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-q', '-m', message);
};
const init = (dir: string, files: Record<string, string> | null = { 'a.txt': 'a' }) => {
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Phone Test');
  run(dir, 'config', 'user.email', 'phone@example.invalid');
  if (files) commit(dir, files, 'base');
  return dir;
};
const projectId = (dir: string) => createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 12);
const slots = () => { let used = 0; return { acquire: () => { if (used >= 4) return false; used += 1; return true; }, release: () => { used -= 1; }, get used() { return used; } }; };
const service = (over: Partial<PhoneWorktreeOptions> = {}) =>
  new PhoneWorktreeService({ wmuxDir, git: createGitRunner(), audit: (d, r) => { audit.push([d, r]); }, ...over });

async function create(svc: PhoneWorktreeService, cwd: string, slug: string, opts: { owner?: string; sessionId?: string; requestId?: string } = {}) {
  const requestId = opts.requestId ?? randomUUID();
  const answer = svc.submit({ owner: opts.owner ?? 'operator', deviceId: '', sessionId: opts.sessionId ?? 's1', cwd, body: { slug, requestId } }, slots());
  await answer.done;
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
    expect(parseWorktreeCreateBody({ slug: 'ok', requestId: requestId.toUpperCase() })).toEqual({ ok: false, error: 'invalid-git-request' });
    let calls = 0;
    const counting: GitRunner = async () => { calls += 1; return { ok: true, stdout: '', stderr: '' }; };
    const svc = service({ git: counting, addGit: counting });
    for (const body of [{ slug: '..', requestId }, { slug: 'ok', requestId, path: root }, null, []]) {
      expect(svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body }, slots()).status).toBe(400);
    }
    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE))).toBe(false);
  });

  it('creates phone/<slug> at the session HEAD in the server-derived directory, and replays', async () => {
    const head = run(repo, 'rev-parse', 'HEAD');
    const svc = service();
    const first = await create(svc, repo, 'fix-login');
    expect(first.answer.status).toBe(202);
    expect(first.answer.body).toEqual({ requestId: first.requestId, replayed: false, state: 'pending' });
    const dir = path.join(wmuxDir, 'worktrees', projectId(repo), 'phone-fix-login');
    expect(first.receipt).toEqual({
      requestId: first.requestId, state: 'created', projectId: projectId(repo), branch: 'phone/fix-login',
      base: head, cwd: dir, leaf: 'phone-fix-login',
    });
    expect(run(repo, 'rev-parse', 'refs/heads/phone/fix-login')).toBe(head);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a');
    expect(audit).toEqual([['', 'created']]);
    // The same body again: the receipt, not a second `worktree add`.
    const replay = svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body: { slug: 'fix-login', requestId: first.requestId } }, slots());
    expect(replay).toEqual({ status: 200, body: { ...first.receipt, replayed: true } });
    expect(svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body: { slug: 'other', requestId: first.requestId } }, slots()).status).toBe(409);
    expect(svc.submit({ owner: 'operator', deviceId: '', sessionId: 's2', cwd: repo, body: { slug: 'fix-login', requestId: first.requestId } }, slots()).status).toBe(409);
    // Receipts are per owner and per session.
    expect(svc.receipt('device:other', 's1', first.requestId)).toEqual({ requestId: first.requestId, state: 'none' });
    expect(svc.receipt('operator', 's2', first.requestId)).toEqual({ requestId: first.requestId, state: 'none' });
    // A fresh service reads the same durable receipt.
    expect(service().receipt('operator', 's1', first.requestId)).toEqual(first.receipt);
  });

  it('records each refusal in the receipt without writing', async () => {
    const svc = service();
    await create(svc, repo, 'taken');
    expect((await create(svc, repo, 'taken')).receipt).toMatchObject({ state: 'refused', error: 'branch-exists' });

    fs.mkdirSync(path.join(wmuxDir, 'worktrees', projectId(repo), 'phone-occupied'), { recursive: true });
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

    expect(run(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/phone').split('\n')).toEqual(['phone/taken']);
    expect(audit.map(([, reason]) => reason)).toEqual(['created', 'branch-exists', 'worktree-path-exists', 'branch-namespace-blocked',
      'unborn-head', 'not-a-git-repo', 'submodules-unsupported', 'git-operation-in-progress']);
  });

  it('refuses only a content filter the base tree actually uses, never global config alone', async () => {
    const declared = init(path.join(root, 'declared'), { '.gitattributes': '*.bin filter=lfs\n', 'a.txt': 'a' });
    const used = init(path.join(root, 'used'), { 'sub/.gitattributes': '*.bin filter=lfs\n', 'sub/x.bin': 'x' });
    const info = init(path.join(root, 'info'), { 'x.dat': 'x' });
    fs.mkdirSync(path.join(info, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(info, '.git', 'info', 'attributes'), '*.dat filter=custom\n');
    // A global `git lfs install` whose driver would fail if it ever ran: the
    // creations below that succeed prove no filter ran on checkout.
    fs.writeFileSync(path.join(root, '.gitconfig'),
      '[filter "lfs"]\n\tclean = false-command %f\n\tsmudge = false-command %f\n\tprocess = false-command\n\trequired = true\n');
    const svc = service();
    expect((await create(svc, repo, 'global-lfs')).receipt).toMatchObject({ state: 'created' });
    expect((await create(svc, declared, 'unused-filter')).receipt).toMatchObject({ state: 'created' });
    expect((await create(svc, used, 'used-filter')).receipt).toMatchObject({ state: 'refused', error: 'git-filters-require-desktop' });
    expect((await create(svc, info, 'info-filter')).receipt).toMatchObject({ state: 'refused', error: 'git-filters-require-desktop' });
    // The per-path check itself answered, rather than failing closed.
    expect(await scanTreeFilters(used, run(used, 'rev-parse', 'HEAD'))).toBe('used');
    expect(await scanTreeFilters(declared, run(declared, 'rev-parse', 'HEAD'))).toBe('unused');
  });

  it('reads a killed worktree add as unknown and leaves the half-written directory in place', async () => {
    const svc = service({
      addGit: async (args) => {
        // Killed mid-checkout: the directory exists, git never answered.
        const dir = args[args.indexOf('--') + 1];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'partial'), '');
        return { ok: false, ran: false, stdout: '', stderr: 'killed' };
      },
    });
    const { receipt } = await create(svc, repo, 'killed');
    expect(receipt).toMatchObject({ state: 'unknown', error: 'git-outcome-unknown' });
    expect(fs.existsSync(path.join(wmuxDir, 'worktrees', projectId(repo), 'phone-killed', 'partial'))).toBe(true);
    expect(audit).toEqual([['', 'git-outcome-unknown']]);
  });

  it('turns a pending receipt found at start into unknown', () => {
    const store = new PhoneWorktreeReceipts(wmuxDir);
    const requestId = randomUUID();
    store.begin('device:d1', requestId, 's1', 'crashed');
    const svc = service();
    expect(svc.available).toBe(true);
    expect(svc.receipt('device:d1', 's1', requestId)).toEqual({ requestId, state: 'unknown', error: 'git-outcome-unknown' });
  });

  it('fails closed on a receipt file it cannot read', () => {
    fs.mkdirSync(wmuxDir, { recursive: true });
    for (const text of ['{not json', JSON.stringify({ version: 2, entries: {} }), JSON.stringify({ version: 1, entries: { bad: {} } })]) {
      fs.writeFileSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE), text);
      const svc = service();
      expect(svc.available).toBe(false);
      const answer = svc.submit({ owner: 'operator', deviceId: '', sessionId: 's1', cwd: repo, body: { slug: 'x', requestId: randomUUID() } }, slots());
      expect(answer).toEqual({ status: 503, body: { error: 'git-receipts-unavailable' } });
      // The unreadable file is left exactly as it was.
      expect(fs.readFileSync(path.join(wmuxDir, PHONE_WORKTREE_RECEIPTS_FILE), 'utf8')).toBe(text);
    }
  });

  it('serializes two sessions of one repository (different worktrees) and not other repositories', async () => {
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
        // Hold whichever of this repository's two jobs reaches `worktree add` first.
        if (slug !== 'phone-third' && gated === null) { gated = slug; await gate; }
        const result = await real(args, cwd);
        events.push(`end ${slug}`);
        return result;
      },
    });
    const budget = slots();
    const submit = (cwd: string, slug: string, sessionId: string) =>
      svc.submit({ owner: 'operator', deviceId: '', sessionId, cwd, body: { slug, requestId: randomUUID() } }, budget);
    const first = submit(repo, 'first', 'main-pane');
    const second = submit(linked, 'second', 'linked-pane');
    const third = submit(other, 'third', 'other-pane');
    expect(budget.used).toBe(3);
    await third.done;
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The other repository ran; this repository's second job did not start.
    expect(gated).not.toBeNull();
    expect(events.filter((e) => !e.includes('third'))).toEqual([`start ${gated}`]);
    expect(events).toContain('end phone-third');
    release();
    await Promise.all([first.done, second.done]);
    const later = gated === 'phone-first' ? 'phone-second' : 'phone-first';
    expect(events.filter((e) => !e.includes('third'))).toEqual([`start ${gated}`, `end ${gated}`, `start ${later}`, `end ${later}`]);
    expect(budget.used).toBe(0);
    expect(run(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/phone').split('\n')).toEqual(['phone/first', 'phone/second']);
  });
});
