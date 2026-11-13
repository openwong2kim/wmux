// A task another PC runs (fanout_start with `pc`) has a ledger row with a
// `remote` record and a `remote:<spawnId>` task workspace. The field is
// additive: a row without it loads as before, and a reader from before it
// existed (4.15.0) still takes a row that has it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger, copyRemote, getTaskLedgerPath } from '../TaskLedger';
import { isLedgerStatus, isRemoteTask, remoteTaskWorkspaceId, type LedgerActor, type LedgerRemote } from '../../../shared/ledger';

let dir: string;
const now = () => 1_000;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-ledger-remote-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const open = () => new TaskLedger({ dir, now });
const SYSTEM: LedgerActor = { kind: 'system', workspaceId: 'daemon' };
const SPAWN = 'sp-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab';
const REMOTE: LedgerRemote = { hostId: '0f1e2d3c-4b5a-4968-8776-655443322110', pc: 'box', spawnId: SPAWN, root: 'repo', state: 'sent' };

const registerRemote = (ledger: TaskLedger, remote: LedgerRemote = REMOTE) =>
  ledger.register({ id: 'wtask-r1', taskWorkspaceId: remoteTaskWorkspaceId(remote.spawnId), ownerWorkspaceId: 'ws-owner', title: 'on the box', remote });

/** TaskLedger.ts isEntryShape as of v4.15.0, verbatim: what an older build accepts on load. */
function isEntryShape4150(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.taskWorkspaceId === 'string' &&
    typeof e.ownerWorkspaceId === 'string' &&
    isLedgerStatus(e.status) &&
    typeof e.rev === 'number' &&
    typeof e.updatedAt === 'number'
  );
}

