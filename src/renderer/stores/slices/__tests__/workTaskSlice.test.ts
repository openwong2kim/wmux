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

  describe('J3 §3 registerTaskPtys (onExhausted 토스트 매핑)', () => {
    it('ptyId→태스크 매핑을 등록하고 worktreePath를 보존한다', () => {
      store.getState().registerTaskPtys([
        { ptyId: 'pty-1', taskId: 'wtask-1', title: 'A', worktreePath: '/wt/a' },
        { ptyId: 'pty-2', taskId: 'wtask-2', title: 'B' }, // worktreePath 없음(미물질화).
      ]);
      expect(store.getState().taskPtyRegistry['pty-1']).toEqual({ taskId: 'wtask-1', title: 'A', worktreePath: '/wt/a' });
      expect(store.getState().taskPtyRegistry['pty-2']).toEqual({ taskId: 'wtask-2', title: 'B' });
    });

    it('빈 ptyId 항목은 건너뛴다', () => {
      store.getState().registerTaskPtys([{ ptyId: '', taskId: 'x', title: 'X' }]);
      expect(Object.keys(store.getState().taskPtyRegistry)).toHaveLength(0);
    });
  });

  describe('J3 §4 setPaneGroupDeparted (이탈 뱃지)', () => {
    it('이탈 cwd를 설정하고 null로 해제한다', () => {
      store.getState().setPaneGroupDeparted('child-1', '/somewhere/else');
      expect(store.getState().departedPaneGroups['child-1']).toBe('/somewhere/else');
      store.getState().setPaneGroupDeparted('child-1', null);
      expect(store.getState().departedPaneGroups['child-1']).toBeUndefined();
    });

    it('빈 paneGroupId는 무시한다', () => {
      store.getState().setPaneGroupDeparted('', '/x');
      expect(Object.keys(store.getState().departedPaneGroups)).toHaveLength(0);
    });
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

describe('워크스페이스 수명 결속 — closeMissionForRemovedWorkspace', () => {
  interface MockedWindow {
    __wmuxMissionRpc?: {
      list: (p: Record<string, unknown>) => Promise<unknown>;
      close: (p: Record<string, unknown>) => Promise<unknown>;
    };
  }
  const g = globalThis as unknown as { window?: MockedWindow };

  function withMissionRpc(): { calls: Array<{ method: string; params: Record<string, unknown> }> } {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    g.window = {
      __wmuxMissionRpc: {
        list: async (params) => {
          calls.push({ method: 'list', params });
          return { ok: true, tasks: [] };
        },
        close: async (params) => {
          calls.push({ method: 'close', params });
          return { ok: true };
        },
      },
    };
    return { calls };
  }

  afterEach(() => {
    delete g.window;
  });

  it('삭제된 태스크 워크스페이스의 open 미션을 owner 신원으로 close한다', async () => {
    const { calls } = withMissionRpc();
    const store = createTestStore();
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' }),
    ]);

    await store.getState().closeMissionForRemovedWorkspace('child-1');

    const close = calls.find((c) => c.method === 'close');
    expect(close).toBeDefined();
    expect(close?.params).toEqual({ taskId: 'wtask-1', verifiedWorkspaceId: 'parent-a' });
  });

  it('이미 closed거나 매칭 미션이 없으면 close를 부르지 않는다', async () => {
    const { calls } = withMissionRpc();
    const store = createTestStore();
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1', status: 'closed', closedAt: 1 }),
    ]);

    await store.getState().closeMissionForRemovedWorkspace('child-1');
    await store.getState().closeMissionForRemovedWorkspace('child-unknown');

    expect(calls.filter((c) => c.method === 'close')).toHaveLength(0);
  });

  it('데몬이 close를 거부하면 경고만 남기고 캐시 재조회는 하지 않는다', async () => {
    // 회귀: 이 호출은 fire-and-forget이라 NOT_AUTHORIZED 전량 실패가 무증상이었다.
    const calls: string[] = [];
    g.window = {
      __wmuxMissionRpc: {
        list: async () => {
          calls.push('list');
          return { ok: true, tasks: [] };
        },
        close: async () => {
          calls.push('close');
          return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'nope' } };
        },
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const store = createTestStore();
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' }),
    ]);

    await store.getState().closeMissionForRemovedWorkspace('child-1');

    expect(calls).toEqual(['close']); // 거부 후 list 재조회 없음
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('브리지 미설치/데몬 미연결이면 조용히 no-op(사이드바는 워크스페이스 실존만 본다)', async () => {
    g.window = {}; // 브리지 미설치 렌더러(useRpcBridge 마운트 전).
    const store = createTestStore();
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' }),
    ]);
    await expect(
      store.getState().closeMissionForRemovedWorkspace('child-1'),
    ).resolves.toBeUndefined();
  });
});

// ─── 전송 경로 회귀(소스 레벨) ────────────────────────────────────────────────
// `task.mission.close`는 파이프 RpcRouter에서 mutating으로 등록돼 있고, 그 포워더는
// senderPtyId를 해석할 수 없는 mutating 호출을 전부 NOT_AUTHORIZED로 막는다. 렌더러
// 호출엔 PTY가 없으므로 `rpc.invoke`로 보내면 100% 조용히 실패한다. 이 사실은 런타임
// 목으로는 잡히지 않으니(둘 다 프라미스를 돌려준다) 브리지 소스 자체를 고정한다.
// (workspaceSlice.retentionMigration.test.ts의 소스 단정 관례와 동형.)
describe('미션 close 전송 경로(회귀)', () => {
  it('close 브리지는 rpc.invoke가 아니라 mutateChannelLocal로 탄다', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/renderer/hooks/useRpcBridge.ts'), 'utf8');
    expect(src).toContain("mutateChannelLocal('task.mission.close'");
    expect(src).not.toContain("invoke('task.mission.close'");
  });
});

// ─── 부모 워크스페이스 삭제가 살아 있는 자식 미션을 숨기지 않는다(회귀) ──────────
// removeWorkspace가 부모 id로 clearMissionsFor를 무조건 부르면, 자식 워크스페이스가
// 아직 살아 있는 미션까지 통째로 사라진다(사이드바에서 증발 + 나중에 자식이 지워질 때
// closeMissionForRemovedWorkspace가 태스크를 찾지 못함).
describe('부모 미션 캐시 보존(회귀)', () => {
  it('removeWorkspace는 clearMissionsFor를 무조건 호출하지 않는다', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/renderer/stores/slices/workspaceSlice.ts'), 'utf8');
    expect(src).not.toContain('clearMissionsFor?.(id)');
    // 자식 id 기준 close 배선은 그대로 남아 있어야 한다.
    expect(src).toContain('closeMissionForRemovedWorkspace?.(id)');
  });
});
