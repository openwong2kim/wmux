import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGitEnv, createGitRunner } from '../../sessionDiff';
import { resolvePhoneGitRepo, type PhoneGitRepo } from '../../phoneGitRead';
import { createPhoneGitPrHandlers, type PrGhResult, type PrGhRunner } from '../../phoneGitPr';
import { getExecEnv } from '../../../../shared/execEnv';
import type { GitWriteExecuteContext, GitWriteSettle } from '../../phoneGitWriteRegistry';
import type { PrCreateExecuteBody, PrMergeExecuteBody } from '../../../../shared/phoneGitWrite';

/**
 * pr.create and pr.merge against a fake gh: nothing here reaches GitHub. The
 * repository is a real local checkout whose `origin` names a github.com URL
 * that is never contacted.
 */

const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const SQUASH = 'c'.repeat(40);

type Call = { args: string[]; input?: string };

/** A GitHub PR as the fake answers it. */
interface FakePr {
  state: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; headRefOid: string;
  mergeCommit: string | null; checks: Array<Record<string, unknown>>; totalCount?: number;
  /** No rollup at all (contexts null). */
  noRollup?: boolean;
  /** A page after the first fails to read. */
  laterPagesFail?: boolean;
}

const checkRun = (name: string, conclusion: string | null, isRequired?: boolean | null) => ({
  __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion,
  ...(isRequired !== undefined ? { isRequired } : {}),
});

