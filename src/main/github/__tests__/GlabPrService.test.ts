// GlabPrService — GitLab REST mapping·per-host gate·TTL·updatedAt cache
// (exec mock, symmetric with GhPrService tests).
import { describe, it, expect, vi } from 'vitest';
import { GlabPrService, mapGlabMrItem, mapGlabNotes } from '../GlabPrService';
import { hostCommandTarget } from '../../git/paneCommand';
import { PR_COMMENT_BODY_CAP } from '../../../shared/prSurface';

type ExecCall = { cmd: string; args: string[] };

function makeService(
  handler: (args: string[]) => { stdout: string } | Error,
  nowRef: { t: number } = { t: 1000 },
) {
  const calls: ExecCall[] = [];
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const r = handler(args);
    if (r instanceof Error) throw r;
    return r;
  });
  const svc = new GlabPrService(() => nowRef.t, exec as never);
  return { svc, calls, nowRef };
}

const MR_LIST_JSON = JSON.stringify([
  {
    iid: 7,
    title: 'feat: company thing',
    state: 'opened',
    draft: false,
    author: { username: 'wykim' },
    source_branch: 'feat/x',
    updated_at: '2026-07-13T01:00:00Z',
    web_url: 'https://gitlab.company.io/team/repo/-/merge_requests/7',
  },
  { iid: 3, title: 'old', state: 'merged', web_url: 'https://g/mr/3' },
  { iid: 2, title: 'wip', state: 'opened', work_in_progress: true, web_url: 'https://g/mr/2' },
  { title: 'malformed — no iid', web_url: 'https://g/x' },
]);

describe('mapGlabMrItem / mapGlabNotes — GitLab REST mapping', () => {
  it('iid→number, source_branch→headRefName, draft/WIP→draft, checks=null (v1 honest absence)', () => {
    const arr = JSON.parse(MR_LIST_JSON) as Parameters<typeof mapGlabMrItem>[0][];
    const a = mapGlabMrItem(arr[0])!;
    expect(a).toMatchObject({
      number: 7,
      state: 'open',
      author: 'wykim',
      headRefName: 'feat/x',
      url: 'https://gitlab.company.io/team/repo/-/merge_requests/7',
      checks: null,
      reviewDecision: '',
    });
    expect(mapGlabMrItem(arr[1])!.state).toBe('merged');
    expect(mapGlabMrItem(arr[2])!.state).toBe('draft');
    expect(mapGlabMrItem(arr[3])).toBeNull();
  });

  it('notes — excludes system notes, chronological sort, HTML comment strip+cap', () => {
    const big = 'x'.repeat(PR_COMMENT_BODY_CAP + 10);
    const out = mapGlabNotes(
      [
        { system: true, body: 'added 1 commit', created_at: '2026-07-13T00:30:00Z' },
        { author: { username: 'b' }, body: '<!-- bot -->second', created_at: '2026-07-13T02:00:00Z' },
        { author: { username: 'a' }, body: 'first', created_at: '2026-07-13T01:00:00Z' },
        { author: { username: 'c' }, body: big, created_at: '2026-07-13T03:00:00Z' },
      ],
      'mr-url',
    );
    expect(out.map((c) => c.author)).toEqual(['a', 'b', 'c']);
    expect(out[1].body).toBe('second');
    expect(out[2].truncated).toBe(true);
    expect(out[0].url).toBe('mr-url');
    expect(out.every((c) => c.kind === 'comment')).toBe(true);
  });
});

