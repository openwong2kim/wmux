// GhPrReviewService: reviewing, merging and reading CI for a PR (gh mocked).
// Every write is tied to the head the person saw; a merge is refused while it
// cannot run; checks survive gh's non-zero exits; logs come back as a capped
// plain-text tail; reads share the per-host rate-limit breaker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GhPrReviewService, capPrDiff, mapRollup, mapThreads, pathFromHeader } from '../GhPrReviewService';
import { GhRateBreaker } from '../ghRateBreaker';
import { parseCommentRequest, parseMergeRequest, parseReviewRequest, prNumberOn } from '../../ipc/handlers/prReview.handler';
import { DIFF_FILE_CAP_BYTES, DIFF_TOTAL_CAP_BYTES } from '../../../shared/diffParse';
import { LOG_TAIL_MAX_LINES } from '../../../shared/prReview';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

const KEY = 'github.com/Acme/Widgets';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

type Call = { args: string[]; env: NodeJS.ProcessEnv; timeout: number };

const ROLLUP = [
  { __typename: 'CheckRun', name: 'validate', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/Acme/Widgets/actions/runs/11/job/22', startedAt: 's', completedAt: 'c' },
  { __typename: 'StatusContext', context: 'review', state: 'SUCCESS', targetUrl: 'https://coderabbit.ai/x' },
];
function headJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    number: 7, title: 'feat: x', url: 'https://github.com/Acme/Widgets/pull/7', state: 'OPEN', isDraft: false,
    headRefOid: SHA, headRefName: 'feat', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: ROLLUP, ...over,
  });
}

function make(handler: (args: string[]) => string | Error, nowRef = { t: 1_000 }) {
  const calls: Call[] = [];
  const exec = vi.fn(async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number }) => {
    calls.push({ args, env: opts.env, timeout: opts.timeout });
    const r = handler(args);
    if (r instanceof Error) throw r;
    return { stdout: r };
  });
  const svc = new GhPrReviewService(() => nowRef.t, exec as never, new GhRateBreaker(() => nowRef.t));
  return { svc, calls, nowRef, exec };
}
const gh = (calls: Call[], verb: string, sub?: string) => calls.filter((c) => c.args[0] === verb && (sub === undefined || c.args[1] === sub));
const errWith = (props: Record<string, unknown>) => Object.assign(new Error('gh failed'), props);

let savedRepo: string | undefined;
beforeEach(() => { savedRepo = process.env.GH_REPO; process.env.GH_REPO = 'evil/other'; });
afterEach(() => { if (savedRepo === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = savedRepo; });

describe('checks', () => {
  it('reads the head, mergeability and the head commit\'s checks in one call, naming the repo, without GH_REPO', async () => {
    const { svc, calls } = make(() => headJson());
    const res = await svc.checks('/r', KEY, 7);
    expect(res).toMatchObject({ ok: true, value: { head: { headRefOid: SHA, mergeStateStatus: 'CLEAN' } } });
    if (!res.ok) throw new Error();
    expect(res.value.checks[0]).toMatchObject({ name: 'validate', workflow: 'CI', bucket: 'pass', runId: '11', jobId: '22' });
    expect(res.value.checks[1]).toMatchObject({ name: 'review', bucket: 'pass' });
    expect(res.value.checks[1].runId).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['pr', 'view', '7', '--repo', KEY, '--json', expect.stringContaining('statusCheckRollup')]);
    expect(calls[0].env.GH_REPO).toBeUndefined();
    expect(calls[0].env.GH_PROMPT_DISABLED).toBe('1');
  });

  it('buckets check runs and commit statuses', () => {
    const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun', name: 'n', status, conclusion });
    expect(mapRollup([
      run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'NEUTRAL'), run('COMPLETED', 'SKIPPED'), run('COMPLETED', 'CANCELLED'),
      run('COMPLETED', 'FAILURE'), run('COMPLETED', 'TIMED_OUT'), run('IN_PROGRESS'), run('QUEUED'),
      { __typename: 'StatusContext', context: 's', state: 'ERROR' }, { __typename: 'StatusContext', context: 's', state: 'PENDING' },
    ]).map((c) => c.bucket)).toEqual(['pass', 'pass', 'skipping', 'cancel', 'fail', 'fail', 'pending', 'pending', 'fail', 'pending']);
    expect(mapRollup(null)).toEqual([]);
  });

  it('caches briefly with one read in flight, and a forced read goes past the cache', async () => {
    const { svc, calls, nowRef } = make(() => headJson());
    await Promise.all([svc.checks('/r', KEY, 7), svc.checks('/r', KEY, 7)]);
    expect(calls).toHaveLength(1);
    await svc.checks('/r', KEY, 7);
    expect(calls).toHaveLength(1);
    await svc.checks('/r', KEY, 7, true);
    expect(calls).toHaveLength(2);
    nowRef.t += 20_000;
    await svc.checks('/r', KEY, 7);
    expect(calls).toHaveLength(3);
  });

  it('GitHub\'s rate limit trips the breaker: reads wait without calling gh', async () => {
    const { svc, calls } = make(() => errWith({ stderr: 'gh: API rate limit exceeded for user (HTTP 403)' }));
    const res = await svc.checks('/r', KEY, 7);
    expect(res).toMatchObject({ ok: false, code: 'rate-limited' });
    const n = calls.length;
    expect(await svc.threads('/r', KEY, 7, SHA)).toMatchObject({ ok: false, code: 'rate-limited' });
    expect(calls.length).toBe(n);
  });
});

