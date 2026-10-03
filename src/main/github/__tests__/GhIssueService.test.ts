// GhIssueService: filter args, gh env, TTL cache, single-flight and the
// rate-limit breaker (exec mocked, as in GhPrService.test).
import { describe, it, expect, vi } from 'vitest';
import { GhIssueService, ghIssueEnv, issueFilterArgs, isRateLimitError, mapGhIssue, mapGhIssueDetail } from '../GhIssueService';
import { getExecEnv } from '../../../shared/execEnv';
import type { IssueFilter } from '../../../shared/issueSurface';

const KEY = 'github.com/o/r';
const LIST = JSON.stringify([
  {
    number: 7,
    title: 'Crash on launch',
    state: 'OPEN',
    author: { login: 'alice' },
    labels: [{ name: 'bug' }, { name: '' }],
    assignees: [{ login: 'bob' }],
    updatedAt: '2026-10-01T00:00:00Z',
    url: 'https://github.com/O/R/issues/7',
    comments: 3,
  },
  { title: 'malformed' },
]);

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
  it('maps a list item and drops malformed ones', () => {
    const arr = JSON.parse(LIST);
    expect(mapGhIssue(arr[0])).toEqual({
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
    expect(mapGhIssue(arr[1])).toBeNull();
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

describe('issueFilterArgs', () => {
  const cases: Array<[IssueFilter, string[]]> = [
    [{ kind: 'all' }, []],
    [{ kind: 'assigned' }, ['--assignee', '@me']],
    [{ kind: 'created' }, ['--author', '@me']],
    [{ kind: 'label', label: '-x bug' }, ['--label=-x bug']],
  ];
  it.each(cases)('%j', (filter, args) => {
    expect(issueFilterArgs(filter)).toEqual(args);
  });

  it('passes the filter and the open/json/jq args to gh', async () => {
    const { svc, calls } = makeService(() => LIST);
    await svc.listIssues('/repo', { kind: 'assigned' }, KEY);
    const args = calls[0].args;
    expect(args.slice(0, 2)).toEqual(['issue', 'list']);
    expect(args).toEqual(expect.arrayContaining(['--state', 'open', '--assignee', '@me', '--jq', 'map(.comments |= length)']));
    expect(args[args.indexOf('--json') + 1]).toBe('number,title,state,author,labels,assignees,updatedAt,url,comments');
  });
});

describe('gh env', () => {
  it('is the exec env plus the three non-interactive switches, nothing else', async () => {
    const env = ghIssueEnv();
    const base = getExecEnv();
    expect(Object.keys(env).sort()).toEqual([...new Set([...Object.keys(base), 'GH_PROMPT_DISABLED', 'GH_PAGER', 'NO_COLOR'])].sort());
    expect(env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1', PATH: base.PATH });
    const { svc, calls } = makeService(() => LIST);
    await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls[0].opts.env).toEqual(env);
  });
});

describe('list cache', () => {
  it('serves the TTL from cache per filter, and force re-reads', async () => {
    const { svc, calls, nowRef } = makeService(() => LIST);
    const a = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(a.ok && a.issues.map((i) => i.number)).toEqual([7]);
    await svc.listIssues('/clone', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(1); // same remote, another clone: one read
    await svc.listIssues('/repo', { kind: 'created' }, KEY);
    expect(calls).toHaveLength(2); // another filter is another entry
    nowRef.t += 29_000;
    await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(2);
    await svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    expect(calls).toHaveLength(3);
    nowRef.t += 31_000;
    await svc.listIssues('/repo', { kind: 'created' }, KEY);
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
    const { svc, calls, nowRef } = makeService(() => (limited ? rateLimitErr() : LIST));
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
    const { svc, calls } = makeService((args) => (args.includes('--author') ? rateLimitErr() : LIST));
    await svc.listIssues('/repo', { kind: 'created' }, KEY);
    const other = await svc.listIssues('/ghe', { kind: 'all' }, 'acme.github.com/o/r');
    expect(other.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a 403 without "rate limit" is an error, not a rate limit', async () => {
    const sso = Object.assign(new Error('failed'), { stderr: 'HTTP 403: Resource protected by organization SAML enforcement.' });
    expect(isRateLimitError(sso)).toBe(false);
    expect(isRateLimitError(Object.assign(new Error('x'), { stderr: 'HTTP 429: Too Many Requests' }))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error('x'), { stderr: 'HTTP 403: You have exceeded a secondary rate limit.' }))).toBe(true);
    const { svc, calls } = makeService(() => sso);
    const r = await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(!r.ok && r.code).toBe('error');
    await svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    expect(calls).toHaveLength(2);
  });
});
