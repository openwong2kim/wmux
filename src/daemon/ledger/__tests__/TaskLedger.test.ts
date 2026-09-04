import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TaskLedger,
  getTaskLedgerPath,
  truncateTail,
  truncateHead,
  LEDGER_SUMMARY_MAX_BYTES,
  LEDGER_GATE_COMMAND_MAX_BYTES,
  type LedgerTransition,
} from '../TaskLedger';
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
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const BRAIN: LedgerActor = { kind: 'brain', workspaceId: 'ws-owner' };
const WORKER: LedgerActor = { kind: 'worker', workspaceId: 'ws-task' };
const SYSTEM: LedgerActor = { kind: 'system', workspaceId: 'daemon' };
const PASS = { exitCode: 0, tail: 'ok', at: 1, command: 'npm test' };

function open(extra: Partial<ConstructorParameters<typeof TaskLedger>[0]> = {}): TaskLedger {
  return new TaskLedger({ dir, now, ...extra });
}

async function seed(ledger: TaskLedger, id = 'wtask-1') {
  return ledger.register({ id, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'lane' });
}

/** Drive an entry to `status` with system writes (authz-free), for matrix tests.
 *  `completed` goes through a system-recorded gate, as production does. */
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
    if (step === 'completed') {
      const g = await ledger.recordGate(id, PASS);
      if (!g.ok) throw new Error(`recordGate failed: ${g.message}`);
    }
    const cur = ledger.get(id)!;
    const res = await ledger.update({ id, status: step, actor: step === 'completed' ? BRAIN : SYSTEM, expectedRev: cur.rev });
    if (!res.ok) throw new Error(`driveTo ${status} failed at ${step}: ${res.message}`);
  }
}

/** Bounce an entry working ↔ input_required `n` times: the log grows, the
 *  snapshot does not — the shape that makes rotation worthwhile. */
