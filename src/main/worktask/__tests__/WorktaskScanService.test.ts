// ─── WorktaskScanService — J3 §1 cleanup scan (4 disk source-of-truth kinds + GC backtrace) ──────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { WorktaskScanService, type ScanOpenTask } from '../WorktaskScanService';
import { WORKTASK_META_FILENAME, type WorkTaskMetaStamp } from '../../../shared/workTask';

let root: string; // dedicated root stub ({wmux home}/worktrees band)
const REPO_HASH = 'abc123def456';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-scan-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Create worktree directory (+ optional task.json) under dedicated root. Returns worktree path. */
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

/** Deterministic scan via linux normalization + identity realpath + injected isDirty. */
function makeSvc(dirtyPaths: Set<string> = new Set()): WorktaskScanService {
  return new WorktaskScanService({
    worktreesRoot: root,
    platform: 'linux',
    realpath: (p) => p,
    isDirty: async (p) => dirtyPaths.has(p),
  });
}

describe('J3 §1 cleanup scan — four category kinds', () => {
  it('unmaterialized-open: open task without worktreePath', async () => {
    const svc = makeSvc();
    const res = await svc.scan([{ taskId: 'wtask-1', title: 'A' }]);
    const e = res.entries.find((x) => x.category === 'unmaterialized-open');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-1');
    expect(e?.title).toBe('A');
  });

  it('disk-missing: claims worktreePath but absent on disk', async () => {
    const svc = makeSvc();
    const ghost = path.join(root, REPO_HASH, 'ghost-slug');
    const res = await svc.scan([{ taskId: 'wtask-2', title: 'B', worktreePath: ghost }]);
    const e = res.entries.find((x) => x.category === 'disk-missing');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-2');
    expect(e?.worktreePath).toBe(ghost);
  });

  it('preserved: disk worktree matches open task + dirty', async () => {
    const wt = seedWorktree('preserved-slug');
    const svc = makeSvc(new Set([wt]));
    const res = await svc.scan([{ taskId: 'wtask-3', title: 'C', worktreePath: wt }]);
    const e = res.entries.find((x) => x.category === 'preserved');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-3');
    expect(e?.worktreePath).toBe(wt);
  });

  it('clean+linked (normal work) is not an anomaly — excluded from list', async () => {
    const wt = seedWorktree('clean-slug');
    const svc = makeSvc(/* not dirty */);
    const res = await svc.scan([{ taskId: 'wtask-4', title: 'D', worktreePath: wt }]);
    // not listed in any category (normal work).
    expect(res.entries.find((x) => x.worktreePath === wt)).toBeUndefined();
    expect(res.entries).toHaveLength(0);
  });

  it('orphan-dir: disk worktree with no matching open task (task.json backtrace)', async () => {
    const wt = seedWorktree('orphan-slug', { taskId: 'wtask-5', title: 'E', createdAt: 111 });
    const svc = makeSvc();
    const res = await svc.scan([]); // no tasks in projection.
    const e = res.entries.find((x) => x.category === 'orphan-dir');
    expect(e).toBeTruthy();
    expect(e?.taskId).toBe('wtask-5'); // task.json backtrace.
    expect(e?.title).toBe('E');
    expect(e?.worktreePath).toBe(wt);
  });

  it('orphan-dir: listed without backtrace when task.json absent (safe delete candidate)', async () => {
    const wt = seedWorktree('bare-orphan'); // no stamp.
    const svc = makeSvc();
    const res = await svc.scan([]);
    const e = res.entries.find((x) => x.worktreePath === wt);
    expect(e?.category).toBe('orphan-dir');
    expect(e?.taskId).toBeUndefined();
  });
});

describe('J3 §1 post-GC backtrace (task.json after closed task removal)', () => {
  it('backtraces GCed closed task worktree via taskId·closedAt', async () => {
    // closed task gone from projection via 7-day GC = absent from openTasks.
    // only worktree + task.json (with closedAt) remains on disk.
    const wt = seedWorktree('gc-slug', {
      taskId: 'wtask-gc',
      title: 'GCed mission',
      createdAt: 1000,
      closedAt: 2000,
    });
    const svc = makeSvc();
    const res = await svc.scan([]);
    const e = res.entries.find((x) => x.worktreePath === wt);
    expect(e?.category).toBe('orphan-dir');
    expect(e?.taskId).toBe('wtask-gc');
    expect(e?.title).toBe('GCed mission');
    expect(e?.closedAt).toBe(2000);
  });
});

describe('J3 F1 owner scope — ownerWorkspaceId on anomaly entries', () => {
  it('unmaterialized-open·preserved entries carry owner ws id', async () => {
    const wt = seedWorktree('owned-slug');
    const svc = makeSvc(new Set([wt]));
    const res = await svc.scan([
      { taskId: 'wtask-u', title: 'U', ownerWorkspaceId: 'parent-a' },
      { taskId: 'wtask-p', title: 'P', ownerWorkspaceId: 'parent-b', worktreePath: wt },
    ]);
    expect(res.entries.find((x) => x.taskId === 'wtask-u')?.ownerWorkspaceId).toBe('parent-a');
    expect(res.entries.find((x) => x.taskId === 'wtask-p')?.ownerWorkspaceId).toBe('parent-b');
  });

  it('disk-missing entries also carry owner ws id', async () => {
    const svc = makeSvc();
    const ghost = path.join(root, REPO_HASH, 'ghost2');
    const res = await svc.scan([{ taskId: 'wtask-d', title: 'D', ownerWorkspaceId: 'parent-c', worktreePath: ghost }]);
    expect(res.entries.find((x) => x.taskId === 'wtask-d')?.ownerWorkspaceId).toBe('parent-c');
  });
});

describe('J3 F8 meta orphan — .meta remnant without worktree', () => {
  it('orphan-dir when only .meta/{slug}/task.json remains without worktree (no auto delete)', async () => {
    // crash between remove↔meta delete: no worktree dir, meta only remains.
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

  it('healthy meta with worktree is not listed twice', async () => {
    // worktree + matching open task (clean) → not an anomaly. meta sidecar present → not orphan.
    const wt = seedWorktree('healthy', { taskId: 'wtask-h', title: 'H', createdAt: 1 });
    const svc = makeSvc(/* clean */);
    const res = await svc.scan([{ taskId: 'wtask-h', title: 'H', worktreePath: wt }]);
    expect(res.entries).toHaveLength(0);
  });
});

describe('J3 §1 scan boundaries', () => {
  it('.meta sidecar is not mistaken for a worktree', async () => {
    seedWorktree('with-meta', { taskId: 'wtask-6', title: 'F', createdAt: 1 });
    const svc = makeSvc();
    const res = await svc.scan([{ taskId: 'wtask-6', title: 'F', worktreePath: path.join(root, REPO_HASH, 'with-meta') }]);
    // .meta directory must not be misclassified as orphan-dir.
    expect(res.entries.find((x) => x.worktreePath?.endsWith('.meta'))).toBeUndefined();
  });

  it('missing dedicated root yields empty scan (no exception)', async () => {
    const svc = new WorktaskScanService({
      worktreesRoot: path.join(root, 'does-not-exist'),
      platform: 'linux',
      realpath: (p) => p,
      isDirty: async () => false,
    });
    const res = await svc.scan([]);
    expect(res.entries).toHaveLength(0);
  });

  it('isDirty throw → conservatively listed as preserved (harmless side)', async () => {
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
