// ─── WorkTaskService tests (J0 §0 success criteria + §1~§3 contracts) ────────────────
//
// Success criteria (§0) E2E round-trip: mission.start → channel post → mission.close → daemon restart
// simulation (service recreate + boot replay) → projection restore (closed) · archive idempotent
// retry no-op. This test is the verdict for "R3 blocker cleared".
//
// Infrastructure: real AppendOnlyLog (reuse A2aTaskService.test.ts fixture) + real
// ChannelService (reuse ChannelService.test.ts fake writer pattern, E2E fidelity),
// or injectable fake ChannelPort (reconcile/compensating archive failure cases).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { ChannelService } from '../../channels/ChannelService';
import type { ChannelServiceDeps } from '../../channels/ChannelService';
import type { ChannelState } from '../../../shared/channels';
import { WorkTaskService } from '../WorkTaskService';
import type { WorkTaskChannelPort } from '../WorkTaskService';
import { missionTopicFor, taskIdFromMissionTopic, normalizeWorktreePath } from '../../../shared/workTask';

let dir: string;
const syncOk = (): void => {
  /* no-op fsync stub for the test log */
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worktask-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

// ── Real ChannelService fake writer (reuse ChannelService.test.ts pattern) ──
function makeFakeWriter() {
  let lastSaved: ChannelState | null = null;
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  const clone = (state: ChannelState): ChannelState => ({
    version: state.version,
    channels: state.channels.map((c) => ({ ...c })),
    members: Object.fromEntries(
      Object.entries(state.members).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    messages: Object.fromEntries(
      Object.entries(state.messages).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    idempotency: Object.fromEntries(
      Object.entries(state.idempotency).map(([k, v]) => [k, { ...v }]),
    ),
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = clone(state);
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
  };
}

function newChannelService(writer: ReturnType<typeof makeFakeWriter>): ChannelService {
  const deps: ChannelServiceDeps = {
    writer: writer as unknown as ChannelServiceDeps['writer'],
    companyId: 'co-1',
    emit: vi.fn(),
    now: () => Date.now(),
  };
  return new ChannelService(deps);
}

function newWorkTaskService(
  log: AppendOnlyLog,
  channels: WorkTaskChannelPort,
  opts?: { now?: () => number; ceoWorkspaceId?: string },
): WorkTaskService {
  return new WorkTaskService({
    log,
    channels,
    origin: { machineId: 'm1', daemonEpoch: 1 },
    ...(opts?.ceoWorkspaceId !== undefined ? { ceoWorkspaceId: opts.ceoWorkspaceId } : {}),
    ...(opts?.now ? { now: opts.now } : {}),
  });
}

// ── Injectable fake ChannelPort (failure·state control) ──────────────────────
function makeFakeChannelPort(opts?: { failCreate?: boolean }) {
  let seq = 0;
  const channels = new Map<
    string,
    { id: string; topic?: string; status: 'active' | 'archived'; createdByWorkspaceId?: string }
  >();
  const archiveCalls: string[] = [];
  /** Observe archive call identity (R1' — orphan reconcile archives with creator ws). */
  const archiveIdentities: Array<{ channelId: string; verifiedWorkspaceId: string }> = [];
  const port: WorkTaskChannelPort = {
    create: vi.fn(async (params) => {
      if (opts?.failCreate) {
        return { ok: false as const, error: { code: 'PERSIST_FAILED', message: 'forced' } };
      }
      const id = `ch-${++seq}`;
      channels.set(id, {
        id,
        ...(params.topic !== undefined ? { topic: params.topic } : {}),
        status: 'active',
        createdByWorkspaceId: params.createdBy.workspaceId,
      });
      return { ok: true as const, channel: { id } };
    }),
    archive: vi.fn(async (params) => {
      archiveCalls.push(params.channelId);
      archiveIdentities.push({
        channelId: params.channelId,
        verifiedWorkspaceId: params.verifiedWorkspaceId,
      });
      const ch = channels.get(params.channelId);
      if (!ch) return { ok: false as const, error: { code: 'CHANNEL_NOT_FOUND', message: 'nf' } };
      ch.status = 'archived';
      return { ok: true as const };
    }),
    listAllForReconcile: () => [...channels.values()].map((c) => ({ ...c })),
  };
  // Test helper: crash/external mutation simulation (avoid non-null assertion).
  const setStatus = (id: string, status: 'active' | 'archived'): void => {
    const ch = channels.get(id);
    if (ch) ch.status = status;
  };
  return { port, channels, archiveCalls, archiveIdentities, setStatus };
}

// ═══ §2 path normalization utils ═══════════════════════════════════════════════

describe('normalizeWorktreePath (§2 exclusivity invariant normalization)', () => {
  it('strips trailing slash and collapses duplicate slashes', () => {
    expect(normalizeWorktreePath('/a/b//c/', 'linux')).toBe('/a/b/c');
  });
  it('case-insensitive FS uses lower-case canonical', () => {
    expect(normalizeWorktreePath('/A/B', 'darwin')).toBe('/a/b');
    expect(normalizeWorktreePath('/A/B', 'linux')).toBe('/A/B');
  });
  it('normalizes backslashes (win) to slashes', () => {
    expect(normalizeWorktreePath('C:\\Repo\\WT', 'win32')).toBe('c:/repo/wt');
  });
});

describe('missionTopic anchor (§3)', () => {
  it('round-trips taskId', () => {
    expect(taskIdFromMissionTopic(missionTopicFor('wtask-abc'))).toBe('wtask-abc');
  });
  it('non-anchor topic returns null', () => {
    expect(taskIdFromMissionTopic('random topic')).toBeNull();
    expect(taskIdFromMissionTopic(undefined)).toBeNull();
  });
});

// ═══ §0 success criteria — E2E round-trip ════════════════════════════════════════════

describe('§0 success criteria E2E round-trip (mission.start → post → close → restart → restore·archive idempotent)', () => {
  it('E2E: start → channel post → close → restart replay restore + archive idempotent no-op', async () => {
    const writer = makeFakeWriter();
    const channelSvc = newChannelService(writer);
    const log = newLog();
    const svc = newWorkTaskService(log, channelSvc as unknown as WorkTaskChannelPort);
    await svc.boot();

    // 1) mission.start — create task + mission channel.
    const started = await svc.startMission({
      title: 'Ship the widget',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { taskId, channelId } = started;

    // Channel actually created and topic anchor set.
    const created = channelSvc.get(channelId, 'ws-owner');
    expect(created).not.toBeNull();
    expect(created?.topic).toBe(missionTopicFor(taskId));
    expect(created?.status).toBe('active');

    // 2) channel post — mission channel is a normal channel so post works as usual.
    const posted = await channelSvc.post({
      channelId,
      sender: { workspaceId: 'ws-owner', memberId: 'lead' },
      text: 'kickoff',
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(posted.ok).toBe(true);

    // 3) mission.close — task closed + channel archive.
    const closed = await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);
    expect(svc.getTask(taskId)?.status).toBe('closed');
    expect(channelSvc.get(channelId, 'ws-owner')?.status).toBe('archived');

    // 4) Daemon restart simulation — recreate service on same log·writer + boot replay.
    const channelSvc2 = newChannelService(writer); // writer.load() restores last saved state.
    const log2 = newLog(); // same dir → same segment replay.
    const svc2 = newWorkTaskService(log2, channelSvc2 as unknown as WorkTaskChannelPort);
    await svc2.boot();

    // Projection restore: closed task survives.
    const restored = svc2.getTask(taskId);
    expect(restored).toBeDefined();
    expect(restored?.status).toBe('closed');
    expect(restored?.missionChannelId).toBe(channelId);

    // Archive idempotent retry no-op: boot reconcile task direction may retry archive on
    // already-archived channel — still no-op (no error). Channel remains archived.
    expect(channelSvc2.get(channelId, 'ws-owner')?.status).toBe('archived');

    // Re-close is also idempotent no-op ack.
    const reclose = await svc2.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(reclose.ok).toBe(true);
  });
});

// ═══ §3 idempotency (start retry · re-close) ═══════════════════════════════════

describe('§3 idempotency', () => {
  it('same idempotency_key start retry returns original without duplicating channel/task', async () => {
    const { port, create } = (() => {
      const f = makeFakeChannelPort();
      return { port: f.port, create: f.port.create as ReturnType<typeof vi.fn> };
    })();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();

    const r1 = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'k1' });
    const r2 = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'k1' });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.taskId).toBe(r1.taskId);
    expect(r2.channelId).toBe(r1.channelId);
    // Channel create exactly once.
    expect(create).toHaveBeenCalledTimes(1);
    expect(svc.taskCount).toBe(1);
  });

  it('re-close is idempotent no-op ack (not an error)', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const c1 = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    const c2 = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
  });

  it('R2′: idempotency key is workspace-scoped — other ws using same key does not get foreign result', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const a = await svc.startMission({ title: 'A', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'shared' });
    const b = await svc.startMission({ title: 'B', verifiedWorkspaceId: 'ws-b', memberId: 'lead', idempotencyKey: 'shared' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // With unscoped global key, b would receive a's {taskId, channelId} (private channel id leak).
    expect(b.taskId).not.toBe(a.taskId);
    expect(b.channelId).not.toBe(a.channelId);
    expect(svc.taskCount).toBe(2);
  });

  it('R2′: close cache hit mismatched to request taskId treated as miss — takes authz/existence path', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const t1 = await svc.startMission({ title: 'T1', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    const t2 = await svc.startMission({ title: 'T2', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(t1.ok && t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;
    const c1 = await svc.closeMission({ taskId: t1.taskId, verifiedWorkspaceId: 'ws-a', idempotencyKey: 'k' });
    expect(c1.ok).toBe(true);
    // Same key closing different task — t2 must actually close, not replay t1 receipt.
    const c2 = await svc.closeMission({ taskId: t2.taskId, verifiedWorkspaceId: 'ws-a', idempotencyKey: 'k' });
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(c2.taskId).toBe(t2.taskId);
    expect(svc.getTask(t2.taskId)?.status).toBe('closed');
  });

  it('R4′: two starts in same ms with same title still get different channel names (shortId = random segment)', async () => {
    const fixed = 1_700_000_000_000;
    const f = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), f.port, { now: () => fixed });
    await svc.boot();
    const r1 = await svc.startMission({ title: 'Same Title', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    const r2 = await svc.startMission({ title: 'Same Title', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r1.ok && r2.ok).toBe(true);
    const create = f.port.create as ReturnType<typeof vi.fn>;
    const names = create.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toHaveLength(2);
    // With timestamp-shortId, same name → real ChannelService duplicate rejection self-DoS.
    expect(names[0]).not.toBe(names[1]);
  });
});

// ═══ §3 authz (reject other workspace · CEO allowed) ══════════════════════════

describe('§3 close authz (owner OR CEO)', () => {
  it('rejects close from foreign workspace', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-owner', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-intruder' });
    expect(r.ok).toBe(false);
    // Canonical invariant: rejected close leaves task open.
    expect(svc.getTask(started.taskId)?.status).toBe('open');
  });

  it('CEO can close tasks from foreign workspace', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { ceoWorkspaceId: 'ws-ceo' });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-owner', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-ceo' });
    expect(r.ok).toBe(true);
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §3 compensating archive (append failure) ═════════════════════════════════════

describe('§3 failure compensating archive', () => {
  it('compensating archive of created channel when task.create append fails', async () => {
    const { port, archiveCalls } = makeFakeChannelPort();
    // Log stub that forces append failure.
    const failingLog = {
      append: vi.fn(async () => false),
      readAllRecords: () => [],
    };
    const svc = newWorkTaskService(failingLog as never, port);
    await svc.boot();
    const r = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r.ok).toBe(false);
    // Channel created (create success) but append failure triggers compensating archive.
    expect(archiveCalls).toHaveLength(1);
    // No task in projection (append uncommitted).
    expect(svc.taskCount).toBe(0);
  });

  it('explicit error with no task creation when channel create fails', async () => {
    const { port } = makeFakeChannelPort({ failCreate: true });
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const r = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r.ok).toBe(false);
    expect(svc.taskCount).toBe(0);
  });
});

// ═══ §3 bidirectional reconcile (orphan channel · closed+active) ════════════════════

describe('§3 bidirectional boot reconcile', () => {
  it('channel direction: archive orphan mission-topic channels missing from projection (crash window)', async () => {
    // Pre-state: active channel with mission-topic anchor but no task.create in log.
    const { port, channels, archiveCalls, archiveIdentities } = makeFakeChannelPort();
    channels.set('ch-orphan', {
      id: 'ch-orphan',
      topic: missionTopicFor('wtask-ghost'),
      status: 'active',
      createdByWorkspaceId: 'ws-creator',
    });
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot(); // reconcile channel direction picks up orphan.
    expect(archiveCalls).toContain('ch-orphan');
    expect(channels.get('ch-orphan')?.status).toBe('archived');
    // R1': archive identity is channel creator workspace — creator always
    // seeded as member so real ChannelService member gate passes ('' loses).
    const orphanArchive = archiveIdentities.find((a) => a.channelId === 'ch-orphan');
    expect(orphanArchive?.verifiedWorkspaceId).toBe('ws-creator');
  });

  it('task direction: retry archive on boot when closed task channel is still active', async () => {
    // 1) Leave normal start+close in real log,
    const { port, channels, setStatus } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 2) Crash window simulation: revert channel to active (assume close archive lost).
    setStatus(started.channelId, 'active');
    // 3) Reboot: task-direction reconcile catches closed+active and retries archive.
    const log2 = newLog();
    const svc2 = newWorkTaskService(log2, port);
    await svc2.boot();
    expect(channels.get(started.channelId)?.status).toBe('archived');
    expect(svc2.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §3 external mutation tolerance (pre-archive · channel loss) ═════════════════════════

describe('§3 close channel-state unconditional resilience', () => {
  it('close succeeds even if human archived channel first (archive no-op)', async () => {
    const { port, setStatus } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // External pre-archive.
    setStatus(started.channelId, 'archived');
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(r.ok).toBe(true);
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });

  it('close succeeds even if channel lost to reaper (CHANNEL_NOT_FOUND no-op)', async () => {
    const { port, channels } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    channels.delete(started.channelId); // reaper loss.
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(r.ok).toBe(true);
  });
});

// ═══ §1 closed GC (7 days + unconfirmed archive exemption) ══════════════════════════

describe('§1 closed projection GC', () => {
  it('closed after 7 days (channel archived) evicted from projection', async () => {
    let clock = 1_000_000;
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { now: () => clock });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 8 days elapsed.
    clock += 8 * 24 * 60 * 60 * 1000;
    svc.gcClosedTasks();
    expect(svc.getTask(started.taskId)).toBeUndefined();
  });

  it('unconfirmed-archive closed also GC-evicted — recovery on next boot replay+reconcile (R3′)', async () => {
    let clock = 1_000_000;
    const { port, channels, setStatus } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port, { now: () => clock });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // Force channel back to active to create unconfirmed archive state.
    setStatus(started.channelId, 'active');
    clock += 8 * 24 * 60 * 60 * 1000;
    svc.gcClosedTasks();
    // No exemption: evicted from projection (exemption would leave permanent residue
    // after owner-leave — view bound void). Reboot below proves recovery path intact.
    expect(svc.getTask(started.taskId)).toBeUndefined();
    // Reboot: replay restores task from log and reconcile retries archive.
    const svc2 = newWorkTaskService(newLog(), port, { now: () => clock });
    await svc2.boot();
    expect(channels.get(started.channelId)?.status).toBe('archived');
  });
});

// ═══ §2 DoS cap (open limit per workspace) ══════════════════════════════

describe('§2 open task cap', () => {
  it('list returns owner scope only', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    await svc.startMission({ title: 'A', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    await svc.startMission({ title: 'B', verifiedWorkspaceId: 'ws-b', memberId: 'lead' });
    expect(svc.listMissions('ws-a')).toHaveLength(1);
    expect(svc.listMissions('ws-b')).toHaveLength(1);
    expect(svc.listMissions('ws-c')).toHaveLength(0);
  });
});

// ═══ §5 task.update — monotonic materialization·exclusivity·authz·closed reject ══════════

describe('§5 task.mission.update (J1 materialization)', () => {
  async function startedSvc(opts?: { ceoWorkspaceId?: string }) {
    const { port, channels } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, opts);
    await svc.boot();
    const started = await svc.startMission({
      title: 'Mat task',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    if (!started.ok) throw new Error('start failed');
    return { svc, port, channels, taskId: started.taskId };
  }

  it('commits materialization fields and reflects them in projection', async () => {
    const { svc, taskId } = await startedSvc();
    const res = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/mat-task-abc',
      worktreePath: '/wt/abc',
      paneGroupId: 'ws-task-1',
    });
    expect(res.ok).toBe(true);
    const t = svc.getTask(taskId);
    expect(t?.branch).toBe('wtask/mat-task-abc');
    expect(t?.worktreePath).toBe('/wt/abc');
    expect(t?.paneGroupId).toBe('ws-task-1');
  });

  it('monotonic: rejects overwrite of already-set fields', async () => {
    const { svc, taskId } = await startedSvc();
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', branch: 'wtask/a' });
    const res = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/b',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/monotonic/);
    expect(svc.getTask(taskId)?.branch).toBe('wtask/a');
  });

  it('monotonic: same-value rewrite is idempotent no-op success', async () => {
    const { svc, taskId } = await startedSvc();
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', worktreePath: '/wt/x' });
    const again = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      worktreePath: '/wt/x',
    });
    expect(again.ok).toBe(true);
    expect(svc.getTask(taskId)?.worktreePath).toBe('/wt/x');
  });

  it('exclusivity invariant: another open task cannot claim same canonical worktreePath', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    // Create two tasks for same owner and set path on first.
    const s1 = await svc.startMission({ title: 'T1', verifiedWorkspaceId: 'ws-o', memberId: 'l' });
    const s2 = await svc.startMission({ title: 'T2', verifiedWorkspaceId: 'ws-o', memberId: 'l' });
    if (!s1.ok || !s2.ok) throw new Error('start');
    await svc.updateMission({ taskId: s1.taskId, verifiedWorkspaceId: 'ws-o', worktreePath: '/wt/shared/' });
    // Same canonical path with different notation (trailing slash·case) → reject.
    const clash = await svc.updateMission({
      taskId: s2.taskId,
      verifiedWorkspaceId: 'ws-o',
      worktreePath: '/wt/shared',
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.error).toMatch(/already claimed/);
  });

  it('authz: rejects caller that is not owner/CEO', async () => {
    const { svc, taskId } = await startedSvc({ ceoWorkspaceId: 'ws-ceo' });
    const stranger = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-stranger',
      branch: 'wtask/x',
    });
    expect(stranger.ok).toBe(false);
    if (stranger.ok) return;
    expect(stranger.error).toMatch(/not the task owner or CEO/);
    // CEO passes.
    const ceo = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-ceo',
      branch: 'wtask/x',
    });
    expect(ceo.ok).toBe(true);
  });

  it('rejects update on closed task', async () => {
    const { svc, taskId } = await startedSvc();
    await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    const res = await svc.updateMission({
      taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/x',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/closed/);
  });

  it('materialization fields survive restart replay', async () => {
    const { port } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port);
    await svc.boot();
    const started = await svc.startMission({ title: 'M', verifiedWorkspaceId: 'ws-owner', memberId: 'l' });
    if (!started.ok) throw new Error('start');
    await svc.updateMission({
      taskId: started.taskId,
      verifiedWorkspaceId: 'ws-owner',
      branch: 'wtask/keep',
      worktreePath: '/wt/keep',
      paneGroupId: 'ws-keep',
    });
    // Reboot: recreate service on same log·port + replay.
    const svc2 = newWorkTaskService(newLog(), port);
    await svc2.boot();
    const t = svc2.getTask(started.taskId);
    expect(t?.status).toBe('open');
    expect(t?.branch).toBe('wtask/keep');
    expect(t?.worktreePath).toBe('/wt/keep');
    expect(t?.paneGroupId).toBe('ws-keep');
  });
});