describe('merge', () => {
  const okState = (over: Record<string, unknown> = {}) => (a: string[]) => (a[1] === 'view' ? headJson(over) : '');

  it('decides from one read of head and checks, then squash-merges with the subject, an empty body and the head GitHub must match', async () => {
    const { svc, calls } = make(okState());
    expect(await svc.merge('/r', KEY, 7, { expectHead: SHA, subject: 'feat: x (#7)', body: '' })).toEqual({ ok: true, url: 'https://github.com/Acme/Widgets/pull/7' });
    expect(gh(calls, 'pr', 'view')).toHaveLength(1);
    const merge = gh(calls, 'pr', 'merge')[0].args;
    expect(merge).toEqual(['pr', 'merge', '7', '--repo', KEY, '--squash', '--subject=feat: x (#7)', '--body=', `--match-head-commit=${SHA}`]);
  });

  it('refuses when the head moved since it was shown, without merging', async () => {
    const { svc, calls } = make(okState({ headRefOid: OTHER }));
    expect(await svc.merge('/r', KEY, 7, { expectHead: SHA, subject: 's', body: '' })).toMatchObject({ ok: false, code: 'moved', headRefOid: OTHER });
    expect(gh(calls, 'pr', 'merge')).toHaveLength(0);
  });

  it('refuses with the reason while it cannot merge: conflicts, failing checks', async () => {
    const conflicts = make(okState({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
    expect(await conflicts.svc.merge('/r', KEY, 7, { expectHead: SHA, subject: 's', body: '' })).toMatchObject({ ok: false, code: 'blocked', reason: 'conflicts' });
    expect(gh(conflicts.calls, 'pr', 'merge')).toHaveLength(0);
    const failing = make(okState({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'v', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
    expect(await failing.svc.merge('/r', KEY, 7, { expectHead: SHA, subject: 's', body: '' })).toMatchObject({ ok: false, code: 'blocked', reason: 'checks-failing' });
    expect(gh(failing.calls, 'pr', 'merge')).toHaveLength(0);
  });
});

describe('the diff is the head\'s', () => {
  const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n';

  it('a push during the read discards the diff instead of filing it under the old head', async () => {
    let views = 0;
    const { svc } = make((a) => (a[1] === 'view' ? headJson({ headRefOid: views++ === 0 ? SHA : OTHER }) : DIFF));
    expect(await svc.files('/r', KEY, 7, SHA)).toMatchObject({ ok: false, code: 'error', message: expect.stringContaining('changed while') });
    // Nothing was cached: the next read asks again.
    views = 0;
    const steady = make((a) => (a[1] === 'view' ? headJson() : DIFF));
    expect(await steady.svc.files('/r', KEY, 7, SHA)).toMatchObject({ ok: true, value: { headRefOid: SHA, files: [{ path: 'a.ts' }] } });
    await steady.svc.files('/r', KEY, 7, SHA);
    expect(gh(steady.calls, 'pr', 'diff')).toHaveLength(1);
  });

  it('a pure rename and a binary change keep their paths', () => {
    const rename = 'diff --git a/old/name.ts b/new/name.ts\nsimilarity index 100%\nrename from old/name.ts\nrename to new/name.ts\n';
    const binary = 'diff --git a/img/logo.png b/img/logo.png\nindex 1..2 100644\nBinary files a/img/logo.png and b/img/logo.png differ\n';
    const quoted = 'diff --git "a/docs/\\355\\225\\234.md" "b/docs/\\355\\225\\234.md"\nindex 1..2 100644\nBinary files differ\n';
    const { files } = capPrDiff(rename + binary + quoted);
    expect(files.map((f) => f.path)).toEqual(['new/name.ts', 'img/logo.png', 'docs/한.md']);
    expect(pathFromHeader('not a header')).toBeNull();
  });
});

describe('review writes', () => {
  it('a review names the head it was written for; an approval may have no body', async () => {
    const { svc, calls } = make((a) => (a[1] === 'view' ? headJson() : '{"html_url":"https://github.com/Acme/Widgets/pull/7#pullrequestreview-1"}'));
    expect(await svc.submitReview('/r', KEY, 7, { expectHead: SHA, event: 'APPROVE', body: '' })).toEqual({
      ok: true, url: 'https://github.com/Acme/Widgets/pull/7#pullrequestreview-1',
    });
    const post = gh(calls, 'api').at(-1)!.args;
    expect(post).toEqual(['api', '--hostname', 'github.com', '-X', 'POST', 'repos/Acme/Widgets/pulls/7/reviews', '-f', 'event=APPROVE', '-f', `commit_id=${SHA}`]);
  });

  it('a review on a PR that is no longer open is refused, nothing posted', async () => {
    const { svc, calls } = make((a) => (a[1] === 'view' ? headJson({ state: 'MERGED' }) : '{}'));
    expect(await svc.submitReview('/r', KEY, 7, { expectHead: SHA, event: 'APPROVE', body: '' })).toMatchObject({ ok: false, code: 'blocked', reason: 'not-open' });
    expect(gh(calls, 'api')).toHaveLength(0);
  });

  it('a review or a line comment on a head that moved is refused, nothing posted', async () => {
    const { svc, calls } = make((a) => (a[1] === 'view' ? headJson({ headRefOid: OTHER }) : '{}'));
    expect(await svc.submitReview('/r', KEY, 7, { expectHead: SHA, event: 'COMMENT', body: 'hi' })).toMatchObject({ ok: false, code: 'moved' });
    expect(await svc.comment('/r', KEY, 7, { expectHead: SHA, path: 'a.ts', line: 3, side: 'RIGHT', body: 'hi' })).toMatchObject({ ok: false, code: 'moved' });
    expect(gh(calls, 'api')).toHaveLength(0);
  });

  it('a line comment posts the path, line, side and commit; text is a raw field, never a file or flag', async () => {
    const { svc, calls } = make((a) => (a[1] === 'view' ? headJson() : '{}'));
    await svc.comment('/r', KEY, 7, { expectHead: SHA, path: 'src/a.ts', line: 3, side: 'LEFT', body: '@/etc/passwd --flag' });
    expect(gh(calls, 'api')[0].args).toEqual([
      'api', '--hostname', 'github.com', '-X', 'POST', 'repos/Acme/Widgets/pulls/7/comments',
      '-f', 'body=@/etc/passwd --flag', '-f', `commit_id=${SHA}`, '-f', 'path=src/a.ts', '-F', 'line=3', '-f', 'side=LEFT',
    ]);
    await svc.reply('/r', KEY, 7, 99, 'thanks');
    expect(gh(calls, 'api')[1].args).toEqual(['api', '--hostname', 'github.com', '-X', 'POST', 'repos/Acme/Widgets/pulls/7/comments/99/replies', '-f', 'body=thanks']);
  });
});

describe('runs', () => {
  it('the failed-jobs log comes back ANSI-free and cut to its last lines', async () => {
    const log = Array.from({ length: LOG_TAIL_MAX_LINES + 30 }, (_, i) => `\x1b[31mjob\x1b[0m\tstep ${i}`).join('\n');
    const { svc, calls } = make(() => log);
    const res = await svc.runLog('/r', KEY, '11');
    if (!res.ok) throw new Error(res.message);
    expect(res.value.truncated).toBe(true);
    expect(res.value.text).not.toContain('\x1b');
    expect(res.value.text.split('\n')).toHaveLength(LOG_TAIL_MAX_LINES);
    expect(calls[0].args).toEqual(['run', 'view', '11', '--repo', KEY, '--log-failed']);
  });

  it('a log over the buffer is reported as too large, not read further', async () => {
    const { svc } = make(() => errWith({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded' }));
    expect(await svc.runLog('/r', KEY, '11')).toEqual({ ok: true, value: { runId: '11', text: '', truncated: true, tooLarge: true } });
  });

  it('a rerun asks for the failed jobs of that run only', async () => {
    const { svc, calls } = make(() => '');
    expect(await svc.rerunFailed('/r', KEY, '11')).toEqual({ ok: true });
    expect(calls[0].args).toEqual(['run', 'rerun', '11', '--failed', '--repo', KEY]);
  });
});

describe('threads and files', () => {
  it('maps threads; an outdated one has no line; more than was read is marked', () => {
    const res = mapThreads({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 4, nodes: [
      { id: 't1', isResolved: false, isOutdated: false, path: 'a.ts', line: 4, diffSide: 'RIGHT', subjectType: 'LINE', comments: { totalCount: 1, nodes: [{ databaseId: 5, body: 'hi <!-- bot -->', createdAt: 'd', author: { login: 'me' } }] } },
      { id: 't2', isResolved: true, isOutdated: true, path: 'b.ts', line: 9, diffSide: 'LEFT', subjectType: 'LINE', comments: { totalCount: 1, nodes: [{ databaseId: 6, body: 'x', createdAt: 'd', author: null }] } },
      { id: 't3', isResolved: false, isOutdated: false, path: 'c.ts', line: null, diffSide: 'RIGHT', subjectType: 'FILE', comments: { totalCount: 1, nodes: [{ databaseId: 7, body: 'whole file', createdAt: 'd', author: { login: 'me' } }] } },
    ] } } } } }, SHA);
    expect(res.truncated).toBe(true);
    expect(res.headRefOid).toBe(SHA);
    expect(res.threads[0]).toEqual({ id: 't1', path: 'a.ts', subject: 'line', line: 4, side: 'RIGHT', isResolved: false, isOutdated: false, comments: [{ id: 5, author: 'me', body: 'hi', createdAt: 'd' }] });
    // Outdated as GitHub reports it; its line is kept for where it was.
    expect(res.threads[1]).toMatchObject({ subject: 'line', line: 9, side: 'LEFT', isOutdated: true, comments: [{ author: 'ghost' }] });
    expect(res.threads[2]).toMatchObject({ subject: 'file', line: null, isOutdated: false });
  });

  it('a diff over its caps keeps whole files only and empties a file too big to show', () => {
    const file = (name: string, body: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,1 @@\n-old\n+${body}\n`;
    const big = capPrDiff(file('big.ts', 'x'.repeat(DIFF_FILE_CAP_BYTES + 10)) + file('small.ts', 'y'));
    expect(big.truncated).toBe(true);
    expect(big.files.map((f) => [f.path, f.hunks.length])).toEqual([['big.ts', 0], ['small.ts', 1]]);
    const many = Array.from({ length: 6 }, (_, i) => file(`f${i}.ts`, 'z'.repeat(DIFF_TOTAL_CAP_BYTES / 5))).join('');
    const cut = capPrDiff(many);
    expect(cut.truncated).toBe(true);
    expect(cut.files.length).toBeLessThan(6);
  });
});

describe('what main accepts from the renderer', () => {
  it('a PR is acted on only when its URL is on the checkout\'s own GitHub repo', () => {
    expect(prNumberOn(KEY, 'https://github.com/Acme/Widgets/pull/7')).toBe(7);
    expect(prNumberOn(KEY, 'https://github.com/acme/widgets/pull/7')).toBe(7);
    // A fork's upstream, another repo, another host, not a PR URL: refused.
    expect(prNumberOn(KEY, 'https://github.com/Upstream/Widgets/pull/7')).toBeNull();
    expect(prNumberOn(KEY, 'https://github.com/Acme/Other/pull/7')).toBeNull();
    expect(prNumberOn(KEY, 'https://ghe.example.com/Acme/Widgets/pull/7')).toBeNull();
    expect(prNumberOn(KEY, 'https://github.com/Acme/Widgets/issues/7')).toBeNull();
    expect(prNumberOn(KEY, 7)).toBeNull();
  });

  it('a line comment needs a full head, a repo-relative path, a line, a side and text', () => {
    const ok = { expectHead: SHA, path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'hi' };
    expect(parseCommentRequest(ok)).toEqual(ok);
    expect(parseCommentRequest({ ...ok, path: '../etc/passwd' })).toBeNull();
    expect(parseCommentRequest({ ...ok, path: '/abs' })).toBeNull();
    expect(parseCommentRequest({ ...ok, expectHead: 'abc' })).toBeNull();
    expect(parseCommentRequest({ ...ok, body: '  ' })).toBeNull();
    expect(parseCommentRequest({ ...ok, side: 'BOTH' })).toBeNull();
  });

  it('request changes and comment need a body; a merge subject is one line', () => {
    expect(parseReviewRequest({ expectHead: SHA, event: 'APPROVE', body: '' })).not.toBeNull();
    expect(parseReviewRequest({ expectHead: SHA, event: 'REQUEST_CHANGES', body: '' })).toBeNull();
    expect(parseReviewRequest({ expectHead: SHA, event: 'DISMISS', body: 'x' })).toBeNull();
    expect(parseMergeRequest({ expectHead: SHA, subject: 'feat: x (#7)', body: '' })).toEqual({ expectHead: SHA, subject: 'feat: x (#7)', body: '' });
    expect(parseMergeRequest({ expectHead: SHA, subject: 'a\nb', body: '' })).toBeNull();
    expect(parseMergeRequest({ expectHead: SHA, subject: ' ', body: '' })).toBeNull();
  });
});
