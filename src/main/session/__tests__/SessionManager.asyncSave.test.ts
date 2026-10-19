/**
 * A4 (NB2 파동 0) — 비동기 주기 저장(saveAsync)의 계약.
 *
 * 목표: 5초 크래시-세이프티 틱을 main 이벤트 루프를 블록하지 않는 비동기 원자
 * 쓰기로 이관하되,
 *   (a) 종료/flush 경로가 마지막 스테이징을 유실 없이 디스크에 반영하고,
 *   (b) 리부트 생존의 핵심인 이벤트 기반 sync save()가 async 스테이징 이후
 *       발생하면 stale async 쓰기에 덮이지 않으며(에폭 가드),
 *   (c) 쓰기 원자성(tmp+rename, 유효 payload)은 그대로임
 * 을 고정한다.
 *
 * Electron `app.getPath('userData')`는 per-test tmpdir로 목킹(다른 SessionManager
 * 테스트와 동일 패턴).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = path.join(os.tmpdir(), 'wmux-sessionmgr-asyncsave-test');

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpRoot),
  },
}));

// 리뷰 반영(패널 2-MODEL): 진짜 in-flight 레이스(async 쓰기가 await에 진입한 뒤
// sync save가 끼어드는 창)를 재현하려면 async 쓰기를 인위적으로 멈출 게이트가
// 필요하다. 기본은 무지연 통과(open) — 해당 케이스만 게이트를 닫는다.
// 경로 주의: vi.mock은 "이 테스트 파일" 기준으로 resolve된다(SessionManager의
// import 스펙과 동일 모듈에 닿아야 함) — 잘못된 경로는 조용히 무시돼 가짜
// 양성이 되므로 gatedCalls 카운터로 목킹 실적용을 어서션한다.
let asyncWriteGate: Promise<void> | null = null;
let gatedCalls = 0;
vi.mock('../../../daemon/util/atomicWrite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../daemon/util/atomicWrite')>();
  return {
    ...original,
    atomicWriteJSON: async (...args: Parameters<typeof original.atomicWriteJSON>) => {
      if (asyncWriteGate) {
        gatedCalls += 1;
        await asyncWriteGate;
      }
      return original.atomicWriteJSON(...args);
    },
  };
});

import { SessionManager } from '../SessionManager';
import type { SessionData } from '../../../shared/types';

function freshDir(): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
}

/** 단일 leaf에 주어진 ptyId 하나를 담은 최소 SessionData. */
function makeSession(ptyId: string): SessionData {
  return {
    workspaces: [{
      id: 'ws-1',
      name: 'W1',
      rootPane: {
        id: 'pane-0',
        type: 'leaf',
        surfaces: [{ id: 'surf-0', ptyId, title: 't', shell: 'pwsh', cwd: '/x' }],
        activeSurfaceId: 'surf-0',
      },
      activePaneId: 'pane-0',
    } as SessionData['workspaces'][number]],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
}

function readDiskPtyId(sm: SessionManager): string | undefined {
  const loaded = sm.load();
  const rp = loaded?.workspaces?.[0]?.rootPane;
  if (rp && rp.type === 'leaf') return rp.surfaces[0]?.ptyId;
  return undefined;
}

describe('SessionManager — async periodic save (A4)', () => {
  beforeEach(freshDir);
  afterEach(() => vi.restoreAllMocks());

  it('saveAsync writes the payload atomically and validly (loadable round-trip)', async () => {
    const sm = new SessionManager();
    sm.saveAsync(makeSession('pty-async-1'));
    // 비동기 큐가 실제 쓰기를 완료할 때까지 대기.
    await sm.flush();
    expect(readDiskPtyId(sm)).toBe('pty-async-1');
  });

  it('flush() persists the last staged async snapshot before the debounce timer fires', async () => {
    const sm = new SessionManager();
    sm.saveAsync(makeSession('pty-A'));
    sm.saveAsync(makeSession('pty-B')); // 병합 — 마지막 값이 이겨야
    await sm.flush();
    expect(readDiskPtyId(sm)).toBe('pty-B');
  });

  it('flushSync() (exit path) writes the last staged async snapshot synchronously', () => {
    const sm = new SessionManager();
    sm.saveAsync(makeSession('pty-exit'));
    // 종료 경로: 이벤트 루프가 더 돌지 않는다고 가정하고 동기 flush.
    sm.flushSync();
    expect(readDiskPtyId(sm)).toBe('pty-exit');
  });

  it('a later sync save() wins over an in-flight async stage (reboot-survival guard)', async () => {
    const sm = new SessionManager();
    // async로 오래된 스냅샷을 스테이징한 뒤, 이벤트 기반 sync save로 최신 ptyId를
    // 커밋한다. 최종 디스크 상태는 반드시 최신(sync) 값이어야 한다.
    sm.saveAsync(makeSession('pty-stale-async'));
    sm.save(makeSession('pty-fresh-sync'));
    // 큐에 남아 있던 async 태스크가 실행되더라도 에폭 가드로 stale 쓰기를 건너뛴다.
    await sm.flush();
    expect(readDiskPtyId(sm)).toBe('pty-fresh-sync');
  });

  it('sync save() remains synchronous — data is on disk immediately (no await)', () => {
    const sm = new SessionManager();
    sm.save(makeSession('pty-sync-now'));
    // await 없이 즉시 읽어도 최신 값이 보여야 한다(동기 원자 쓰기).
    expect(readDiskPtyId(sm)).toBe('pty-sync-now');
  });

  it('a sync save that lands while an async write is IN-FLIGHT is restored (post-write recovery)', async () => {
    // 리뷰 반영(패널 2-MODEL — in-flight 역전): async 태스크가 pre-write 에폭
    // 검사를 통과하고 실제 쓰기(await)에 진입한 "후" sync save가 커밋하면,
    // 뒤늦은 async rename이 디스크를 stale로 되돌린다. post-write 복원 루프가
    // 이를 감지해 sync 커밋본을 재기록해야 한다 — 최종 디스크 = 최신(sync).
    const sm = new SessionManager();
    let openGate!: () => void;
    asyncWriteGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    try {
      gatedCalls = 0;
      sm.saveAsync(makeSession('pty-stale-inflight'));
      // 태스크가 큐에서 시작해 pre-check를 통과하고 게이트에 매달릴 때까지 양보.
      // 목킹 실적용 확인 — stale 쓰기가 게이트에 실제로 매달렸다(가짜 양성 방지).
      await vi.waitFor(() => expect(gatedCalls).toBe(1), { timeout: 10_000 });
      // 이 시점 async는 in-flight — queue.clear()로 제거 불가. sync가 최신 커밋.
      sm.save(makeSession('pty-fresh-sync-late'));
      expect(readDiskPtyId(sm)).toBe('pty-fresh-sync-late');
      // 게이트를 열어 stale async가 rename까지 완주하게 한 뒤 큐를 비운다.
      openGate();
      await sm.flush();
      // post-write 복원이 없다면 여기서 pty-stale-inflight가 보인다(역전).
      expect(readDiskPtyId(sm)).toBe('pty-fresh-sync-late');
    } finally {
      asyncWriteGate = null;
    }
  });
});
