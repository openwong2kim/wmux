import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import { registerLedgerRpc } from '../ledger.rpc';
import type { RpcContext } from '../../../../shared/rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

let dir: string;
let ledger: TaskLedger;
let handlers: Map<string, Handler>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ledger-rpc-'));
  ledger = new TaskLedger({ dir });
  await ledger.register({ id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-brain', title: 'lane' });
  await ledger.register({ id: 'wtask-9', taskWorkspaceId: 'ws-task-9', ownerWorkspaceId: 'ws-stranger', title: 'other' });
  handlers = new Map();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  registerLedgerRpc(router as never, () => null, {
    getLedger: () => ledger,
    resolveCallerWorkspace: async (pty) => (pty === 'pty-task' ? 'ws-task' : null),
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const call = (m: string, p: Record<string, unknown>, ctx?: RpcContext) => handlers.get(m)!(p, ctx);
const brainCtx = { commanderWorkspace: 'ws-brain' } as RpcContext;

describe('ledger.list', () => {
  it('a commander lists only the tasks its workspace owns', async () => {
    const res = (await call('ledger.list', {}, brainCtx)) as { ok: boolean; actor: unknown; entries: { id: string }[] };
    expect(res.ok).toBe(true);
    expect(res.actor).toEqual({ kind: 'brain', workspaceId: 'ws-brain' });
    expect(res.entries.map((e) => e.id)).toEqual(['wtask-1']);
  });

  it('a worker lists its own task by resolved senderPtyId; an unresolvable caller is refused', async () => {
    const res = (await call('ledger.list', { senderPtyId: 'pty-task' })) as { entries: { id: string }[] };
    expect(res.entries.map((e) => e.id)).toEqual(['wtask-1']);
    const denied = (await call('ledger.list', { senderPtyId: 'pty-nope' })) as { ok: boolean; error: { code: string } };
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe('NOT_AUTHORIZED');
  });
});

describe('ledger.update', () => {
  it('a worker hands its task to review with the rev it read; a stale rev is refused', async () => {
    const ok = (await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-1', status: 'review_requested', expectedRev: 1, summary: 'gate green' })) as { ok: boolean; entry: { status: string; rev: number } };
    expect(ok.ok).toBe(true);
    expect(ok.entry.status).toBe('review_requested');
    expect(ok.entry.rev).toBe(2);
    const stale = (await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-1', status: 'working', expectedRev: 1 })) as { ok: boolean; error: { code: string } };
    expect(stale.ok).toBe(false);
    expect(stale.error.code).toBe('STALE_REV');
  });

  it('a worker cannot complete or touch a stranger task; the brain completes only after the gate runner recorded a pass', async () => {
    const notMine = (await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-9', status: 'failed', expectedRev: 1 })) as { error: { code: string } };
    expect(notMine.error.code).toBe('NOT_AUTHORIZED');
    await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-1', status: 'review_requested', expectedRev: 1 });
    const selfCertify = (await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-1', status: 'completed', expectedRev: 2 })) as { error: { code: string } };
    expect(selfCertify.error.code).toBe('NOT_AUTHORIZED');
    const noGate = (await call('ledger.update', { taskId: 'wtask-1', status: 'completed', expectedRev: 2 }, brainCtx)) as { error: { code: string } };
    expect(noGate.error.code).toBe('GATE_REQUIRED');
    // A caller-supplied gate is refused outright — for the brain AND the worker.
    const wireGate = (await call('ledger.update', { taskId: 'wtask-1', status: 'completed', expectedRev: 2, gate: { exitCode: 0, tail: 'ok', at: 1, command: 'npm test' } }, brainCtx)) as { error: { code: string } };
    expect(wireGate.error.code).toBe('INVALID_ARGUMENT');
    const workerGate = (await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-1', status: 'working', expectedRev: 2, gate: { exitCode: 0 } })) as { error: { code: string } };
    expect(workerGate.error.code).toBe('INVALID_ARGUMENT');
    expect(ledger.get('wtask-1')?.gate).toBeUndefined();
    await ledger.recordGate('wtask-1', { exitCode: 0, tail: 'ok', at: 1, command: 'npm test' });
    const done = (await call('ledger.update', { taskId: 'wtask-1', status: 'completed', expectedRev: 3 }, brainCtx)) as { ok: boolean; entry: { status: string } };
    expect(done.ok).toBe(true);
    expect(done.entry.status).toBe('completed');
  });

  it('clamps summary and reason bytes on the wire path', async () => {
    const res = (await call('ledger.update', { senderPtyId: 'pty-task', taskId: 'wtask-1', status: 'input_required', expectedRev: 1, summary: 'x'.repeat(10_000) })) as { ok: boolean; entry: { summary: string } };
    expect(res.ok).toBe(true);
    expect(Buffer.byteLength(res.entry.summary)).toBe(2048);
  });

  it('validates the wire shape', async () => {
    const noStatus = (await call('ledger.update', { taskId: 'wtask-1', status: 'done', expectedRev: 1 }, brainCtx)) as { error: { code: string } };
    expect(noStatus.error.code).toBe('INVALID_ARGUMENT');
    const noRev = (await call('ledger.update', { taskId: 'wtask-1', status: 'failed' }, brainCtx)) as { error: { code: string } };
    expect(noRev.error.code).toBe('INVALID_ARGUMENT');
  });
});
