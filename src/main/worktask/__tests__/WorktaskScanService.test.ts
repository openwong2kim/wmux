// ─── WorktaskScanService — J3 §1 정리 스캔(디스크 정본 4종 + GC 역추적) ──────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { WorktaskScanService, type ScanOpenTask } from '../WorktaskScanService';
import { WORKTASK_META_FILENAME, type WorkTaskMetaStamp } from '../../../shared/workTask';

let root: string; // 전용 루트 스텁({wmux home}/worktrees 대역)
const REPO_HASH = 'abc123def456';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-scan-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 전용 루트에 worktree 디렉토리(+선택적 task.json)를 만든다. 반환=worktree 경로. */
function seedWorktree(slug: string, stamp?: WorkTaskMetaStamp): string {
  const wt = path.join(root, REPO_HASH, slug);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'file.txt'), 'work\n');
  if (stamp) {
    const meta = path.join(root, REPO_HASH, '.meta', slug);
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, WORKTASK_META_FILENAME), JSON.stringify(stamp));
  }
  return wt;
}

/** linux 정규화 + realpath=항등 + isDirty 주입으로 결정론 스캔. */
function makeSvc(dirtyPaths: Set<string> = new Set()): WorktaskScanService {
  return new WorktaskScanService({
    worktreesRoot: root,
    platform: 'linux',
    realpath: (p) => p,
    isDirty: async (p) => dirtyPaths.has(p),
  });
}

describe('J3 §1 정리 스캔 4종 판정', () => {
  it('unmaterialized-open: worktreePath 부재 open 태스크', async () => {
    const svc = makeSvc();
    const res = await svc.scan([{ taskId: 'wtask-1', title: 'A' }]);
    const e = res.entries.find((x) => x.category === 'unmaterialized-open');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-1');
    expect(e?.title).toBe('A');
  });

  it('disk-missing: worktreePath 주장하나 디스크 부재', async () => {
    const svc = makeSvc();
    const ghost = path.join(root, REPO_HASH, 'ghost-slug');
    const res = await svc.scan([{ taskId: 'wtask-2', title: 'B', worktreePath: ghost }]);
    const e = res.entries.find((x) => x.category === 'disk-missing');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-2');
    expect(e?.worktreePath).toBe(ghost);
  });

  it('preserved: 디스크 worktree가 open 태스크와 매칭 + dirty', async () => {
    const wt = seedWorktree('preserved-slug');
    const svc = makeSvc(new Set([wt]));
    const res = await svc.scan([{ taskId: 'wtask-3', title: 'C', worktreePath: wt }]);
    const e = res.entries.find((x) => x.category === 'preserved');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-3');
    expect(e?.worktreePath).toBe(wt);
  });

  it('clean+linked(정상 작업)은 이상 아님 — 목록 제외', async () => {
    const wt = seedWorktree('clean-slug');
    const svc = makeSvc(/* dirty 없음 */);
    const res = await svc.scan([{ taskId: 'wtask-4', title: 'D', worktreePath: wt }]);
    // 어떤 카테고리로도 등재되지 않는다(정상 작업).
    expect(res.entries.find((x) => x.worktreePath === wt)).toBeUndefined();
    expect(res.entries).toHaveLength(0);
  });

  it('orphan-dir: 매칭 open 태스크 없는 디스크 worktree(task.json 역추적)', async () => {
    const wt = seedWorktree('orphan-slug', { taskId: 'wtask-5', title: 'E', createdAt: 111 });
    const svc = makeSvc();
    const res = await svc.scan([]); // projection에 아무 태스크도 없음.
    const e = res.entries.find((x) => x.category === 'orphan-dir');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-5'); // task.json 역추적.
    expect(e?.title).toBe('E');
    expect(e?.worktreePath).toBe(wt);
  });

  it('orphan-dir: task.json 부재면 역추적 없이 등재(안전 삭제 대상)', async () => {
    const wt = seedWorktree('bare-orphan'); // 스탬프 없음.
    const svc = makeSvc();
    const res = await svc.scan([]);
    const e = res.entries.find((x) => x.worktreePath === wt);
    expect(e?.category).toBe('orphan-dir');
    expect(e?.taskId).toBeUndefined();
  });
});

describe('detach 보호 — 살아있는 detached worktree는 정리 목록에서 완전히 제외', () => {
  it('detached=true 매칭 worktree는 clean이든 dirty든 orphan-dir/preserved로 등재되지 않는다', async () => {
    const wt = seedWorktree('detached-slug');
    // Even when dirty (active independent work) it must not be listed — the orphan-dir misclassification is the core defect.
    const svc = makeSvc(new Set([wt]));
    const res = await svc.scan([{ taskId: 'wtask-d', title: 'Independent', worktreePath: wt, detached: true }]);
    expect(res.entries.find((x) => x.worktreePath === wt)).toBeUndefined();
    expect(res.entries).toHaveLength(0);
  });

  it('detached인데 worktree가 이미 없으면 disk-missing으로 잘못 등재하지 않는다(이미 closed)', async () => {
    const svc = makeSvc();
    const ghost = path.join(root, REPO_HASH, 'gone-detached');
    const res = await svc.scan([{ taskId: 'wtask-dm', title: 'Gone', worktreePath: ghost, detached: true }]);
    expect(res.entries).toHaveLength(0);
  });

  it('보호 대조: detached 플래그가 없으면 같은 dirty worktree는 preserved로 등재된다', async () => {
    const wt = seedWorktree('not-detached-slug');
    const svc = makeSvc(new Set([wt]));
    const res = await svc.scan([{ taskId: 'wtask-nd', title: 'Harvest', worktreePath: wt }]);
    expect(res.entries.find((x) => x.category === 'preserved' && x.worktreePath === wt)).toBeTruthy();
  });
});

