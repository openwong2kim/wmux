// MissionsSection tests (NB2 파동2 사이클 C).
//
// Vitest는 jsdom 없이 node env로 돈다 — renderToStaticMarkup은 zustand의 SSR
// 스냅샷(스토어 생성 시점 상태)만 읽어 setState 이후 값은 반영하지 못한다. 따라서
// 표시 로직의 핵심(평탄화·정렬)은 순수 함수 flattenMissions로 분리해 직접 검증하고,
// 빈 상태(null 반환 → 공간 0)만 SSR로 고정한다(생성 시점 미션 캐시는 비어 있음).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import MissionsSection, { flattenMissions, selectLiveMissions } from '../MissionsSection';
import type { WorkTask } from '../../../../shared/workTask';

function mission(over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title'>): WorkTask {
  const ref = { principalId: 'p', verifiedWorkspaceId: 'parent-a' };
  return {
    status: 'open',
    missionChannelId: `chan-${over.id}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    ...over,
  } as WorkTask;
}

describe('MissionsSection', () => {
  it('빈 캐시에서는 아무 것도 렌더하지 않는다(공간 0)', () => {
    // 스토어 생성 시점 missionsByWorkspace는 비어 있으므로 SSR은 빈 상태를 본다.
    const html = renderToStaticMarkup(createElement(MissionsSection));
    expect(html).toBe('');
  });

  describe('flattenMissions (순수)', () => {
    it('빈 맵은 빈 배열', () => {
      expect(flattenMissions({})).toEqual([]);
    });

    it('여러 부모의 미션을 하나로 합친다', () => {
      const out = flattenMissions({
        'parent-a': [mission({ id: 'a1', title: 'A' })],
        'parent-b': [mission({ id: 'b1', title: 'B' }), mission({ id: 'b2', title: 'C' })],
      });
      expect(out.map((t) => t.id).sort()).toEqual(['a1', 'b1', 'b2']);
    });

    it('open을 closed보다 먼저 정렬한다', () => {
      const out = flattenMissions({
        p: [
          mission({ id: 'closed', title: 'Z', status: 'closed', createdAt: 100 }),
          mission({ id: 'open', title: 'A', status: 'open', createdAt: 1 }),
        ],
      });
      expect(out[0].id).toBe('open');
      expect(out[1].id).toBe('closed');
    });

    it('같은 상태 안에서는 최신(createdAt desc) 순', () => {
      const out = flattenMissions({
        p: [
          mission({ id: 'older', title: 'O', createdAt: 1 }),
          mission({ id: 'newer', title: 'N', createdAt: 5 }),
        ],
      });
      expect(out.map((t) => t.id)).toEqual(['newer', 'older']);
    });
  });
});

// ── 미션 = 워크스페이스 수명(오너 정책) ────────────────────────────────────
// 판정은 **워크스페이스 실존 하나**로만 한다. fan-out 워크스페이스가 사라지면 미션
// 행이 목록에서 빠지고, 기록은 미션 채널에 남는다(이 셀렉터는 채널을 건드리지 않는다).
describe('selectLiveMissions (순수)', () => {
  const live = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  it('워크스페이스가 사라진 미션을 제외한다', () => {
    const out = selectLiveMissions(
      {
        'parent-a': [
          mission({ id: 'alive', title: 'A', paneGroupId: 'child-1' }),
          mission({ id: 'gone', title: 'B', paneGroupId: 'child-2' }),
        ],
      },
      live('parent-a', 'child-1'),
    );
    expect(out.map((t) => t.id)).toEqual(['alive']);
  });

  it('완료 미션도 워크스페이스가 사라지면 제외된다(사이드바 누적의 원인)', () => {
    const out = selectLiveMissions(
      {
        'parent-a': [
          mission({ id: 'done', title: 'A', paneGroupId: 'child-1', status: 'closed', closedAt: 1 }),
        ],
      },
      live('parent-a'),
    );
    expect(out).toEqual([]);
  });

  it('완료됐어도 워크스페이스가 살아 있으면 남는다(점프·채널 링크가 유효)', () => {
    const out = selectLiveMissions(
      {
        'parent-a': [
          mission({ id: 'done', title: 'A', paneGroupId: 'child-1', status: 'closed', closedAt: 1 }),
        ],
      },
      live('parent-a', 'child-1'),
    );
    expect(out.map((t) => t.id)).toEqual(['done']);
  });

  it('paneGroupId 미물질화(fan-out 진행 중)는 남긴다 — 아직 없는 것이지 사라진 게 아니다', () => {
    const out = selectLiveMissions(
      { 'parent-a': [mission({ id: 'inflight', title: 'A' })] },
      live('parent-a'),
    );
    expect(out.map((t) => t.id)).toEqual(['inflight']);
  });

  it('부모 캐시가 남아 있어도 자식이 없으면 제외된다(고아 캐시 방어)', () => {
    const out = selectLiveMissions(
      { 'parent-gone': [mission({ id: 'orphan', title: 'A', paneGroupId: 'child-x' })] },
      live('parent-a'),
    );
    expect(out).toEqual([]);
  });
});