describe('phone pr.create and pr.merge', { timeout: 30_000 }, () => {
  let root: string;
  let cwd: string;
  let repo: PhoneGitRepo;
  let calls: Call[];
  let pr: FakePr;
  let squashAllowed: boolean;
  let requiredReadable: boolean;
  let onMerge: () => Promise<PrGhResult>;
  let now: number;
  // pr.create's side of GitHub.
  let remoteHead: string | null;
  let openPrs: Array<Record<string, unknown>>;
  let aheadBy: number;
  let baseExists: boolean;
  let onCreate: () => Promise<PrGhResult>;

  const git = (...args: string[]) => execFileSync('git', args, { cwd, env: buildGitEnv(), encoding: 'utf8' }).trim();
  const ok = (data: unknown): PrGhResult => ({ ok: true, stdout: JSON.stringify(data) });
  const fail = (stderr: string): PrGhResult => ({ ok: false, spawned: true, stdout: '', stderr });

  const gh: PrGhRunner = async (args, opts) => {
    calls.push({ args: [...args], ...(opts.input !== undefined ? { input: opts.input } : {}) });
    expect(opts.env.GH_TOKEN).toBe('gho_octo');
    // Never the session's checkout: on Windows a gh.exe there would run first.
    expect(opts).not.toHaveProperty('cwd');
    // gh resolves on the same search path as every other spawn, with the identity's HOME.
    expect(opts.env.PATH).toBe(process.platform === 'win32' ? '/usr/bin:/bin' : getExecEnv().PATH);
    expect(opts.env.HOME).toBe('/home/octo');
    if (args[0] === 'pr' && args[1] === 'merge') return onMerge();
    if (args[0] === 'api' && args.includes('POST')) return onCreate();
    const query = args.find((a) => a.startsWith('query=')) ?? '';
    if (query.includes('squashMergeAllowed')) {
      if (query.includes('isRequired') && !requiredReadable) return fail('GraphQL: Resource not available for isRequired');
      // 100 checks a page; the cursor is the index of the next one.
      const after = Number(args.find((a) => a.startsWith('after='))?.slice('after='.length) ?? 0);
      if (after > 0 && pr.laterPagesFail) return fail('Post "https://api.github.com/graphql": EOF');
      const page = pr.checks.slice(after, after + 100).map((c) => {
        if (query.includes('isRequired')) return c;
        const { isRequired: _omitted, ...rest } = c;
        return rest;
      });
      const hasNextPage = after + 100 < pr.checks.length;
      return ok({ data: { repository: { squashMergeAllowed: squashAllowed, pullRequest: {
        number: 1980, title: 'Add the thing', state: pr.state, isDraft: pr.isDraft, mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus, headRefOid: pr.headRefOid, headRefName: 'feat/x', baseRefName: 'main',
        mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null,
        commits: { nodes: [{ commit: { statusCheckRollup: pr.noRollup ? null : { contexts: {
          totalCount: pr.totalCount ?? pr.checks.length,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? String(after + 100) : null },
          nodes: page,
        } } } }] },
      } } } });
    }
    if (args.includes('GET')) return ok(openPrs);
    if (query.includes('headRef: ref(')) {
      const hasBase = args.includes('hasBase=true');
      return ok({ data: { repository: {
        defaultBranchRef: { name: 'main', compare: { aheadBy } },
        ...(hasBase ? { baseRef: baseExists ? { name: args.find((a) => a.startsWith('baseQ='))?.slice('baseQ=refs/heads/'.length), compare: { aheadBy } } : null } : {}),
        headRef: remoteHead ? { target: { oid: remoteHead } } : null,
      } } });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-git-pr-')));
    cwd = path.join(root, 'repo');
    fs.mkdirSync(cwd);
    git('init', '-q', '-b', 'feat/x');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'work');
    git('remote', 'add', 'origin', 'https://github.com/octo/repo.git');
    calls = [];
    now = 5_000_000;
    pr = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD, mergeCommit: null,
      checks: [checkRun('build', 'SUCCESS', true), checkRun('lint', 'FAILURE', false)] };
    squashAllowed = true;
    requiredReadable = true;
    onMerge = async () => {
      pr = { ...pr, state: 'MERGED', mergeCommit: SQUASH };
      return { ok: true, stdout: '' };
    };
    remoteHead = git('rev-parse', 'HEAD');
    openPrs = [];
    aheadBy = 1;
    baseExists = true;
    onCreate = async () => ok({ number: 1981, html_url: 'https://github.com/octo/repo/pull/1981' });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const handlers = () => createPhoneGitPrHandlers({ gh, git: createGitRunner(), now: () => now, sleep: async () => undefined });
  const session = async (action: 'pr.create' | 'pr.merge') => {
    repo = (await resolvePhoneGitRepo(cwd, createGitRunner()))!;
    return { action, owner: 'device:d', deviceId: 'd', sessionId: 's1', cwd, repo, login: 'octo', ghEnv: { GH_TOKEN: 'gho_octo', HOME: '/home/octo', PATH: '/usr/bin:/bin' },
      ...(action === 'pr.merge' ? { number: 1980 } : {}) };
  };
  const execute = async (run: (ctx: GitWriteExecuteContext) => Promise<void>, action: 'pr.create' | 'pr.merge', body: PrCreateExecuteBody | PrMergeExecuteBody) => {
    const settled: GitWriteSettle[] = [];
    const markInFlight = vi.fn();
    const outcome = await run({
      ...await session(action), requestId: body.requestId, body,
      pins: action === 'pr.merge' ? { number: 1980, headRefOid: (body as PrMergeExecuteBody).expectHead } : null,
      markInFlight, settle: (o) => { settled.push(o); },
    }).then(() => 'returned' as const, () => 'threw' as const);
    return { settled, markInFlight, outcome };
  };
  const mergeBody = (over: Partial<PrMergeExecuteBody> = {}): PrMergeExecuteBody => ({
    requestId: '0d6b1c1e-1111-4222-8333-444455556666', confirmToken: 'x'.repeat(43), expectHead: HEAD, method: 'squash',
    subject: '-starts with a dash (#1980)', body: 'b'.repeat(40 * 1024), ...over,
  });
  const createBody = (over: Partial<PrCreateExecuteBody> = {}): PrCreateExecuteBody => ({
    requestId: '0d6b1c1e-1111-4222-8333-444455556667', title: 'Add the thing', body: 'Why', ...over,
  });
  /** An open PR as the REST list answers it; defaults match createBody(). */
  const restPr = (number: number, over: { repo?: string; title?: string; base?: string; draft?: boolean; createdAt?: number } = {}) => ({
    number, title: over.title ?? 'Add the thing', draft: over.draft ?? false, created_at: new Date(over.createdAt ?? now).toISOString(),
    html_url: `https://github.com/octo/repo/pull/${number}`, base: { ref: over.base ?? 'main' },
    head: { ref: 'feat/x', repo: { full_name: over.repo ?? 'octo/repo' } },
  });
  const merges = () => calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');

  describe('pr.merge', () => {
    it('previews PrMergeFacts with the required lists and pins the head', async () => {
      const result = await handlers().merge.preview!(await session('pr.merge'));
      expect(result).toEqual({
        ok: true,
        pins: { number: 1980, headRefOid: HEAD },
        facts: {
          number: 1980, title: 'Add the thing', state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'feat/x', baseRefName: 'main',
          mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', block: 'checks-failing', squashAllowed: true,
          checks: { overall: 'failure', counts: { total: 2, passed: 1, failed: 1, pending: 0, skipped: 0 }, requiredFailing: [], requiredPending: [] },
          methods: ['squash'], subject: 'Add the thing (#1980)', body: '', identity: { login: 'octo' },
        },
      });
      const read = calls[0].args;
      expect(read).toEqual(expect.arrayContaining(['-f', 'owner=octo', '-f', 'repo=repo', '-F', 'number=1980']));
    });

    it('omits the required lists when GitHub cannot say which checks are required', async () => {
      requiredReadable = false;
      const unreadable = await handlers().merge.preview!(await session('pr.merge'));
      expect(unreadable.ok && unreadable.facts.checks).toEqual({ overall: 'failure', counts: expect.any(Object) });
      requiredReadable = true;
      pr.checks = [checkRun('build', 'SUCCESS', true), checkRun('lint', null, null)];
      const partial = await handlers().merge.preview!(await session('pr.merge'));
      expect(partial.ok && partial.facts.checks).not.toHaveProperty('requiredPending');
      pr.checks = [checkRun('build', null, true)];
      const pending = await handlers().merge.preview!(await session('pr.merge'));
      expect(pending.ok && pending.facts.checks).toMatchObject({ requiredFailing: [], requiredPending: ['build'] });
      // No rollup to read: the lists are omitted, never sent empty.
      pr.noRollup = true;
      const none = await handlers().merge.preview!(await session('pr.merge'));
      expect(none.ok && none.facts.checks).toEqual({ overall: 'none', counts: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 } });
    });

    it('reads every page of checks', async () => {
      pr.checks = Array.from({ length: 150 }, (_, i) => checkRun(`check-${i}`, 'SUCCESS', i === 149));
      const result = await handlers().merge.preview!(await session('pr.merge'));
      expect(result.ok && result.facts).toMatchObject({
        block: null,
        checks: { overall: 'success', counts: { total: 150, passed: 150 }, requiredFailing: [], requiredPending: [] },
      });
      expect(calls.filter((c) => c.args.some((a) => a.startsWith('query=')))).toHaveLength(2);
      expect(calls[1].args).toContain('after=100');
    });

    it.each([
      ['a later page fails', () => { pr.laterPagesFail = true; }],
      ['GitHub counts more checks than it lists', () => { pr.checks = pr.checks.slice(0, 100); pr.totalCount = 150; }],
    ])('treats checks it could not read as still running (%s)', async (_case, arrange) => {
      pr.checks = Array.from({ length: 150 }, (_, i) => checkRun(`check-${i}`, 'SUCCESS', false));
      arrange();
      const result = await handlers().merge.preview!(await session('pr.merge'));
      expect(result.ok && result.facts.block).toBe('checks-pending');
      // Counts over a partial read would understate the total: none at all, as on Moa's card.
      expect(result.ok && result.facts.checks).toEqual({ overall: 'pending', counts: {} });
      const { settled } = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      expect(settled).toEqual([{ state: 'refused', error: 'blocked', fields: { reason: 'checks-pending' } }]);
    });

    it('a partial read with a failing check it did read: overall failure, no counts', async () => {
      pr.checks = Array.from({ length: 100 }, (_, i) => checkRun(`check-${i}`, i === 7 ? 'FAILURE' : 'SUCCESS', false));
      pr.totalCount = 150;
      const result = await handlers().merge.preview!(await session('pr.merge'));
      expect(result.ok && result.facts.checks).toEqual({ overall: 'failure', counts: {} });
      expect(result.ok && result.facts.block).toBe('checks-failing');
    });

    it('squash-merges the shown head with the body on stdin and reads the squash commit back', async () => {
      pr.checks = [checkRun('build', 'SUCCESS', true)];
      const { settled, markInFlight, outcome } = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      expect(outcome).toBe('returned');
      expect(settled).toEqual([{ state: 'done', fields: { mergeCommitOid: SQUASH } }]);
      expect(markInFlight).toHaveBeenCalledTimes(1);
      const [merge] = merges();
      expect(merge.args).toEqual(['pr', 'merge', '1980', '--repo', 'github.com/octo/repo', '--squash',
        `--match-head-commit=${HEAD}`, '--subject=-starts with a dash (#1980)', '--body-file', '-']);
      expect(merge.input).toBe(mergeBody().body);
      expect(merge.args.join(' ')).not.toMatch(/--admin|--auto|--force|--delete-branch/);
    });

    it('refuses a head that moved, before anything runs', async () => {
      pr.checks = [];
      pr.headRefOid = MOVED;
      const { settled, markInFlight } = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      expect(settled).toEqual([{ state: 'refused', error: 'stale', fields: { headRefOid: MOVED } }]);
      expect(markInFlight).not.toHaveBeenCalled();
      expect(merges()).toHaveLength(0);
    });

    it.each([
      [{ state: 'CLOSED' }, 'not-open'],
      [{ isDraft: true }, 'draft'],
      [{ mergeable: 'CONFLICTING' }, 'conflicts'],
      [{ checks: [checkRun('build', 'FAILURE', true)] }, 'checks-failing'],
      [{ checks: [checkRun('build', null, true)] }, 'checks-pending'],
      [{ mergeStateStatus: 'BEHIND' }, 'behind'],
      [{ mergeStateStatus: 'BLOCKED' }, 'blocked'],
      [{ mergeable: 'UNKNOWN' }, 'unknown'],
    ] as Array<[Partial<FakePr>, string]>)('refuses a blocked merge (%o → %s)', async (change, reason) => {
      pr = { ...pr, checks: [], ...change };
      const preview = await handlers().merge.preview!(await session('pr.merge'));
      expect(preview.ok && preview.facts.block).toBe(reason);
      const { settled } = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      expect(settled).toEqual([{ state: 'refused', error: 'blocked', fields: { reason } }]);
      expect(merges()).toHaveLength(0);
    });

    it('shows squash disabled on the sheet and refuses to merge', async () => {
      pr.checks = [];
      squashAllowed = false;
      const preview = await handlers().merge.preview!(await session('pr.merge'));
      expect(preview.ok && preview.facts.squashAllowed).toBe(false);
      const { settled } = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      expect(settled).toEqual([{ state: 'refused', error: 'squash-disabled' }]);
      expect(merges()).toHaveLength(0);
    });

    it('reads a rate-limited merge back instead of refusing it, and holds further calls', async () => {
      pr.checks = [];
      onMerge = async () => fail('HTTP 429: API rate limit exceeded for user');
      const h = handlers();
      const limited = await execute(h.merge.execute, 'pr.merge', mergeBody());
      // It may have reached GitHub: the PR still reads open, so the outcome stays uncertain.
      expect(limited).toMatchObject({ outcome: 'threw', settled: [] });
      expect(calls.at(-1)!.args).toContain('graphql');
      const before = calls.length;
      expect(await h.merge.preview!(await session('pr.merge'))).toEqual({ ok: false, body: { error: 'rate-limited', retryAt: now + 60_000 } });
      expect(calls).toHaveLength(before);
    });

    it('runs one merge per PR at a time', async () => {
      pr.checks = [];
      let release!: () => void;
      onMerge = () => new Promise((resolve) => {
        release = () => { pr = { ...pr, state: 'MERGED', mergeCommit: SQUASH }; resolve({ ok: true, stdout: '' }); };
      });
      const h = handlers();
      const first = execute(h.merge.execute, 'pr.merge', mergeBody());
      await vi.waitFor(() => expect(merges()).toHaveLength(1));
      const second = await execute(h.merge.execute, 'pr.merge', mergeBody({ requestId: '0d6b1c1e-1111-4222-8333-444455559999' }));
      expect(second.settled).toEqual([{ state: 'refused', error: 'merge-in-flight' }]);
      expect(await h.merge.preview!(await session('pr.merge'))).toEqual({ ok: false, body: { error: 'merge-in-flight' } });
      release();
      expect((await first).settled).toEqual([{ state: 'done', fields: { mergeCommitOid: SQUASH } }]);
      expect(merges()).toHaveLength(1);
      // The lock is gone once the first finished.
      expect((await h.merge.preview!(await session('pr.merge'))).ok).toBe(true);
    });

    it('leaves an unanswered merge uncertain, and settles one that landed anyway', async () => {
      pr.checks = [];
      onMerge = async () => fail('Post "https://api.github.com/graphql": read: connection reset by peer');
      const lost = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      // A rejection after markInFlight: the routes settle the receipt `uncertain`.
      expect(lost).toMatchObject({ outcome: 'threw', settled: [] });
      expect(lost.markInFlight).toHaveBeenCalled();
      onMerge = async () => {
        pr = { ...pr, state: 'MERGED', mergeCommit: SQUASH };
        return fail('Post "https://api.github.com/graphql": context deadline exceeded');
      };
      const landed = await execute(handlers().merge.execute, 'pr.merge', mergeBody());
      expect(landed.settled).toEqual([{ state: 'done', fields: { mergeCommitOid: SQUASH } }]);
    });

    it('never refuses a merge once gh ran: a GitHub refusal with the PR still open stays uncertain', async () => {
      pr.checks = [];
      onMerge = async () => fail('GraphQL: Pull request is not mergeable (mergePullRequest)');
      expect(await execute(handlers().merge.execute, 'pr.merge', mergeBody())).toMatchObject({ outcome: 'threw', settled: [] });
    });

    it('reads a merge gh reported as done again until the squash commit shows', async () => {
      pr.checks = [];
      let reads = 0;
      const slow: PrGhRunner = async (args, opts) => {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        // The first two read-backs still show the PR open.
        if (pr.state === 'MERGED' && query && ++reads <= 2) return gh(args, opts).then((r) => (r.ok ? { ok: true, stdout: r.stdout.replace('"MERGED"', '"OPEN"') } : r));
        return gh(args, opts);
      };
      const sleeps: number[] = [];
      const h = createPhoneGitPrHandlers({ gh: slow, git: createGitRunner(), sleep: async (ms) => { sleeps.push(ms); } });
      expect((await execute(h.merge.execute, 'pr.merge', mergeBody())).settled).toEqual([{ state: 'done', fields: { mergeCommitOid: SQUASH } }]);
      expect(sleeps).toEqual([1_000, 2_000]);
      reads = -10;
      pr = { ...pr, state: 'OPEN', mergeCommit: null };
      expect(await execute(h.merge.execute, 'pr.merge', mergeBody())).toMatchObject({ outcome: 'threw', settled: [] });
    });

    it('refuses a merge that never reached GitHub', async () => {
      pr.checks = [];
      const h = createPhoneGitPrHandlers({
        gh: async (args, opts) => (args[1] === 'merge' ? { ok: false, spawned: false, stdout: '', stderr: '' } : gh(args, opts)),
        git: createGitRunner(),
      });
      expect((await execute(h.merge.execute, 'pr.merge', mergeBody())).settled).toEqual([{ state: 'refused', error: 'gh-unavailable' }]);
    });

    it('answers pr-not-found and refuses a non-GitHub origin without calling gh', async () => {
      const h = createPhoneGitPrHandlers({
        gh: async () => fail('GraphQL: Could not resolve to a PullRequest with the number of 1980. (repository.pullRequest)'),
        git: createGitRunner(),
      });
      expect(await h.merge.preview!(await session('pr.merge'))).toEqual({ ok: false, body: { error: 'pr-not-found' } });
      git('remote', 'set-url', 'origin', 'https://example.invalid/octo/repo.git');
      expect(await handlers().merge.preview!(await session('pr.merge'))).toEqual({ ok: false, body: { error: 'remote-unsupported' } });
      expect(calls).toHaveLength(0);
    });
  });

  describe('pr.create', () => {
    it('opens a PR for the pushed branch against the default branch', async () => {
      const { settled, markInFlight } = await execute(handlers().create.execute, 'pr.create', createBody({ draft: true }));
      expect(settled).toEqual([{ state: 'done', fields: { number: 1981, url: 'https://github.com/octo/repo/pull/1981' } }]);
      expect(markInFlight).toHaveBeenCalledTimes(1);
      const post = calls.find((c) => c.args.includes('POST'))!;
      expect(post.args).toEqual(['api', '--hostname', 'github.com', '-X', 'POST', 'repos/octo/repo/pulls', '--input', '-']);
      expect(JSON.parse(post.input!)).toEqual({ title: 'Add the thing', body: 'Why', head: 'feat/x', base: 'main', draft: true });
    });

    it('opens the PR from the upstream branch and against the base asked for', async () => {
      git('config', 'branch.feat/x.remote', 'origin');
      git('config', 'branch.feat/x.merge', 'refs/heads/remote-name');
      const { settled } = await execute(handlers().create.execute, 'pr.create', createBody({ base: 'release' }));
      expect(settled[0]).toMatchObject({ state: 'done' });
      expect(calls[0].args).toEqual(expect.arrayContaining(['headQ=refs/heads/remote-name', 'baseQ=refs/heads/release', 'hasBase=true']));
      // Open PRs are looked up by the origin owner's head only.
      expect(calls[1].args).toEqual(['api', '--hostname', 'github.com', '-X', 'GET', 'repos/octo/repo/pulls',
        '-f', 'head=octo:remote-name', '-f', 'state=open', '-f', 'per_page=100']);
      expect(JSON.parse(calls.find((c) => c.args.includes('POST'))!.input!)).toMatchObject({ head: 'remote-name', base: 'release', draft: false });
    });

    it('refuses an upstream on another remote', async () => {
      git('remote', 'add', 'fork', 'https://github.com/someone/repo.git');
      git('config', 'branch.feat/x.remote', 'fork');
      git('config', 'branch.feat/x.merge', 'refs/heads/feat/x');
      const { settled } = await execute(handlers().create.execute, 'pr.create', createBody());
      expect(settled).toEqual([{ state: 'refused', error: 'remote-unsupported' }]);
      expect(calls).toHaveLength(0);
    });

    it.each([
      ['not-pushed', () => { remoteHead = MOVED; }, undefined],
      ['not-pushed', () => { remoteHead = null; }, undefined],
      ['pr-exists', () => {
        openPrs = [restPr(7, { repo: 'someone/repo' }), restPr(1975, { repo: 'Octo/Repo' })];
      }, { number: 1975 }],
      ['invalid-base', () => { baseExists = false; }, undefined],
      ['no-commits-ahead', () => { aheadBy = 0; }, undefined],
    ] as Array<[string, () => void, Record<string, unknown> | undefined]>)('refuses %s before creating anything', async (error, arrange, fields) => {
      arrange();
      const { settled, markInFlight } = await execute(handlers().create.execute, 'pr.create', createBody(error === 'invalid-base' ? { base: 'gone' } : {}));
      expect(settled).toEqual([{ state: 'refused', error, ...(fields ? { fields } : {}) }]);
      expect(markInFlight).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args.includes('POST'))).toBe(false);
    });

    it('refuses a detached head', async () => {
      git('checkout', '-q', '--detach');
      const { settled } = await execute(handlers().create.execute, 'pr.create', createBody());
      expect(settled).toEqual([{ state: 'refused', error: 'detached-head' }]);
    });

    const TIMEOUT = 'Post "https://api.github.com/repos/octo/repo/pulls": net/http: timeout awaiting response headers';
    it.each([
      ['a timeout', TIMEOUT],
      ['a rate limit', 'HTTP 403: API rate limit exceeded for user ID 1.'],
      ['a refusal', 'gh: Validation Failed (HTTP 422)'],
    ])('settles a create after %s only from the PR it left behind', async (_case, stderr) => {
      onCreate = async () => {
        openPrs = [restPr(1982)];
        return fail(stderr);
      };
      const { settled } = await execute(handlers().create.execute, 'pr.create', createBody());
      expect(settled).toEqual([{ state: 'done', fields: { number: 1982, url: 'https://github.com/octo/repo/pull/1982' } }]);
    });

    it.each([
      ['no PR', () => []],
      ['another title', () => [restPr(1982, { title: 'Something else' })]],
      ['another base', () => [restPr(1982, { base: 'release' })]],
      ['another draft state', () => [restPr(1982, { draft: true })]],
      ['an older PR', () => [restPr(1982, { createdAt: now - 10 * 60_000 })]],
    ])('leaves a create uncertain when the read-back shows %s', async (_case, prs) => {
      onCreate = async () => {
        openPrs = prs();
        return fail('gh: Validation Failed (HTTP 422): base is invalid');
      };
      const result = await execute(handlers().create.execute, 'pr.create', createBody());
      expect(result).toMatchObject({ outcome: 'threw', settled: [] });
      expect(result.markInFlight).toHaveBeenCalled();
    });
  });
});