describe('J3 §1 GC 이후 역추적(closed 태스크 소멸 후 task.json)', () => {
  it('projection에서 GC된 closed 태스크의 worktree를 taskId·closedAt로 역추적', async () => {
    // closed 태스크가 7일 GC로 projection에서 사라진 상태 = openTasks에 부재.
    // worktree + task.json(closedAt 포함)만 디스크에 잔존.
    const wt = seedWorktree('gc-slug', {
      taskId: 'wtask-gc',
      title: 'GC된 미션',
      createdAt: 1000,
      closedAt: 2000,
    });
    const svc = makeSvc();
    const res = await svc.scan([]);
    const e = res.entries.find((x) => x.worktreePath === wt);
    expect(e?.category).toBe('orphan-dir');
    expect(e?.taskId).toBe('wtask-gc');
    expect(e?.title).toBe('GC된 미션');
    expect(e?.closedAt).toBe(2000);
  });
});

describe('J3 F1 owner 스코프 — 이상 엔트리에 ownerWorkspaceId', () => {
  it('unmaterialized-open·preserved 엔트리에 owner ws id가 실린다', async () => {
    const wt = seedWorktree('owned-slug');
    const svc = makeSvc(new Set([wt]));
    const res = await svc.scan([
      { taskId: 'wtask-u', title: 'U', ownerWorkspaceId: 'parent-a' },
      { taskId: 'wtask-p', title: 'P', ownerWorkspaceId: 'parent-b', worktreePath: wt },
    ]);
    expect(res.entries.find((x) => x.taskId === 'wtask-u')?.ownerWorkspaceId).toBe('parent-a');
    expect(res.entries.find((x) => x.taskId === 'wtask-p')?.ownerWorkspaceId).toBe('parent-b');
  });

  it('disk-missing 엔트리에도 owner ws id가 실린다', async () => {
    const svc = makeSvc();
    const ghost = path.join(root, REPO_HASH, 'ghost2');
    const res = await svc.scan([{ taskId: 'wtask-d', title: 'D', ownerWorkspaceId: 'parent-c', worktreePath: ghost }]);
    expect(res.entries.find((x) => x.taskId === 'wtask-d')?.ownerWorkspaceId).toBe('parent-c');
  });
});

describe('J3 F8 meta 고아 — worktree 없는 .meta 잔여', () => {
  it('worktree 없이 .meta/{slug}/task.json만 남으면 orphan-dir로 표시(자동 삭제 안 함)', async () => {
    // remove↔meta 삭제 사이 크래시: worktree 디렉토리는 없고 meta만 잔존.
    const slug = 'meta-only';
    const metaDir = path.join(root, REPO_HASH, '.meta', slug);
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, WORKTASK_META_FILENAME),
      JSON.stringify({ taskId: 'wtask-mo', title: 'MO', createdAt: 1, closedAt: 2 }),
    );
    const svc = makeSvc();
    const res = await svc.scan([]);
    const e = res.entries.find((x) => x.taskId === 'wtask-mo');
    expect(e?.category).toBe('orphan-dir');
    expect(e?.title).toBe('MO');
    expect(e?.worktreePath).toBe(path.join(root, REPO_HASH, slug));
  });

  it('worktree가 있는 정상 meta는 중복 등재되지 않는다', async () => {
    // worktree + open 태스크 매칭(clean) → 이상 아님. meta 사이드카가 있어도 orphan 아님.
    const wt = seedWorktree('healthy', { taskId: 'wtask-h', title: 'H', createdAt: 1 });
    const svc = makeSvc(/* clean */);
    const res = await svc.scan([{ taskId: 'wtask-h', title: 'H', worktreePath: wt }]);
    expect(res.entries).toHaveLength(0);
  });
});

describe('J3 §1 스캔 경계', () => {
  it('.meta 사이드카는 worktree로 오인하지 않는다', async () => {
    seedWorktree('with-meta', { taskId: 'wtask-6', title: 'F', createdAt: 1 });
    const svc = makeSvc();
    const res = await svc.scan([{ taskId: 'wtask-6', title: 'F', worktreePath: path.join(root, REPO_HASH, 'with-meta') }]);
    // .meta 디렉토리가 orphan-dir로 잘못 잡히면 안 됨.
    expect(res.entries.find((x) => x.worktreePath?.endsWith('.meta'))).toBeUndefined();
  });

  it('전용 루트 부재는 빈 스캔(예외 없음)', async () => {
    const svc = new WorktaskScanService({
      worktreesRoot: path.join(root, 'does-not-exist'),
      platform: 'linux',
      realpath: (p) => p,
      isDirty: async () => false,
    });
    const res = await svc.scan([]);
    expect(res.entries).toHaveLength(0);
  });

  it('isDirty가 throw하면 보수적으로 preserved 등재(무해측)', async () => {
    const wt = seedWorktree('throw-slug');
    const svc = new WorktaskScanService({
      worktreesRoot: root,
      platform: 'linux',
      realpath: (p) => p,
      isDirty: async () => {
        throw new Error('git unavailable');
      },
    });
    const res = await svc.scan([{ taskId: 'wtask-7', title: 'G', worktreePath: wt }]);
    expect(res.entries.find((x) => x.worktreePath === wt)?.category).toBe('preserved');
  });
});
