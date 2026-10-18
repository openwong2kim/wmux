// GlabIssueService: the project named on every read, the REST list path per
// filter, the mapping, and the list/detail caches (exec mocked, as in
// GhIssueService.test).
import { describe, it, expect, vi } from 'vitest';
import { GlabIssueService, glabIssueListPath, glabProjectOfKey, mapGlabIssue, mapGlabIssueDetail } from '../GlabIssueService';
import type { IssueFilter } from '../../../shared/issueSurface';

const KEY = 'gitlab.example.com/group/sub/proj';
const PROJECT = 'projects/group%2Fsub%2Fproj/issues';
const ISSUE = {
  iid: 7,
  title: 'Crash on launch',
  state: 'opened',
  description: 'Steps <!-- bot marker --> here',
  author: { username: 'alice' },
  labels: ['bug', ''],
  assignees: [{ username: 'bob' }],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  closed_at: null,
  web_url: 'https://gitlab.example.com/group/sub/proj/-/issues/7',
  user_notes_count: 2,
};
const NOTES = [
  { id: 12, body: 'second', author: { username: 'carol' }, created_at: '2026-10-02T00:00:00Z' },
  { id: 11, body: 'first', author: { username: 'bob' }, created_at: '2026-10-01T12:00:00Z' },
  { id: 13, system: true, body: 'changed the description', created_at: '2026-10-01T13:00:00Z' },
];

function makeService(handler: (path: string) => unknown, nowRef = { t: 1_000_000 }) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    calls.push(args);
    const r = handler(args[3]);
    if (r instanceof Error) throw r;
    return { stdout: JSON.stringify(r) };
  });
  return { svc: new GlabIssueService(() => nowRef.t, exec as never), calls, nowRef };
}

describe('project path', () => {
  it('splits host from a nested group path; refuses a key with no project', () => {
    expect(glabProjectOfKey(KEY)).toEqual({ host: 'gitlab.example.com', path: 'group/sub/proj' });
    expect(glabProjectOfKey('gitlab.com/o')).toBeNull();
    expect(glabProjectOfKey('gitlab.com/o/../r')).toBeNull();
    expect(glabProjectOfKey('gitlab.com/o/r?x')).toBeNull();
  });

  const cases: Array<[IssueFilter, string]> = [
    [{ kind: 'all' }, `${PROJECT}?state=opened&per_page=100&scope=all`],
    [{ kind: 'assigned' }, `${PROJECT}?state=opened&per_page=100&scope=assigned_to_me`],
    [{ kind: 'created' }, `${PROJECT}?state=opened&per_page=100&scope=created_by_me`],
    [{ kind: 'label', label: 'good first issue' }, `${PROJECT}?state=opened&per_page=100&scope=all&labels=good%20first%20issue`],
  ];
  it.each(cases)('%j', (filter, path) => {
    expect(glabIssueListPath('group/sub/proj', filter)).toBe(path);
  });
});

describe('mapping', () => {
  it('maps a list item; one without an iid or URL is dropped', () => {
    expect(mapGlabIssue(ISSUE)).toEqual({
      number: 7,
      title: 'Crash on launch',
      state: 'open',
      author: 'alice',
      labels: [{ name: 'bug' }],
      assignees: ['bob'],
      updatedAt: '2026-10-02T00:00:00Z',
      url: ISSUE.web_url,
      comments: 2,
    });
    expect(mapGlabIssue({ title: 'malformed' })).toBeNull();
  });

  it('maps a detail: system notes left out, comments oldest first with note anchors', () => {
    const d = mapGlabIssueDetail({ ...ISSUE, state: 'closed', closed_at: '2026-10-03T00:00:00Z' }, NOTES);
    expect(d?.state).toBe('closed');
    expect(d?.closedAt).toBe('2026-10-03T00:00:00Z');
    expect(d?.body).toBe('Steps  here');
    expect(d?.comments.map((c) => [c.author, c.body, c.url])).toEqual([
      ['bob', 'first', `${ISSUE.web_url}#note_11`],
      ['carol', 'second', `${ISSUE.web_url}#note_12`],
    ]);
  });
});