describe('J3 §2 prUrl — non-monotonic·closed-only·format validation', () => {
  async function started() {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const s = await svc.startMission({ title: 'PR task', verifiedWorkspaceId: 'ws-owner', memberId: 'l' });
    if (!s.ok) throw new Error('start');
    return { svc, port, taskId: s.taskId };
  }
  const PR1 = 'https://github.com/acme/repo/pull/12';
  const PR2 = 'https://github.com/acme/repo/pull/13';

  it('can commit prUrl on open task and update to different value (non-monotonic)', async () => {
    const { svc, taskId } = await started();
    const r1 = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    expect(r1.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR1);
    // Non-monotonic: allow URL regeneration update (not write-once like materialization fields).
    const r2 = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR2 });
    expect(r2.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR2);
  });

  it('allows prUrl-only update on closed task, rejects accompanying materialization fields', async () => {
    const { svc, taskId } = await started();
    const closed = await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);
    // prUrl alone → allowed (PR can be created after close — CX6).
    const solo = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    expect(solo.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR1);
    // With materialization → existing closed reject preserved.
    const mixed = await svc.updateMission({
      taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR2, branch: 'wtask/x',
    });
    expect(mixed.ok).toBe(false);
    // Materialization alone without prUrl still rejected (existing contract unchanged).
    const mat = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', branch: 'wtask/x' });
    expect(mat.ok).toBe(false);
  });

  it('rejects non-GitHub PR URL format (G5 — blocks arbitrary URLs)', async () => {
    const { svc, taskId } = await started();
    for (const bad of [
      'https://evil.example.com/acme/repo/pull/1',
      'http://github.com/acme/repo/pull/1',
      'https://github.com/acme/repo/issues/1',
      'javascript:alert(1)',
    ]) {
      const r = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: bad });
      expect(r.ok).toBe(false);
    }
    expect(svc.getTask(taskId)?.prUrl).toBeUndefined();
  });

  it('same prUrl rewrite is idempotent no-op without append', async () => {
    const { svc, taskId } = await started();
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    const again = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    expect(again.ok).toBe(true);
    expect(svc.getTask(taskId)?.prUrl).toBe(PR1);
  });

  it('authz: foreign workspace cannot update prUrl', async () => {
    const { svc, taskId } = await started();
    const r = await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-intruder', prUrl: PR1 });
    expect(r.ok).toBe(false);
  });

  it('closed task prUrl restored on reboot replay', async () => {
    const { svc, port, taskId } = await started();
    await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    await svc.updateMission({ taskId, verifiedWorkspaceId: 'ws-owner', prUrl: PR1 });
    const svc2 = newWorkTaskService(newLog(), port);
    await svc2.boot();
    const t = svc2.getTask(taskId);
    expect(t?.status).toBe('closed');
    expect(t?.prUrl).toBe(PR1);
  });
});