describe('a remote task row', () => {
  it('is registered with its remote record and survives a restart', async () => {
    const a = open();
    const entry = await registerRemote(a);
    expect(entry).toMatchObject({ taskWorkspaceId: `remote:${SPAWN}`, status: 'working', remote: REMOTE });
    expect(isRemoteTask(entry)).toBe(true);
    await a.flush();
    expect(open().get('wtask-r1')).toEqual(entry);
  });

  it('refuses a remote record that is not valid, or a workspace id that does not name its spawn', async () => {
    const a = open();
    await expect(registerRemote(a, { ...REMOTE, hostId: 'not-a-host' })).rejects.toThrow(/not valid/);
    await expect(a.register({ id: 'wtask-r2', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'x', remote: REMOTE })).rejects.toThrow(/not valid/);
  });

  it('a row without it (every row before) loads as before', async () => {
    const a = open();
    const local = await a.register({ id: 'wtask-l1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'local' });
    await a.flush();
    const b = open();
    expect(b.get('wtask-l1')).toEqual(local);
    expect(b.get('wtask-l1')).not.toHaveProperty('remote');
    expect(isRemoteTask(local)).toBe(false);
  });

  it('a 4.15.0 reader takes the stored row (it ignores the field it does not know)', async () => {
    const a = open();
    await registerRemote(a);
    await a.flush();
    const lines = fs.readFileSync(getTaskLedgerPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op: string; entry?: unknown });
    const stored = lines.filter((l) => l.op === 'entry').map((l) => l.entry);
    expect(stored.length).toBeGreaterThan(0);
    for (const e of stored) expect(isEntryShape4150(e)).toBe(true);
  });

  it('drops an unreadable remote record on load and keeps the row, still marked remote by its workspace id', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const row = { schemaVersion: 1, id: 'wtask-r3', taskWorkspaceId: `remote:${SPAWN}`, ownerWorkspaceId: 'ws-owner', title: 'x', status: 'working', rev: 1, updatedAt: 1, updatedBy: SYSTEM, remote: { hostId: 'junk' } };
    fs.writeFileSync(getTaskLedgerPath(dir), `${JSON.stringify({ op: 'entry', entry: row })}\n`);
    const loaded = open().get('wtask-r3');
    expect(loaded).not.toBeNull();
    expect(loaded).not.toHaveProperty('remote');
    expect(isRemoteTask(loaded!)).toBe(true);
  });

  it('cannot be moved to a workspace here', async () => {
    const a = open();
    const entry = await registerRemote(a);
    const res = await a.rebindTaskWorkspace({ id: entry.id, taskWorkspaceId: 'ws-new', actor: SYSTEM, expectedRev: entry.rev });
    expect(res).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(a.get(entry.id)?.taskWorkspaceId).toBe(`remote:${SPAWN}`);
  });

  it('takes what this PC learns of it, as a system write that bumps the rev', async () => {
    const a = open();
    const entry = await registerRemote(a);
    const linkId = '7d1e2f30-4b5c-4d6e-9f80-123456789abc';
    const branchOnPc = 'wmux/remote/sp-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab';
    const started = await a.updateRemote(entry.id, { state: 'started', linkId, branchOnPc });
    expect(started).toMatchObject({ rev: entry.rev + 1, remote: { ...REMOTE, state: 'started', linkId, branchOnPc } });
    expect(started?.status).toBe('working');
    // The same patch again writes nothing.
    expect((await a.updateRemote(entry.id, { state: 'started' }))?.rev).toBe(entry.rev + 1);
    await expect(a.updateRemote(entry.id, { state: 'gone' as never })).rejects.toThrow(/not be valid/);
    const local = await a.register({ id: 'wtask-l2', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'local' });
    expect(await a.updateRemote(local.id, { withdrawn: true })).toBeNull();
  });

  it('takes a new text for an input_required row as it was read, with no status change and no transition; the same text writes nothing', async () => {
    const a = open();
    const entry = await registerRemote(a);
    const first = 'the agent on box waits on a permission question';
    const reply = 'the agent on box waits for your reply';
    expect(entry.status).toBe('working');
    // Not input_required: only the patch goes.
    const working = await a.updateRemote(entry.id, { goneSeenAt: 4 }, { summary: reply, expectedRev: entry.rev });
    expect(working).toMatchObject({ rev: entry.rev + 1, status: 'working', remote: { goneSeenAt: 4 } });
    expect(working!.summary).toBe(entry.summary);
    const waiting = await a.update({ id: entry.id, status: 'input_required', actor: { kind: 'system', workspaceId: 'main' }, expectedRev: working!.rev, summary: first });
    expect(waiting.ok).toBe(true);
    const read = a.get(entry.id)!;
    const moves: unknown[] = [];
    a.onTransition((t) => moves.push(t));
    // A stale rev: the patch goes, the text does not.
    const stale = await a.updateRemote(entry.id, { goneSeenAt: 5 }, { summary: reply, expectedRev: read.rev - 1 });
    expect(stale).toMatchObject({ rev: read.rev + 1, summary: first, remote: { goneSeenAt: 5 } });
    const told = await a.updateRemote(entry.id, {}, { summary: reply, expectedRev: stale!.rev });
    expect(told).toMatchObject({ rev: stale!.rev + 1, status: 'input_required', summary: reply });
    expect((await a.updateRemote(entry.id, {}, { summary: reply, expectedRev: told!.rev }))?.rev).toBe(told!.rev);
    expect(moves).toEqual([]);
    // A closed row takes no text.
    const closed = await a.closeTask(entry.id);
    expect(await a.updateRemote(entry.id, {}, { summary: first, expectedRev: closed!.rev })).toMatchObject({ rev: closed!.rev, summary: closed!.summary });
  });

  it('copyRemote keeps only the fields it knows, each checked', () => {
    expect(copyRemote({ ...REMOTE, extra: 1, withdrawn: 'yes', revoked: 1, branchOnPc: 'main' })).toEqual(REMOTE);
    expect(copyRemote({ ...REMOTE, spawnId: 'sp-x' })).toBeNull();
  });
});