describe('service', () => {
  it('names the host and project on every read, never glab\'s :id', async () => {
    const { svc, calls } = makeService((p) => (p.endsWith('/notes?activity_filter=only_comments&sort=asc&order_by=created_at&per_page=100') ? NOTES : p.includes('?') ? [ISSUE] : ISSUE));
    const list = await svc.listIssues('/repo', { kind: 'assigned' }, KEY);
    expect(list).toMatchObject({ ok: true, issues: [{ number: 7 }] });
    const detail = await svc.issueDetail('/repo', 7, ISSUE.updated_at, KEY);
    expect(detail).toMatchObject({ ok: true, detail: { number: 7, comments: [{ body: 'first' }, { body: 'second' }] } });
    expect(calls.map((a) => a.slice(0, 3))).toEqual(Array(3).fill(['api', '--hostname', 'gitlab.example.com']));
    expect(calls.map((a) => a[3])).toEqual([
      `${PROJECT}?state=opened&per_page=100&scope=assigned_to_me`,
      `${PROJECT}/7`,
      `${PROJECT}/7/notes?activity_filter=only_comments&sort=asc&order_by=created_at&per_page=100`,
    ]);
    expect(calls.flat().some((a) => a.includes(':id'))).toBe(false);
  });

  it('serves the list within its TTL and shares a read in flight; refresh and expiry read again', async () => {
    const { svc, calls, nowRef } = makeService(() => [ISSUE]);
    await Promise.all([svc.listIssues('/repo', { kind: 'all' }, KEY), svc.listIssues('/other-clone', { kind: 'all' }, KEY)]);
    expect(calls).toHaveLength(1);
    await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(1);
    await svc.listIssues('/repo', { kind: 'all' }, KEY, true);
    expect(calls).toHaveLength(2);
    nowRef.t += 30_000;
    await svc.listIssues('/repo', { kind: 'all' }, KEY);
    expect(calls).toHaveLength(3);
  });

  it('re-reads a detail only when updatedAt moved; a glab failure is an error, not cached', async () => {
    let fail = false;
    const { svc, calls } = makeService((p) => (fail ? Object.assign(new Error('x'), { stderr: '404 Not Found' }) : p.endsWith('per_page=100') ? NOTES : ISSUE));
    await svc.issueDetail('/repo', 7, 'u1', KEY);
    await svc.issueDetail('/repo', 7, 'u1', KEY);
    expect(calls).toHaveLength(2);
    fail = true;
    expect(await svc.issueDetail('/repo', 7, 'u2', KEY)).toEqual({ ok: false, code: 'error', message: '404 Not Found' });
    expect(await svc.listIssues('/repo', { kind: 'all' }, KEY)).toEqual({ ok: false, code: 'error', message: '404 Not Found' });
    expect(await svc.issueDetail('/repo', 7, 'u1', KEY)).toMatchObject({ ok: true });
  });

  it('a detail asked for a newer version does not join a read of the older one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let title = 'old';
    const calls: string[] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args[3]);
      const t = title;
      if (calls.length <= 2) await gate;
      return { stdout: JSON.stringify(args[3].includes('/notes') ? [] : { ...ISSUE, title: t }) };
    });
    const svc = new GlabIssueService(() => 0, exec as never);
    const older = svc.issueDetail('/repo', 7, 'u1', KEY);
    title = 'new';
    const newer = await svc.issueDetail('/repo', 7, 'u2', KEY);
    expect(newer).toMatchObject({ ok: true, detail: { title: 'new' } });
    release();
    expect(await older).toMatchObject({ ok: true, detail: { title: 'old' } });
    expect(calls).toHaveLength(4);
  });
});
