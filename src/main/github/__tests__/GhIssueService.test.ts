// GhIssueService: the REST list path per filter, explicit repo on every
// read, gh env, TTL cache, single-flight and the rate-limit breaker (exec
// mocked, as in GhPrService.test).
import { describe, it, expect, vi } from 'vitest';
import { GhIssueService, ghIssueEnv, issueListPath, isRateLimitError, mapRestIssue, mapGhIssueDetail } from '../GhIssueService';
import { getExecEnv } from '../../../shared/execEnv';
import type { IssueFilter } from '../../../shared/issueSurface';

const KEY = 'github.com/o/r';
const LIST = JSON.stringify([
  {
    number: 7,
    title: 'Crash on launch',
    state: 'open',
    user: { login: 'alice' },
    labels: [{ name: 'bug' }, { name: '' }],
    assignees: [{ login: 'bob' }],
    updated_at: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/O/R/issues/7',
    comments: 3,
  },
  { number: 8, title: 'a PR', html_url: 'https://github.com/O/R/pull/8', pull_request: { url: 'x' } },
  { title: 'malformed' },
]);
/** The fake gh: the login for `api user`, else the list. */
const answer = (args: string[]) => (args.includes('user') ? 'me\n' : LIST);

type Opts = { env: NodeJS.ProcessEnv };

function makeService(handler: (args: string[]) => string | Error | Promise<string>, nowRef = { t: 1_000_000 }) {
  const calls: Array<{ args: string[]; opts: Opts }> = [];
  const exec = vi.fn(async (_cmd: string, args: string[], opts: Opts) => {
    calls.push({ args, opts });
    const r = await handler(args);
    if (r instanceof Error) throw r;
    return { stdout: r };
  });
  const svc = new GhIssueService(() => nowRef.t, exec as never);
  return { svc, calls, nowRef };
}

const rateLimitErr = () => Object.assign(new Error('Command failed: gh issue list'), {
  stderr: 'GraphQL: API rate limit exceeded for user ID 1.',
});

describe('issue mapping', () => {
  it('maps a REST item and drops pull requests and malformed ones', () => {
    const arr = JSON.parse(LIST);
    expect(mapRestIssue(arr[0])).toEqual({
      number: 7,
      title: 'Crash on launch',
      state: 'open',
      author: 'alice',
      labels: [{ name: 'bug' }],
      assignees: ['bob'],
      updatedAt: '2026-10-01T00:00:00Z',
      url: 'https://github.com/O/R/issues/7',
      comments: 3,
    });
    expect(mapRestIssue(arr[1])).toBeNull();
    expect(mapRestIssue(arr[2])).toBeNull();
  });

  it('maps a detail: comments oldest first, HTML comments stripped', () => {
    const d = mapGhIssueDetail({
      number: 7,
      url: 'u',
      state: 'CLOSED',
      stateReason: 'completed',
      body: '<!-- template -->Steps',
      comments: [
        { author: { login: 'b' }, body: 'second', createdAt: '2026-10-02T00:00:00Z' },
        { author: { login: 'a' }, body: 'first', createdAt: '2026-10-01T00:00:00Z' },
      ],
    })!;
    expect(d.state).toBe('closed');
    expect(d.stateReason).toBe('COMPLETED');
    expect(d.body).toBe('Steps');
    expect(d.comments.map((c) => c.body)).toEqual(['first', 'second']);
  });
});

