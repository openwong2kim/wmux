// GhPrService — gh JSON 매핑·게이트·TTL·updatedAt 상세캐시 (exec 목킹,
// PrStatusCache 테스트 스타일). + PrProvider의 remote 호스트 분류.
import { describe, it, expect, vi } from 'vitest';
import { GhPrService, mapGhListItem, mapGhDetail } from '../GhPrService';
import { parseRemoteHost, isGithubHost } from '../PrProvider';
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
  const svc = new GhPrService(() => nowRef.t, exec as never);
  return { svc, calls, nowRef };
}

const LIST_JSON = JSON.stringify([
  {
    number: 423,
    title: 'feat(diff): workspace git diff view',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'openwong2kim' },
    headRefName: 'feat/workspace-diff-surface',
    updatedAt: '2026-07-12T15:00:00Z',
    url: 'https://github.com/o/r/pull/423',
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'CONFLICTING',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS', conclusion: '' },
    ],
  },
  {
    number: 1,
    title: 'old',
    state: 'MERGED',
    url: 'https://github.com/o/r/pull/1',
    statusCheckRollup: [{ conclusion: 'FAILURE' }],
  },
  { title: 'malformed — number 없음', url: 'https://x' },
]);

describe('mapGhListItem / mapGhDetail — 매핑 계약', () => {
  it('state·draft·checks·reviewDecision 매핑, malformed는 null', () => {
    const arr = JSON.parse(LIST_JSON) as Parameters<typeof mapGhListItem>[0][];
    const a = mapGhListItem(arr[0])!;
    expect(a).toMatchObject({
      number: 423,
      state: 'open',
      author: 'openwong2kim',
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'pending', // IN_PROGRESS가 있으니 pending 우선.
    });
    expect(a.mergeable).toBe('CONFLICTING'); // uppercased from the gh payload.
    expect(mapGhListItem(arr[1])!).toMatchObject({ state: 'merged', checks: 'failing', mergeable: '' });
    expect(mapGhListItem(arr[2])).toBeNull();
    expect(mapGhListItem({ number: 2, url: 'u', isDraft: true, state: 'OPEN' })!.state).toBe('draft');
    expect(mapGhListItem({ number: 3, url: 'u', statusCheckRollup: [] })!.checks).toBeNull();
  });

  it('comments+reviews를 시간순 단일 스트림으로, 본문 캡 절단 마킹', () => {
    const big = 'x'.repeat(PR_COMMENT_BODY_CAP + 10);
    const out = mapGhDetail(
      {
        comments: [
          { author: { login: 'b' }, body: 'second', createdAt: '2026-07-12T02:00:00Z' },
          { author: { login: 'c' }, body: big, createdAt: '2026-07-12T03:00:00Z', url: 'cu' },
        ],
        reviews: [
          { author: { login: 'a' }, body: 'first review', state: 'APPROVED', submittedAt: '2026-07-12T01:00:00Z' },
          { author: { login: 'd' }, body: '', state: 'CHANGES_REQUESTED', submittedAt: '2026-07-12T04:00:00Z' },
        ],
      },
      'pr-url',
    );
    expect(out.map((c) => c.author)).toEqual(['a', 'b', 'c', 'd']);
    expect(out[0]).toMatchObject({ kind: 'review', reviewState: 'APPROVED', url: 'pr-url' });
    expect(out[2].truncated).toBe(true);
    expect(out[2].body.length).toBe(PR_COMMENT_BODY_CAP);
    expect(out[3]).toMatchObject({ kind: 'review', reviewState: 'CHANGES_REQUESTED', body: '' });
  });

  it('인라인 리뷰 코멘트(gh api)를 파일:라인 앵커와 함께 병합(Codex P2)', () => {
    const out = mapGhDetail(
      { comments: [], reviews: [] },
      'pr-url',
      [
        { user: { login: 'rev' }, body: 'nit here', created_at: '2026-07-12T05:00:00Z', html_url: 'h', path: 'src/a.ts', line: 42 },
        { user: { login: 'rev2' }, body: 'no path', created_at: '2026-07-12T06:00:00Z' },
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ author: 'rev', kind: 'review', url: 'h' });
    expect(out[0].body).toBe('src/a.ts:42 — nit here');
    expect(out[1].body).toBe('no path'); // path 없으면 앵커 없음.
  });

  it('HTML 주석(봇 마커)은 본문에서 스트립된다', () => {
    const out = mapGhDetail(
      {
        comments: [
          {
            author: { login: 'coderabbitai' },
            body: '<!-- auto-generated -->\n실제 내용\n<!-- entry_end -->',
            createdAt: 't',
          },
        ],
      },
      'u',
    );
    expect(out[0].body).toBe('실제 내용');
  });
});

