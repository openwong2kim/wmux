// MissionsSection tests (NB2 파동2 사이클 C).
//
// Vitest는 jsdom 없이 node env로 돈다 — renderToStaticMarkup은 zustand의 SSR
// 스냅샷(스토어 생성 시점 상태)만 읽어 setState 이후 값은 반영하지 못한다. 따라서
// 표시 로직의 핵심(평탄화·정렬)은 순수 함수 flattenMissions로 분리해 직접 검증하고,
// 빈 상태만 SSR로 고정한다(생성 시점 미션 캐시는 비어 있음).
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
  // Reverted to "renders nothing" (2026-09-05): the sidebar is navigation only,
  // and a permanent "Tasks · 0 open" line is the dead gauge DESIGN.md forbids.
  // The list itself now lives in the deck's ledger panel.
  it('renders nothing with zero tasks', () => {
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

// ── Mission = workspace lifetime (owner policy) ────────────────────────────
// The decision rests on **workspace existence alone**. When a fan-out workspace is
// gone the mission row drops out of the list, and the record stays in the mission
// channel (this selector never touches channels).
describe('selectLiveMissions (pure)', () => {
  const live = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  it('excludes a mission whose workspace is gone', () => {
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

  it('excludes a done mission too once its workspace is gone (the cause of sidebar pile-up)', () => {
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

  it('keeps a done mission while its workspace is alive (jump and channel links still work)', () => {
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

  it('keeps a mission with no materialized paneGroupId (fan-out in flight) — not yet there is not gone', () => {
    const out = selectLiveMissions(
      { 'parent-a': [mission({ id: 'inflight', title: 'A' })] },
      live('parent-a'),
    );
    expect(out.map((t) => t.id)).toEqual(['inflight']);
  });

  it('excludes a mission whose child is gone even if the parent cache lingers (orphan-cache guard)', () => {
    const out = selectLiveMissions(
      { 'parent-gone': [mission({ id: 'orphan', title: 'A', paneGroupId: 'child-x' })] },
      live('parent-a'),
    );
    expect(out).toEqual([]);
  });
});
