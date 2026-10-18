// GlabPrService — GitLab REST 매핑·호스트 단위 게이트·TTL·updatedAt 캐시
// (exec 목킹, GhPrService 테스트와 대칭).
import { describe, it, expect, vi } from 'vitest';
import { GlabPrService, glabProjectPath, mapGlabMrItem, mapGlabNotes, mapGlabPipelineStatus } from '../GlabPrService';
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
  { title: 'malformed — iid 없음', web_url: 'https://g/x' },
]);

describe('mapGlabMrItem / mapGlabNotes — GitLab REST 매핑', () => {
  it('iid→number, source_branch→headRefName, draft/WIP→draft, checks=null(v1 정직 부재)', () => {
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

  it('notes — system 노트 제외, 시간순 정렬, HTML주석 스트립+캡', () => {
    const big = 'x'.repeat(PR_COMMENT_BODY_CAP + 10);
    const out = mapGlabNotes(
      [
        { system: true, body: 'added 1 commit', created_at: '2026-07-13T00:30:00Z' },
        { author: { username: 'b' }, body: '<!-- bot -->둘째', created_at: '2026-07-13T02:00:00Z' },
        { author: { username: 'a' }, body: '첫째', created_at: '2026-07-13T01:00:00Z' },
        { author: { username: 'c' }, body: big, created_at: '2026-07-13T03:00:00Z' },
      ],
      'mr-url',
    );
    expect(out.map((c) => c.author)).toEqual(['a', 'b', 'c']);
    expect(out[1].body).toBe('둘째');
    expect(out[2].truncated).toBe(true);
    expect(out[0].url).toBe('mr-url');
    expect(out.every((c) => c.kind === 'comment')).toBe(true);
  });
});

describe('GlabPrService — 게이트(호스트 단위)', () => {
  it('glab ENOENT → cli-missing, 프로세스 수명 동안 재프로브 없음', async () => {
    const enoent = Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' });
    const { svc, calls } = makeService(() => enoent);
    expect((await svc.gate('D:/r', 'gitlab.company.io')).ok).toBe(false);
    expect((await svc.gate('D:/r', 'gitlab.company.io')).ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  it('버전 OK + 그 호스트 미인증 → unauthenticated에 호스트명 포함 안내', async () => {
    const { svc, calls } = makeService((args) =>
      args[0] === '--version' ? { stdout: 'glab 1.x' } : new Error('no token'),
    );
    const g = await svc.gate('D:/r', 'gitlab.company.io');
    expect(g).toMatchObject({ ok: false, reason: 'unauthenticated' });
    if (!g.ok) expect(g.message).toContain('gitlab.company.io');
    // auth status가 --hostname으로 그 호스트를 검사했는지.
    const auth = calls.find((c) => c.args[0] === 'auth');
    expect(auth!.args).toContain('--hostname');
    expect(auth!.args).toContain('gitlab.company.io');
  });
});

describe('GlabPrService — 목록 TTL·상세 updatedAt 캐시', () => {
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

  it('30s 내 재호출 exec 생략, TTL 후 재fetch — malformed 필터 포함', async () => {
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

  it('상세 — notes를 :id 치환 api로 조회, updatedAt 캐시, MR url 앵커 부착', async () => {
    const { svc, calls } = dataService();
    await svc.listPrs('D:/r'); // urlByIid 채움.
    const d1 = await svc.prDetail('D:/r', 7, 'T1');
    expect(d1.ok && d1.detail.comments.length).toBe(1); // system 제외.
    if (d1.ok) expect(d1.detail.comments[0].url).toContain('/merge_requests/7');
    await svc.prDetail('D:/r', 7, 'T1');
    expect(calls.filter((c) => c.args[0] === 'api').length).toBe(1);
    await svc.prDetail('D:/r', 7, 'T2');
    expect(calls.filter((c) => c.args[0] === 'api').length).toBe(2);
    // api 경로가 :id 치환 + iid를 쓰는지.
    const api = calls.find((c) => c.args[0] === 'api')!;
    expect(api.args[1]).toContain('projects/:id/merge_requests/7/notes');
  });

  it('glab 실패 stderr는 fail-soft로 강등', async () => {
    const { svc } = makeService(() => Object.assign(new Error('boom'), { stderr: '404 project not found' }));
    const r = await svc.listPrs('D:/r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('404');
  });
});

describe('GlabPrService — MR head pipelines', () => {
  const LIST = JSON.stringify([
    { iid: 7, title: 'a', state: 'opened', web_url: 'https://gl/team/sub/repo/-/merge_requests/7', references: { full: 'team/sub/repo!7' } },
    { iid: 8, title: 'b', state: 'opened', web_url: 'https://gl/team/sub/repo/-/merge_requests/8', references: { full: 'team/sub/repo!8' } },
    { iid: 9, title: 'c', state: 'opened', web_url: 'https://gl/team/sub/repo/-/merge_requests/9', references: { full: 'team/sub/repo!9' } },
  ]);
  const GRAPHQL = JSON.stringify({
    data: {
      project: {
        mergeRequests: {
          nodes: [
            { iid: '7', headPipeline: { status: 'SUCCESS' } },
            { iid: '8', headPipeline: { status: 'RUNNING' } },
            { iid: '9', headPipeline: null },
          ],
        },
      },
    },
  });

  it('maps GitLab pipeline statuses to the 3-state rollup', () => {
    expect(mapGlabPipelineStatus('SUCCESS')).toBe('passing');
    expect(mapGlabPipelineStatus('FAILED')).toBe('failing');
    expect(mapGlabPipelineStatus('CANCELED')).toBe('failing');
    expect(mapGlabPipelineStatus('RUNNING')).toBe('pending');
    expect(mapGlabPipelineStatus('MANUAL')).toBe('pending');
    expect(mapGlabPipelineStatus('SKIPPED')).toBeNull();
    expect(mapGlabPipelineStatus(undefined)).toBeNull();
  });

  it("reads the project path from references.full, subgroups included", () => {
    expect(glabProjectPath({ references: { full: 'team/sub/repo!7' } })).toBe('team/sub/repo');
    expect(glabProjectPath({ references: { full: '!7' } })).toBeNull();
    expect(glabProjectPath({ references: { full: 'team/re po!7' } })).toBeNull();
    expect(glabProjectPath({})).toBeNull();
  });

  it('fills checks from one GraphQL call for every listed MR', async () => {
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'mr') return { stdout: LIST };
      if (args[0] === 'api' && args[1] === 'graphql') return { stdout: GRAPHQL };
      return { stdout: '' };
    });
    const r = await svc.listPrs('D:/r');
    expect(r.ok && r.prs.map((p) => p.checks)).toEqual(['passing', 'pending', null]);
    const gql = calls.filter((c) => c.args[1] === 'graphql');
    expect(gql.length).toBe(1);
    expect(gql[0].args).toContain('fullPath=team/sub/repo');
    expect(gql[0].args.find((a) => a.startsWith('query='))).toContain('iids: ["7","8","9"]');
  });

  it('still lists the MRs, with no dots, when the GraphQL read fails', async () => {
    const { svc } = makeService((args) => {
      if (args[0] === 'mr') return { stdout: LIST };
      return Object.assign(new Error('graphql'), { stderr: 'Field headPipeline does not exist' });
    });
    const r = await svc.listPrs('D:/r');
    expect(r.ok && r.prs.map((p) => p.checks)).toEqual([null, null, null]);
  });

  it('skips the GraphQL call when there are no MRs', async () => {
    const { svc, calls } = makeService((args) => (args[0] === 'mr' ? { stdout: '[]' } : { stdout: '' }));
    await svc.listPrs('D:/r');
    expect(calls.some((c) => c.args[1] === 'graphql')).toBe(false);
  });
});

describe('GlabPrService — gate TTL', () => {
  it('reuses the auth answer for a minute and re-probes on force', async () => {
    const nowRef = { t: 0 };
    const { svc, calls } = makeService(() => ({ stdout: 'ok' }), nowRef);
    const auths = () => calls.filter((c) => c.args[0] === 'auth').length;
    expect((await svc.gate('D:/r', 'gitlab.company.io')).ok).toBe(true);
    nowRef.t = 30_000;
    await svc.gate('D:/r', 'gitlab.company.io');
    expect(auths()).toBe(1);
    expect(calls.filter((c) => c.args[0] === '--version').length).toBe(1);
    await svc.gate('D:/r', 'other.host');
    expect(auths()).toBe(2);
    nowRef.t = 61_000;
    await svc.gate('D:/r', 'gitlab.company.io');
    expect(auths()).toBe(3);
    nowRef.t = 70_000;
    await svc.gate('D:/r', 'gitlab.company.io', true);
    expect(auths()).toBe(4);
  });
});
