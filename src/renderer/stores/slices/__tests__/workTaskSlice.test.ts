import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkTaskSlice, type WorkTaskSlice } from '../workTaskSlice';
import type { WorkTask } from '../../../../shared/workTask';

// WorkTaskSlice는 StoreState 전체가 아니라 자기 상태만 건드리므로 최소 목 스토어로
// 검증한다(companySlice.test.ts 관례 동형).
function createTestStore() {
  return create<WorkTaskSlice>()(
    immer((...args) => ({
      // @ts-expect-error — 최소 목 스토어는 전체 StoreState와 일치하지 않는다.
      ...createWorkTaskSlice(...args),
    })),
  );
}

/** 미션 픽스처 헬퍼(필수 필드만 채운다 — 렌더러는 read-only 소비자). */
function mission(over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title'>): WorkTask {
  const ref = { principalId: 'p', verifiedWorkspaceId: over.owner?.verifiedWorkspaceId ?? 'parent-a' };
  return {
    status: 'open',
    missionChannelId: `chan-${over.id}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    ...over,
  } as WorkTask;
}

describe('workTaskSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('setMissions가 부모별로 캐싱하고 paneGroupId 역인덱스를 만든다', () => {
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' }),
      mission({ id: 'wtask-2', title: 'B', paneGroupId: 'child-2' }),
    ]);
    expect(store.getState().missionsByWorkspace['parent-a']).toHaveLength(2);
    expect(store.getState().getMissionForPaneGroup('child-1')?.id).toBe('wtask-1');
    expect(store.getState().getMissionForPaneGroup('child-2')?.title).toBe('B');
  });

  it('paneGroupId 미물질화(fan-out 진행 중) 태스크는 역인덱스에서 빠진다', () => {
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A' }), // paneGroupId 없음
    ]);
    expect(store.getState().missionsByWorkspace['parent-a']).toHaveLength(1);
    expect(store.getState().getMissionForPaneGroup('child-1')).toBeUndefined();
  });

  it('여러 부모의 미션을 하나의 paneGroupId 인덱스로 합친다', () => {
    store.getState().setMissions('parent-a', [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })]);
    store.getState().setMissions('parent-b', [mission({ id: 'wtask-9', title: 'Z', paneGroupId: 'child-9', owner: { principalId: 'p', verifiedWorkspaceId: 'parent-b' } })]);
    expect(store.getState().getMissionForPaneGroup('child-1')?.id).toBe('wtask-1');
    expect(store.getState().getMissionForPaneGroup('child-9')?.id).toBe('wtask-9');
  });

  it('setMissions 재호출은 그 부모의 목록만 통째로 교체한다(다른 부모 보존)', () => {
    store.getState().setMissions('parent-a', [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })]);
    store.getState().setMissions('parent-b', [mission({ id: 'wtask-2', title: 'B', paneGroupId: 'child-2' })]);
    // parent-a를 빈 목록으로 교체 → child-1 인덱스 사라지고 parent-b는 유지.
    store.getState().setMissions('parent-a', []);
    expect(store.getState().getMissionForPaneGroup('child-1')).toBeUndefined();
    expect(store.getState().getMissionForPaneGroup('child-2')?.id).toBe('wtask-2');
  });

  it('clearMissionsFor는 부모 캐시와 그 역인덱스를 제거한다', () => {
    store.getState().setMissions('parent-a', [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })]);
    store.getState().clearMissionsFor('parent-a');
    expect(store.getState().missionsByWorkspace['parent-a']).toBeUndefined();
    expect(store.getState().getMissionForPaneGroup('child-1')).toBeUndefined();
  });

  describe('refreshMissions (브리지 경유)', () => {
    afterEach(() => {
      delete (globalThis as { window?: unknown }).window;
    });

    it('rpc.invoke 봉투({result:{ok,tasks}})를 벗겨 setMissions에 투영한다', async () => {
      const listFn = vi.fn().mockResolvedValue({
        ok: true,
        result: { ok: true, tasks: [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })] },
      });
      (globalThis as { window?: unknown }).window = { __wmuxMissionRpc: { list: listFn } };

      await store.getState().refreshMissions('parent-a');

      expect(listFn).toHaveBeenCalledWith({ verifiedWorkspaceId: 'parent-a' });
      expect(store.getState().getMissionForPaneGroup('child-1')?.id).toBe('wtask-1');
    });

    it('브리지 미설치/거부/비배열 응답은 조용한 no-op(캐시 불변)', async () => {
      // 브리지 없음.
      (globalThis as { window?: unknown }).window = {};
      await store.getState().refreshMissions('parent-a');
      expect(store.getState().missionsByWorkspace['parent-a']).toBeUndefined();

      // ok=false 봉투.
      (globalThis as { window?: unknown }).window = {
        __wmuxMissionRpc: { list: vi.fn().mockResolvedValue({ ok: false }) },
      };
      await store.getState().refreshMissions('parent-a');
      expect(store.getState().missionsByWorkspace['parent-a']).toBeUndefined();
    });

    it('빈 verifiedWorkspaceId는 브리지를 부르지 않는다', async () => {
      const listFn = vi.fn();
      (globalThis as { window?: unknown }).window = { __wmuxMissionRpc: { list: listFn } };
      await store.getState().refreshMissions('');
      expect(listFn).not.toHaveBeenCalled();
    });
  });
});