describe('list path and explicit repo', () => {
  const cases: Array<[IssueFilter, string]> = [
    [{ kind: 'all' }, 'repos/o/r/issues?state=open&per_page=100'],
    [{ kind: 'assigned' }, 'repos/o/r/issues?state=open&per_page=100&assignee=me'],
    [{ kind: 'created' }, 'repos/o/r/issues?state=open&per_page=100&creator=me'],
    [{ kind: 'label', label: 'good first issue' }, 'repos/o/r/issues?state=open&per_page=100&labels=good%20first%20issue'],
  ];
  it.each(cases)('%j', (filter, path) => {
    expect(issueListPath('o', 'r', filter, 'me')).toBe(path);
  });

  it('reads the list from the remote key\'s host and repo, with the signed-in login for assigned', async () => {
    const { svc, calls } = makeService(answer);
    await svc.listIssues('/repo', { kind: 'assigned' }, KEY);
    expect(calls[0].args).toEqual(['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
    expect(calls[1].args).toEqual(['api', '--hostname', 'github.com', 'repos/o/r/issues?state=open&per_page=100&assignee=me']);
    // The login is cached.
    await svc.listIssues('/repo', { kind: 'created' }, KEY);
    expect(calls).toHaveLength(3);
  });

  it('names the repo on a detail read, and refuses a key that is not host/owner/repo', async () => {
    const { svc, calls } = makeService(() => JSON.stringify({ number: 7, url: 'u', comments: [] }));
    await svc.issueDetail('/repo', 7, 'u1', KEY);
    expect(calls[0].args.slice(0, 5)).toEqual(['issue', 'view', '7', '--repo', KEY]);
    const bad = await svc.listIssues('/repo', { kind: 'all' }, '/some/path');
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('gh env', () => {
  it('is the exec env without GH_REPO, plus the three non-interactive switches', async () => {
    process.env.GH_REPO = 'evil/other';
    let env: NodeJS.ProcessEnv;
    let base: NodeJS.ProcessEnv;
    try {
      env = ghIssueEnv();
      base = getExecEnv();
    } finally {
      delete process.env.GH_REPO;
    }
    expect(env).not.toHaveProperty('GH_REPO');
    const baseKeys = Object.keys(base).filter((k) => k !== 'GH_REPO');
    expect(Object.keys(env).sort()).toEqual([...new Set([...baseKeys, 'GH_PROMPT_DISABLED', 'GH_PAGER', 'NO_COLOR'])].sort());
    expect(env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1', PATH: base.PATH });
    const { svc, calls } = makeService(answer);
    await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls[0].opts.env).toEqual(ghIssueEnv());
  });
});

describe('list cache', () => {
  it('serves the TTL from cache per filter, and force re-reads', async () => {
    const { svc, calls, nowRef } = makeService(answer);
    const a = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(a.ok && a.issues.map((i) => i.number)).toEqual([7]);
    await svc.listIssues('/clone', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(1); // same remote, another clone: one read
    await svc.listIssues('/repo', { kind: 'label', label: 'bug' }, KEY);
    expect(calls).toHaveLength(2); // another filter is another entry
    nowRef.t += 29_000;
    await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(2);
    await svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    expect(calls).toHaveLength(3);
    nowRef.t += 31_000;
    await svc.listIssues('/repo', { kind: 'label', label: 'bug' }, KEY);
    expect(calls).toHaveLength(4);
  });

  it('shares one in-flight read (single-flight), forced or not', async () => {
    let release!: (v: string) => void;
    const { svc, calls } = makeService(() => new Promise<string>((r) => { release = r; }));
    const p1 = svc.listIssues('/repo', { kind: 'all' }, KEY);
    const p2 = svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    await Promise.resolve();
    release(LIST);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1);
    expect(r1).toBe(r2);
  });

  it('single-flights a detail and re-reads it only when updatedAt moves', async () => {
    let release!: (v: string) => void;
    const { svc, calls } = makeService(() => new Promise<string>((r) => { release = r; }));
    const p1 = svc.issueDetail('/repo', 7, 'u1', KEY);
    const p2 = svc.issueDetail('/repo', 7, 'u1', KEY);
    await Promise.resolve();
    release(JSON.stringify({ number: 7, url: 'u', body: 'b', comments: [] }));
    await Promise.all([p1, p2]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 3)).toEqual(['issue', 'view', '7']);
    await svc.issueDetail('/repo', 7, 'u1', KEY);
    expect(calls).toHaveLength(1);
    const p3 = svc.issueDetail('/repo', 7, 'u2', KEY);
    await Promise.resolve();
    release(JSON.stringify({ number: 7, url: 'u', body: 'b2', comments: [] }));
    const r3 = await p3;
    expect(calls).toHaveLength(2);
    expect(r3.ok && r3.detail.body).toBe('b2');
  });
});

describe('rate-limit breaker', () => {
  it('trips on a rate-limit answer, makes no gh call while open, and backs off further each time', async () => {
    let limited = true;
    const { svc, calls, nowRef } = makeService((args) => (limited ? rateLimitErr() : answer(args)));
    const r1 = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(r1).toEqual({ ok: false, code: 'rate-limited', message: 'GitHub rate limit', retryAt: nowRef.t + 60_000 });
    // Open: no list, no detail, not even forced.
    await svc.listIssues('/repo', { kind: 'created' }, KEY, true);
    const d = await svc.issueDetail('/repo', 7, 'u', KEY);
    expect(d.ok).toBe(false);
    expect(calls).toHaveLength(1);
    // Retry time passes; still limited → twice the wait.
    nowRef.t += 60_000;
    const r2 = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(2);
    expect(!r2.ok && r2.code === 'rate-limited' && r2.retryAt).toBe(nowRef.t + 120_000);
    // Then a success closes it.
    limited = false;
    nowRef.t += 120_000;
    const r3 = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(r3.ok).toBe(true);
    expect(svc.retryAt('github.com')).toBeNull();
  });

  it('is per host', async () => {
    const { svc, calls } = makeService((args) => (args.some((a) => a.includes('creator=')) ? rateLimitErr() : answer(args)));
    await svc.listIssues('/repo', { kind: 'created' }, KEY);
    const other = await svc.listIssues('/ghe', { kind: 'all' }, 'acme.github.com/o/r');
    expect(other.ok).toBe(true);
    expect(calls).toHaveLength(3); // login, the limited list, the other host's list
  });

  it('serves a fresh cached list while the breaker is open', async () => {
    const { svc, calls } = makeService((args) => (args.some((a) => a.includes('creator=')) ? rateLimitErr() : answer(args)));
    const fresh = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    await svc.listIssues('/repo', { kind: 'created' }, KEY); // trips github.com
    expect(svc.retryAt('github.com')).not.toBeNull();
    expect(await svc.listIssues('/repo', { kind: 'all' }, KEY)).toBe(fresh);
    const forced = await svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    expect(!forced.ok && forced.code).toBe('rate-limited');
    expect(calls).toHaveLength(3);
  });

  it('a 403 without "rate limit" is an error, not a rate limit', async () => {
    const sso = Object.assign(new Error('failed'), { stderr: 'HTTP 403: Resource protected by organization SAML enforcement.' });
    expect(isRateLimitError(sso)).toBe(false);
    expect(isRateLimitError(Object.assign(new Error('x'), { stderr: 'HTTP 429: Too Many Requests' }))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { stderr: 'HTTP 403: You have exceeded a secondary rate limit.' }))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }))).toBe(true);
    // The message alone (it holds the argv) never counts.
    expect(isRateLimitError(new Error('Command failed: gh api … rate limit exceeded'))).toBe(false);
    const { svc, calls } = makeService(() => sso);
    const r = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(!r.ok && r.code).toBe('error');
    await svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    expect(calls).toHaveLength(2);
  });

  it('a label named "rate limit" with a plain 403 does not trip the breaker', async () => {
    const filter: IssueFilter = { kind: 'label', label: 'rate limit' };
    const err = Object.assign(new Error(`Command failed: gh api --hostname github.com ${issueListPath('o', 'r', filter)} rate limit`), {
      stderr: 'gh: Resource protected by organization SAML enforcement. (HTTP 403)',
    });
    const { svc, calls } = makeService(() => err);
    const r = await svc.listIssues('/repo', filter, KEY);
    expect(!r.ok && r.code).toBe('error');
    expect(svc.retryAt('github.com')).toBeNull();
    await svc.listIssues('/repo', filter, KEY, true);
    expect(calls).toHaveLength(2);
  });
});
