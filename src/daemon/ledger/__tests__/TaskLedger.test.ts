import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger, getTaskLedgerPath, type LedgerTransition } from '../TaskLedger';
import {
  LEDGER_STATUSES,
  LEDGER_TRANSITIONS,
  LEDGER_TERMINAL_RETENTION_MS,
  LEDGER_GATE_TAIL_MAX_BYTES,
  type LedgerActor,
  type LedgerStatus,
} from '../../../shared/ledger';

let dir: string;
let clock = 1_000;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-ledger-'));
  clock = 1_000;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const BRAIN: LedgerActor = { kind: 'brain', workspaceId: 'ws-owner' };
const WORKER: LedgerActor = { kind: 'worker', workspaceId: 'ws-task' };
const SYSTEM: LedgerActor = { kind: 'system', workspaceId: 'daemon' };

function open(): TaskLedger {
  return new TaskLedger({ dir, now });
}

async function seed(ledger: TaskLedger, id = 'wtask-1') {
  return ledger.register({ id, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'lane' });
}

/** Drive an entry to `status` with system writes (authz-free), for matrix tests. */
async function driveTo(ledger: TaskLedger, id: string, status: LedgerStatus): Promise<void> {
  const route: Record<LedgerStatus, LedgerStatus[]> = {
    working: [],
    input_required: ['input_required'],
    review_requested: ['review_requested'],
    completed: ['review_requested', 'completed'],
    failed: ['failed'],
    cancelled: ['cancelled'],
  };
  for (const step of route[status]) {
    const cur = ledger.get(id)!;
    const actor: LedgerActor = step === 'completed' ? BRAIN : SYSTEM;
    const res = await ledger.update({
      id,
      status: step,
      actor,
      expectedRev: cur.rev,
      ...(step === 'completed' ? { gate: { exitCode: 0, tail: '', at: now(), command: 'gate' } } : {}),
    });
    if (!res.ok) throw new Error(`driveTo ${status} failed at ${step}: ${res.message}`);
  }
}