describe('GhPrService — 게이트', () => {
  it('gh ENOENT → cli-missing, 프로세스 수명 동안 재프로브 없음', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const { svc, calls } = makeService(() => enoent);
    expect((await svc.gate('D:/r')).ok).toBe(false);
    expect((await svc.gate('D:/r')).ok).toBe(false);
    expect(calls.length).toBe(1); // 두 번째 gate는 exec 자체를 안 탐.
  });

  it('버전 OK + auth 실패 → unauthenticated', async () => {
    const { svc } = makeService((args) =>
      args[0] === '--version' ? { stdout: 'gh version 2' } : new Error('not logged in'),
    );
    const g = await svc.gate('D:/r');
    expect(g).toMatchObject({ ok: false, reason: 'unauthenticated' });
  });
});

describe('GhPrService — 목록 TTL·상세 updatedAt 캐시', () => {
  it('30s 내 재호출은 exec 생략, TTL 경과 후 재fetch', async () => {
    const nowRef = { t: 0 };
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: LIST_JSON };
      return { stdout: '' };
    }, nowRef);
    const r1 = await svc.listPrs('D:/r');
    expect(r1.ok && r1.prs.length).toBe(2); // malformed 1건 필터.
    await svc.listPrs('D:/r');
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
    nowRef.t = 31_000;
    await svc.listPrs('D:/r');
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(2);
  });

  it('force=true는 TTL 창 안에서도 gh를 재호출(수동 새로고침, Codex P2)', async () => {
    const nowRef = { t: 0 };
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: LIST_JSON };
      return { stdout: '' };
    }, nowRef);
    await svc.listPrs('D:/r');
    await svc.listPrs('D:/r'); // TTL 히트 — 재호출 없음.
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(1);
    await svc.listPrs('D:/r', true); // force — TTL 무시.
    expect(calls.filter((c) => c.args[1] === 'list').length).toBe(2);
  });

  it('상세 — 같은 updatedAt이면 재fetch 생략, 바뀌면 재fetch', async () => {
    const { svc, calls } = makeService((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: JSON.stringify({ number: 423, url: 'u', comments: [{ author: { login: 'a' }, body: 'hi', createdAt: 't' }], reviews: [] }) };
      }
      return { stdout: '' };
    });
    const d1 = await svc.prDetail('D:/r', 423, 'T1');
    expect(d1.ok && d1.detail.comments.length).toBe(1);
    await svc.prDetail('D:/r', 423, 'T1'); // 캐시 히트.
    expect(calls.filter((c) => c.args[1] === 'view').length).toBe(1);
    await svc.prDetail('D:/r', 423, 'T2'); // updatedAt 변경 → 재fetch.
    expect(calls.filter((c) => c.args[1] === 'view').length).toBe(2);
  });

  it('gh 실패 stderr는 fail-soft로 강등', async () => {
    const { svc } = makeService(() => Object.assign(new Error('boom'), { stderr: 'no pull requests' }));
    const r = await svc.listPrs('D:/r');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no pull requests');
  });
});

describe('parseRemoteHost / isGithubHost — provider 라우팅 재료', () => {
  it.each([
    ['https://github.com/o/r.git', 'github.com'],
    ['git@github.com:o/r.git', 'github.com'],
    ['ssh://git@github.com/o/r', 'github.com'],
    ['https://gitlab.com/o/r.git', 'gitlab.com'],
    ['git@gitlab.example.com:o/r.git', 'gitlab.example.com'],
    ['https://oauth2@gitlab.company.io/team/repo.git', 'gitlab.company.io'],
    ['', null],
  ])('%s → %s', (url, expected) => {
    expect(parseRemoteHost(url)).toBe(expected);
  });

  it('github.com 계열만 gh 경로', () => {
    expect(isGithubHost('github.com')).toBe(true);
    expect(isGithubHost('gitlab.com')).toBe(false);
    expect(isGithubHost('gitlab.company.io')).toBe(false);
  });
});