async function churn(ledger: TaskLedger, id: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const cur = ledger.get(id)!;
    const res = await ledger.update({ id, status: cur.status === 'working' ? 'input_required' : 'working', actor: SYSTEM, expectedRev: cur.rev });
    if (!res.ok) throw new Error(res.message);
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

  it('a failed disk write commits nothing: ok:false, memory unchanged, no listener fired', async () => {
    const a = open();
    await seed(a);
    const seen: LedgerTransition[] = [];
    a.onTransition((t) => seen.push(t));
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC'));
    const res = await a.update({ id: 'wtask-1', status: 'review_requested', actor: WORKER, expectedRev: 1 });
    expect(res).toMatchObject({ ok: false, error: 'persist_failed' });
    expect(a.get('wtask-1')?.status).toBe('working');
    expect(a.get('wtask-1')?.rev).toBe(1);
    expect(seen).toEqual([]);
    // The ledger keeps working after the failure.
    const retry = await a.update({ id: 'wtask-1', status: 'review_requested', actor: WORKER, expectedRev: 1 });
    expect(retry.ok).toBe(true);
    expect(seen).toHaveLength(1);
    vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(a.register({ id: 'wtask-2', taskWorkspaceId: 't', ownerWorkspaceId: 'o', title: 'x' })).rejects.toThrow('ENOSPC');
    expect(a.get('wtask-2')).toBeNull();
  });

  it('serializes concurrent updates so only one of two writers with the same rev wins', async () => {
    const a = open();
    await seed(a);
    const [x, y] = await Promise.all([
      a.update({ id: 'wtask-1', status: 'review_requested', actor: WORKER, expectedRev: 1 }),
      a.update({ id: 'wtask-1', status: 'failed', actor: WORKER, expectedRev: 1 }),
    ]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect(a.get('wtask-1')?.rev).toBe(2);
  });

  it('rotates past the byte cap: old log linked to .1 first, snapshot renamed over live, fresh file replays', async () => {
    const a = open({ rotateBytes: 1200 });
    await seed(a, 'wtask-1');
    await seed(a, 'wtask-2');
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-owner', seq: 7, payload: { kind: 'agent.stop' } });
    await seed(a, 'wtask-3');
    await churn(a, 'wtask-1', 6);
    await a.flush();
    expect(fs.existsSync(`${getTaskLedgerPath(dir)}.1`)).toBe(true);
    const fresh = fs.readFileSync(getTaskLedgerPath(dir), 'utf8').trim().split('\n');
    expect(JSON.parse(fresh[0]).op).toBe('snapshot');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    const b = open();
    expect(b.recoveredFromRotated).toBe(false);
    expect(b.list().map((e) => e.id).sort()).toEqual(['wtask-1', 'wtask-2', 'wtask-3']);
    expect(b.peekOrphanedEvents('ws-owner')).toHaveLength(1);
  });

  it('recovers from .1 when the live file is missing', async () => {
    const a = open({ rotateBytes: 1200 });
    await seed(a, 'wtask-1');
    await seed(a, 'wtask-2');
    await seed(a, 'wtask-3');
    await churn(a, 'wtask-1', 6);
    await a.flush();
    expect(fs.existsSync(`${getTaskLedgerPath(dir)}.1`)).toBe(true);
    fs.rmSync(getTaskLedgerPath(dir));
    const b = open();
    expect(b.recoveredFromRotated).toBe(true);
    expect(b.list().map((e) => e.id).sort()).toEqual(['wtask-1', 'wtask-2', 'wtask-3']);
  });

  it('refuses to rotate when the snapshot itself would exceed the cap (no recursive rotation)', async () => {
    const logs: string[] = [];
    const a = open({ rotateBytes: 300, log: (l) => logs.push(l) });
    await seed(a, 'wtask-1');
    await seed(a, 'wtask-2');
    await a.flush();
    expect(fs.existsSync(`${getTaskLedgerPath(dir)}.1`)).toBe(false);
    expect(logs.some((l) => l.includes('snapshot would exceed'))).toBe(true);
    expect(open().list()).toHaveLength(2);
  });

  it('prunes terminal entries past the retention window on load and tells the host', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'cancelled');
    await a.flush();
    clock += LEDGER_TERMINAL_RETENTION_MS + 1;
    const pruned: string[] = [];
    expect(open({ onPrune: (id) => pruned.push(id) }).get('wtask-1')).toBeNull();
    expect(pruned).toEqual(['wtask-1']);
  });

  it('validates snapshot orphans on replay like orphaned_event lines', async () => {
    fs.writeFileSync(
      getTaskLedgerPath(dir),
      `${JSON.stringify({ op: 'snapshot', entries: [], orphans: [{ ownerWorkspaceId: 'ws', seq: 1, payload: {} }, { bogus: true }, 'x', null] })}\n`,
      'utf8',
    );
    expect(open().peekOrphanedEvents('ws')).toHaveLength(1);
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
        if (to === 'completed' && allowed && from !== to) await a.recordGate('wtask-1', PASS);
        const cur = a.get('wtask-1')!;
        const res = await a.update({ id: 'wtask-1', status: to, actor: to === 'completed' ? BRAIN : SYSTEM, expectedRev: cur.rev });
        expect(res.ok).toBe(allowed);
        if (!res.ok) expect(res.error).toBe('illegal_transition');
        if (res.ok && from === to) expect(res.noop).toBe(true);
      });
    }
  }

  // Wave 3, finding 14: the brain tried working → completed and was told only
  // that it was wrong. The message now names the moves it CAN make from here.
  it('an illegal transition names the legal moves from the current status', async () => {
    const a = open();
    await seed(a);
    const res = await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 1 });
    expect(res).toMatchObject({ ok: false, error: 'illegal_transition' });
    if (res.ok) throw new Error('unreachable');
    expect(res.message).toContain('working → completed is not an allowed transition');
    expect(res.message).toContain('allowed from working for brain: input_required, review_requested, failed, cancelled');
  });

  // The list must not advertise a move the authorization check refuses one line
  // later: a worker may not cancel its own task, so `cancelled` is not offered
  // even though the transition table reaches it.
  it('the legal moves are filtered to what the CALLING actor may set', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'failed');
    const cur = a.get('wtask-1')!;
    const res = await a.update({ id: 'wtask-1', status: 'review_requested', actor: WORKER, expectedRev: cur.rev });
    expect(res).toMatchObject({ ok: false, error: 'illegal_transition' });
    if (res.ok) throw new Error('unreachable');
    // The table says failed → working | cancelled; a worker may only do the first.
    expect(res.message).toContain('allowed from failed for worker: working');
    expect(res.message).not.toContain('cancelled');
  });

  it('a terminal status says so instead of listing nothing', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'cancelled');
    const cur = a.get('wtask-1')!;
    const res = await a.update({ id: 'wtask-1', status: 'working', actor: SYSTEM, expectedRev: cur.rev });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.message).toContain('allowed from cancelled for system: none — terminal');
  });

  it('refuses an unknown status and a stale rev', async () => {
    const a = open();
    await seed(a);
    expect(await a.update({ id: 'wtask-1', status: 'done', actor: SYSTEM, expectedRev: 1 })).toMatchObject({ ok: false, error: 'invalid_status' });
    expect(await a.update({ id: 'wtask-1', status: 'failed', actor: SYSTEM, expectedRev: 0 })).toMatchObject({ ok: false, error: 'stale_rev' });
    expect(await a.update({ id: 'nope', status: 'failed', actor: SYSTEM, expectedRev: 1 })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('a no-gate system record keeps its skipped label in the persisted entry, and a plain record carries none', async () => {
    const a = open();
    await seed(a);
    await a.recordGate('wtask-1', { ...PASS, command: 'none', skipped: 'no_gate_command' });
    expect(a.get('wtask-1')!.gate).toMatchObject({ exitCode: 0, command: 'none', skipped: 'no_gate_command', recordedBy: 'system' });
    await a.recordGate('wtask-1', PASS);
    expect(a.get('wtask-1')!.gate).not.toHaveProperty('skipped');
  });

  it('completed needs a SYSTEM-recorded passing gate unless forced with a reason, and only a brain may set it', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'review_requested');
    expect(await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2 })).toMatchObject({ ok: false, error: 'gate_required' });
    // Only the gate runner may record a gate.
    expect(await a.recordGate('wtask-1', PASS, BRAIN)).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(await a.recordGate('wtask-1', PASS, WORKER)).toMatchObject({ ok: false, error: 'not_authorized' });
    // A failing / signalled gate does not pass.
    await a.recordGate('wtask-1', { ...PASS, exitCode: 1 });
    expect(await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 3 })).toMatchObject({ ok: false, error: 'gate_required' });
    await a.recordGate('wtask-1', { ...PASS, exitCode: null });
    expect(await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 4 })).toMatchObject({ ok: false, error: 'gate_required' });
    expect(await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 4, force: true })).toMatchObject({ ok: false, error: 'force_reason_required' });
    await a.recordGate('wtask-1', PASS);
    expect(a.get('wtask-1')?.gate?.recordedBy).toBe('system');
    expect(await a.update({ id: 'wtask-1', status: 'completed', actor: SYSTEM, expectedRev: 5 })).toMatchObject({ ok: false, error: 'not_authorized' });
    const done = await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 5 });
    expect(done.ok).toBe(true);
  });

  it('a gate that was never recorded by the system does not count even if present on a replayed entry', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'review_requested');
    await a.flush();
    // Forge a passing gate line without provenance, as a tampered log would.
    const forged = { ...a.get('wtask-1')!, rev: 3, gate: { exitCode: 0, tail: '', at: 1, command: 'x' } };
    fs.appendFileSync(getTaskLedgerPath(dir), `${JSON.stringify({ op: 'entry', entry: forged })}\n`, 'utf8');
    const b = open();
    expect(await b.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 3 })).toMatchObject({ ok: false, error: 'gate_required' });
  });

  it('forced completion logs the reason on the entry', async () => {
    const a = open();
    await seed(a);
    await driveTo(a, 'wtask-1', 'review_requested');
    const forced = await a.update({ id: 'wtask-1', status: 'completed', actor: BRAIN, expectedRev: 2, force: true, reason: 'owner waived' });
    expect(forced.ok).toBe(true);
    expect(a.get('wtask-1')?.summary).toContain('[forced: owner waived]');
  });

  it('clamps the gate tail, the gate command and the summary by bytes', async () => {
    const a = open();
    await seed(a);
    const tail = `${'x'.repeat(LEDGER_GATE_TAIL_MAX_BYTES)}END`;
    await a.recordGate('wtask-1', { ...PASS, tail, command: 'c'.repeat(LEDGER_GATE_COMMAND_MAX_BYTES + 50) });
    const gate = a.get('wtask-1')!.gate!;
    expect(Buffer.byteLength(gate.tail)).toBe(LEDGER_GATE_TAIL_MAX_BYTES);
    expect(gate.tail.endsWith('END')).toBe(true);
    expect(Buffer.byteLength(gate.command)).toBe(LEDGER_GATE_COMMAND_MAX_BYTES);
    const res = await a.update({ id: 'wtask-1', status: 'review_requested', actor: SYSTEM, expectedRev: 2, summary: 's'.repeat(LEDGER_SUMMARY_MAX_BYTES * 2) });
    expect(res.ok).toBe(true);
    expect(Buffer.byteLength(a.get('wtask-1')!.summary!)).toBe(LEDGER_SUMMARY_MAX_BYTES);
  });
});