describe('TaskLedger — append / replay / truncation', () => {
  it('registers working, persists, and replays after restart (data-dir scoped)', async () => {
    const a = open();
    const entry = await seed(a);
    expect(entry.status).toBe('working');
    expect(entry.rev).toBe(1);
    await a.flush();
    expect(fs.existsSync(getTaskLedgerPath(dir))).toBe(true);

    const b = open();
    expect(b.get('wtask-1')).toEqual(entry);
    // A different data dir sees nothing — WMUX_DATA_SUFFIX isolation.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-ledger-other-'));
    try {
      expect(new TaskLedger({ dir: other, now }).list()).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('register is idempotent — a second call returns the live entry and writes nothing', async () => {
    const a = open();
    const first = await seed(a);
    await a.update({ id: 'wtask-1', status: 'input_required', actor: WORKER, expectedRev: 1 });
    const again = await seed(a);
    expect(again.status).toBe('input_required');
    expect(again).not.toEqual(first);
    await a.flush();
    const lines = fs.readFileSync(getTaskLedgerPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('ignores a truncated last line on replay and keeps every whole line', async () => {
    const a = open();
    await seed(a);
    await a.update({ id: 'wtask-1', status: 'review_requested', actor: WORKER, expectedRev: 1, summary: 'done' });
    await a.flush();
    fs.appendFileSync(getTaskLedgerPath(dir), '{"op":"entry","entry":{"id":"wtask-1","status":"fail', 'utf8');
    const b = open();
    expect(b.skippedLines).toBe(1);
    expect(b.get('wtask-1')?.status).toBe('review_requested');
    expect(b.get('wtask-1')?.summary).toBe('done');
  });

  it('rotates past the byte cap with a snapshot line the fresh file replays from', async () => {
    const a = new TaskLedger({ dir, now, rotateBytes: 600 });
    await seed(a, 'wtask-1');
    await seed(a, 'wtask-2');
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-owner', seq: 7, payload: { kind: 'agent.stop' } });
    await seed(a, 'wtask-3');
    await a.flush();
    expect(fs.existsSync(`${getTaskLedgerPath(dir)}.1`)).toBe(true);
    const fresh = fs.readFileSync(getTaskLedgerPath(dir), 'utf8').trim().split('\n');
    expect(JSON.parse(fresh[0]).op).toBe('snapshot');
    const b = open();
    expect(b.list().map((e) => e.id).sort()).toEqual(['wtask-1', 'wtask-2', 'wtask-3']);
    expect(b.peekOrphanedEvents('ws-owner')).toHaveLength(1);
  });

  it('prunes terminal entries past the retention window on load', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'cancelled');
    await a.flush();
    clock += LEDGER_TERMINAL_RETENTION_MS + 1;
    expect(open().get('wtask-1')).toBeNull();
  });
});

describe('TaskLedger — transition matrix', () => {
  for (const from of LEDGER_STATUSES) {
    for (const to of LEDGER_STATUSES) {
      const allowed = from === to || LEDGER_TRANSITIONS[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'accepted' : 'refused'} (system actor)`, async () => {
        const a = open();
        await seed(a);
        await driveTo(a, 'wtask-1', from);
        const cur = a.get('wtask-1')!;
        const res = await a.update({
          id: 'wtask-1',
          status: to,
          actor: to === 'completed' ? BRAIN : SYSTEM,
          expectedRev: cur.rev,
          gate: { exitCode: 0, tail: '', at: now(), command: 'gate' },
        });
        expect(res.ok).toBe(allowed);
        if (!res.ok) expect(res.error).toBe('illegal_transition');
        if (res.ok && from === to) expect(res.noop).toBe(true);
      });
    }
  }

  it('refuses an unknown status and a stale rev', async () => {
    const a = open();
    await seed(a);
    const bad = await a.update({ id: 'wtask-1', status: 'done', actor: SYSTEM, expectedRev: 1 });
    expect(bad).toMatchObject({ ok: false, error: 'invalid_status' });
    const stale = await a.update({ id: 'wtask-1', status: 'failed', actor: SYSTEM, expectedRev: 0 });
    expect(stale).toMatchObject({ ok: false, error: 'stale_rev' });
    const missing = await a.update({ id: 'nope', status: 'failed', actor: SYSTEM, expectedRev: 1 });
    expect(missing).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('completed needs a passing gate unless forced with a reason, and only a brain may set it', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'review_requested');
    const noGate = await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2 });
    expect(noGate).toMatchObject({ ok: false, error: 'gate_required' });
    const failedGate = await a.update({
      id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2,
      gate: { exitCode: 1, tail: 'boom', at: now(), command: 'gate' },
    });
    expect(failedGate).toMatchObject({ ok: false, error: 'gate_required' });
    const nullGate = await a.update({
      id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2,
      gate: { exitCode: null, tail: '', at: now(), command: 'gate' },
    });
    expect(nullGate).toMatchObject({ ok: false, error: 'gate_required' });
    const forcedNoReason = await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2, force: true });
    expect(forcedNoReason).toMatchObject({ ok: false, error: 'force_reason_required' });
    const systemComplete = await a.update({
      id: 'wtask-1', status: 'completed', actor: SYSTEM, expectedRev: 2,
      gate: { exitCode: 0, tail: '', at: now(), command: 'gate' },
    });
    expect(systemComplete).toMatchObject({ ok: false, error: 'not_authorized' });
    const forced = await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2, force: true, reason: 'owner waived' });
    expect(forced.ok).toBe(true);
    expect(a.get('wtask-1')?.summary).toContain('[forced: owner waived]');
  });

  it('bounds the recorded gate tail to LEDGER_GATE_TAIL_MAX_BYTES, keeping the end', async () => {
    const a = open();
    await seed(a);
    const tail = `${'x'.repeat(LEDGER_GATE_TAIL_MAX_BYTES)}END`;
    const res = await a.update({
      id: 'wtask-1', status: 'review_requested', actor: SYSTEM, expectedRev: 1,
      gate: { exitCode: 0, tail, at: now(), command: 'gate' },
    });
    expect(res.ok).toBe(true);
    const stored = a.get('wtask-1')!.gate!.tail;
    expect(Buffer.byteLength(stored)).toBe(LEDGER_GATE_TAIL_MAX_BYTES);
    expect(stored.endsWith('END')).toBe(true);
  });
});

describe('TaskLedger — authz matrix', () => {
  const cases: Array<{ actor: LedgerActor; status: LedgerStatus; ok: boolean; why: string }> = [
    { actor: WORKER, status: 'review_requested', ok: true, why: 'worker on its own task, worker-settable' },
    { actor: WORKER, status: 'cancelled', ok: false, why: 'worker may not cancel' },
    { actor: { kind: 'worker', workspaceId: 'ws-other' }, status: 'failed', ok: false, why: 'worker on someone else\'s task' },
    { actor: BRAIN, status: 'cancelled', ok: true, why: 'owning brain' },
    { actor: { kind: 'brain', workspaceId: 'ws-stranger' }, status: 'cancelled', ok: false, why: 'non-owning brain' },
    { actor: SYSTEM, status: 'failed', ok: true, why: 'daemon' },
  ];
  for (const c of cases) {
    it(`${c.actor.kind}@${c.actor.workspaceId} → ${c.status}: ${c.ok ? 'allowed' : 'refused'} (${c.why})`, async () => {
      const a = open();
      await seed(a);
      const res = await a.update({ id: 'wtask-1', status: c.status, actor: c.actor, expectedRev: 1 });
      expect(res.ok).toBe(c.ok);
      if (!res.ok) expect(res.error).toBe('not_authorized');
    });
  }
});

describe('TaskLedger — close, orphans, listeners', () => {
  it('closeTask forces cancelled unless already completed', async () => {
    const a = open();
    await seed(a, 'wtask-1');
    await seed(a, 'wtask-2');
    await driveTo(a, 'wtask-2', 'completed');
    expect((await a.closeTask('wtask-1'))?.status).toBe('cancelled');
    expect((await a.closeTask('wtask-2'))?.status).toBe('completed');
    expect(await a.closeTask('wtask-9')).toBeNull();
  });

  it('parks orphaned events per owner, drains them in seq order once, and survives restart', async () => {
    const a = open();
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-owner', seq: 12, payload: { kind: 'agent.stop' } });
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-owner', seq: 9, payload: { kind: 'agent.awaiting_input' } });
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-else', seq: 10, payload: {} });
    await a.flush();
    const b = open();
    const drained = b.takeOrphanedEvents('ws-owner');
    expect(drained.map((o) => o.seq)).toEqual([9, 12]);
    expect(b.takeOrphanedEvents('ws-owner')).toEqual([]);
    await b.flush();
    const c = open();
    expect(c.peekOrphanedEvents('ws-owner')).toEqual([]);
    expect(c.peekOrphanedEvents('ws-else')).toHaveLength(1);
  });

  it('emits one transition per accepted write, none for refusals or no-ops', async () => {
    const a = open();
    const seen: LedgerTransition[] = [];
    a.onTransition((t) => seen.push(t));
    await seed(a);
    await a.update({ id: 'wtask-1', status: 'working', actor: WORKER, expectedRev: 1 });
    await a.update({ id: 'wtask-1', status: 'cancelled', actor: WORKER, expectedRev: 1 });
    await a.update({ id: 'wtask-1', status: 'review_requested', actor: WORKER, expectedRev: 1, summary: 'gate green' });
    expect(seen.map((t) => `${t.from}→${t.to}`)).toEqual(['null→working', 'working→review_requested']);
    expect(seen[1].summary).toBe('gate green');
    expect(a.list({ ownerWorkspaceId: 'ws-owner', openOnly: true })).toHaveLength(1);
    expect(a.list({ taskWorkspaceId: 'ws-nope' })).toHaveLength(0);
    expect(a.findByTaskWorkspace('ws-task')?.id).toBe('wtask-1');
  });
});