describe('GlabPrService — gate (per-host)', () => {
  it('glab ENOENT → cli-missing, no reprobe for process lifetime', async () => {
    const enoent = Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' });
    const { svc, calls } = makeService(() => enoent);
    expect((await svc.gate('D:/r', 'gitlab.company.io')).ok).toBe(false);
    expect((await svc.gate('D:/r', 'gitlab.company.io')).ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('version OK + unauthenticated on that host → unauthenticated includes host name', async () => {
    const { svc, calls } = makeService((args) =>
      args[0] === '--version' ? { stdout: 'glab 1.x' } : new Error('no token'),
    );
    const g = await svc.gate('D:/r', 'gitlab.company.io');
    expect(g).toMatchObject({ ok: false, reason: 'unauthenticated' });
    if (!g.ok) expect(g.message).toContain('gitlab.company.io');
    // auth status checked that host via --hostname.
    const auth = calls.find((c) => c.args[0] === 'auth');
    expect(auth!.args).toContain('--hostname');
    expect(auth!.args).toContain('gitlab.company.io');
  });
});

describe('GlabPrService — list TTL·detail updatedAt cache', () => {
  function dataService(nowRef = { t: 0 }) {
    return makeService((args) => {
      if (args[0] === 'mr' && args[1] === 'list') return { stdout: MR_LIST_JSON };
      if (args[0] === 'api') {
        return {
          stdout: JSON.stringify([
            { author: { username: 'a' }, body: 'note', created_at: 't1' },
            { system: true, body: 'sys', created_at: 't0' },
          ]),
        };
      }
      return { stdout: '' };
    }, nowRef);
  }

  it('re-call within 30s skips exec, refetch after TTL — includes malformed filter', async () => {
    const nowRef = { t: 0 };
    const { svc, calls } = dataService(nowRef);
    const r1 = await svc.listPrs('D:/r');
    expect(r1.ok && r1.prs.length).toBe(3);
    await svc.listPrs('D:/r');
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
    nowRef.t = 31_000;
    await svc.listPrs('D:/r');
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(2);
  });

  it('detail — fetches notes via :id substitution api, updatedAt cache, MR url anchor', async () => {
    const { svc, calls } = dataService();
    await svc.listPrs('D:/r'); // fills urlByIid.
    const d1 = await svc.prDetail('D:/r', 7, 'T1');
    expect(d1.ok && d1.detail.comments.length).toBe(1); // system excluded.
    if (d1.ok) expect(d1.detail.comments[0].url).toContain('/merge_requests/7');
    await svc.prDetail('D:/r', 7, 'T1');
    expect(calls.filter((c) => c.args[0] === 'api').length).toBe(1);
    await svc.prDetail('D:/r', 7, 'T2');
    expect(calls.filter((c) => c.args[0] === 'api').length).toBe(2);
    // api path uses :id substitution + iid.
    const api = calls.find((c) => c.args[0] === 'api')!;
    expect(api.args[1]).toContain('projects/:id/merge_requests/7/notes');
  });

  // Same identity contract as the gh path (PrProvider): the Deck panel calls
  // without a target, the pane poller calls with one — one repo, one entry.
  it('targeted and untargeted calls for one repo share a single cache entry', async () => {
    const { svc, calls } = dataService();
    await svc.listPrs('D:\\repo');
    await svc.listPrs('D:\\repo', false, hostCommandTarget('D:\\repo\\packages\\app'));
    await svc.listPrs('d:/repo/');
    await svc.listPrs('D:/Repo', false, hostCommandTarget('d:\\repo\\'));
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
  });

  it('routes a WSL target through wsl.exe and isolates it per distro', async () => {
    const { svc, calls } = dataService();
    const wsl = (distro: string, sessionId: string, cwd = '/repo') => ({
      sessionId,
      location: { domain: 'wsl' as const, cwd, shell: 'wsl.exe', distro },
      activeContext: { sessionId, active: true as const, distro },
    });
    await svc.listPrs('/repo', false, wsl('Ubuntu', 'pty-u', '/repo/packages/app'));
    await svc.listPrs('/repo', false, wsl('Ubuntu', 'pty-u2', '/repo/packages/other'));
    await svc.listPrs('/repo', false, wsl('Debian', 'pty-d'));
    expect(calls.filter((c) => c.cmd === 'wsl.exe').length).toBe(2);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['-d', 'Ubuntu', '--cd', '/repo/packages/app', '--exec']),
    );
  });

  it('fails soft without invoking wsl.exe for stale pane context', async () => {
    const { svc, calls } = dataService();
    const r = await svc.listPrs('/repo', false, {
      sessionId: 'pty-current',
      location: { domain: 'wsl', cwd: '/repo', shell: 'wsl.exe', distro: 'Ubuntu' },
      activeContext: { sessionId: 'pty-stale', active: true, distro: 'Ubuntu' },
    });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('glab failure stderr demoted fail-soft', async () => {
    const { svc } = makeService(() => Object.assign(new Error('boom'), { stderr: '404 project not found' }));
    const r = await svc.listPrs('D:/r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('404');
  });
});