describe('truncateTail / truncateHead — UTF-8 safe', () => {
  it('never splits a multibyte sequence', () => {
    const text = `ab${'한'.repeat(10)}`; // 한 = 3 bytes
    const tail = truncateTail(text, 10); // 10 bytes lands inside a 한
    expect(tail).toBe('한한한');
    expect(Buffer.byteLength(tail)).toBe(9);
    const head = truncateHead(text, 4); // a b + 2 bytes of 한
    expect(head).toBe('ab');
    expect(truncateTail(text, 1000)).toBe(text);
    expect(truncateHead('😀😀', 5)).toBe('😀');
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

  it('findOpenByTaskWorkspace ignores finished tasks', async () => {
    const a = open();
    await seed(a);
    expect(a.findOpenByTaskWorkspace('ws-task')?.id).toBe('wtask-1');
    await a.closeTask('wtask-1');
    expect(a.findOpenByTaskWorkspace('ws-task')).toBeNull();
    expect(a.findByTaskWorkspace('ws-task')?.id).toBe('wtask-1');
  });

  it('parks orphaned events per owner; peek is non-destructive, ack releases up to a seq, both survive restart', async () => {
    const a = open();
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-owner', seq: 12, payload: { kind: 'agent.stop' } });
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-owner', seq: 9, payload: { kind: 'agent.awaiting_input' } });
    await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws-else', seq: 10, payload: {} });
    const b = open();
    expect(b.peekOrphanedEvents('ws-owner').map((o) => o.seq)).toEqual([9, 12]);
    expect(b.peekOrphanedEvents('ws-owner').map((o) => o.seq)).toEqual([9, 12]);
    await b.ackOrphanedEvents('ws-owner', 9);
    expect(b.peekOrphanedEvents('ws-owner').map((o) => o.seq)).toEqual([12]);
    const c = open();
    expect(c.peekOrphanedEvents('ws-owner').map((o) => o.seq)).toEqual([12]);
    expect(c.peekOrphanedEvents('ws-else')).toHaveLength(1);
  });

  it('bounds the orphan backlog by count and by bytes, dropping the oldest and logging it', async () => {
    const logs: string[] = [];
    const a = open({ orphanMaxCount: 3, log: (l) => logs.push(l) });
    for (let seq = 1; seq <= 5; seq++) await a.recordOrphanedEvent({ ownerWorkspaceId: 'ws', seq, payload: {} });
    expect(a.peekOrphanedEvents('ws').map((o) => o.seq)).toEqual([3, 4, 5]);
    expect(logs.some((l) => l.includes('orphan backlog over cap'))).toBe(true);
    const b = open({ orphanMaxBytes: 200 });
    await b.recordOrphanedEvent({ ownerWorkspaceId: 'ws2', seq: 1, payload: { pad: 'x'.repeat(150) } });
    await b.recordOrphanedEvent({ ownerWorkspaceId: 'ws2', seq: 2, payload: { pad: 'y'.repeat(150) } });
    expect(b.peekOrphanedEvents('ws2').map((o) => o.seq)).toEqual([2]);
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
  });
});
