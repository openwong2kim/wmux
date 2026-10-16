// A factory bot's ledger.update reaches only the tasks it started itself
// (the row's dispatch origin), never with force; and a row the reconciler
// mirrored first still gets the fan-out's dispatch when it registers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import { registerLedgerRpc } from '../ledger.rpc';
import { recordNoChangesGate } from '../../../factory/taskGate';
import type { RpcContext } from '../../../../shared/rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

let dir = '';
let ledger: TaskLedger;
let update: Handler;

const bot = (botId: string): RpcContext => ({
  origin: 'local',
  commanderWorkspace: 'ws-bot',
  bot: { workspaceId: 'ws-bot', botId, role: 'verifier' },
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-ledger-bot-'));
  ledger = new TaskLedger({ dir });
  const handlers = new Map<string, Handler>();
  registerLedgerRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, () => null, { getLedger: () => ledger });
  update = handlers.get('ledger.update') as Handler;
  await ledger.register({ id: 't-mine', taskWorkspaceId: 'ws-t1', ownerWorkspaceId: 'ws-bot', title: 'mine', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } });
  await ledger.register({ id: 't-other', taskWorkspaceId: 'ws-t2', ownerWorkspaceId: 'ws-bot', title: 'other', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000b' } } });
  await ledger.register({ id: 't-pane', taskWorkspaceId: 'ws-t3', ownerWorkspaceId: 'ws-bot', title: 'pane' });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ledger.update — bot scope', () => {
  it('moves its own task', async () => {
    expect(await update({ taskId: 't-mine', status: 'failed', expectedRev: 1 }, bot('bot-0000000a'))).toMatchObject({ ok: true });
  });

  it('refuses another bot\'s task, a pane-started task, and force', async () => {
    for (const taskId of ['t-other', 't-pane', 't-missing']) {
      expect(await update({ taskId, status: 'failed', expectedRev: 1 }, bot('bot-0000000a')), taskId).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    }
    expect(await update({ taskId: 't-mine', status: 'cancelled', expectedRev: 1, force: true, reason: 'x' }, bot('bot-0000000a')))
      .toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
  });

  it('settles its own reported task the gate skipped for no_changes: completed (unforced) or failed', async () => {
    await ledger.register({ id: 't-done', taskWorkspaceId: 'ws-t4', ownerWorkspaceId: 'ws-bot', title: 'done', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } });
    for (const [id, ws] of [['t-mine', 'ws-t1'], ['t-done', 'ws-t4']] as const) {
      const r = await ledger.update({ id, status: 'review_requested', actor: { kind: 'worker', workspaceId: ws }, expectedRev: 1, summary: 'node --version is v22' });
      if (!r.ok) throw new Error(r.message);
    }
    // Before the skip is recorded there is no gate: completed is refused.
    expect(await update({ taskId: 't-done', status: 'completed', expectedRev: 2 }, bot('bot-0000000a'))).toMatchObject({ ok: false, error: { code: 'GATE_REQUIRED' } });
    expect(await recordNoChangesGate(ledger, 't-done', 'no commits')).toBe(true);
    expect(await recordNoChangesGate(ledger, 't-mine', 'no commits')).toBe(true);
    expect(await update({ taskId: 't-done', status: 'completed', expectedRev: 3 }, bot('bot-0000000a'))).toMatchObject({ ok: true, entry: { status: 'completed' } });
    expect(ledger.get('t-done')?.summary).toBe('node --version is v22');
    expect(ledger.get('t-done')?.gate?.skipped).toBe('no_changes');
    expect(await update({ taskId: 't-mine', status: 'failed', expectedRev: 3 }, bot('bot-0000000a'))).toMatchObject({ ok: true, entry: { status: 'failed' } });
  });

  it('a commander brain without a bot binding keeps its workspace-wide reach', async () => {
    expect(await update({ taskId: 't-pane', status: 'failed', expectedRev: 1 }, { origin: 'local', commanderWorkspace: 'ws-bot' })).toMatchObject({ ok: true });
  });
});

describe('TaskLedger.register — dispatch', () => {
  it('attaches a dispatch to a row registered without one, and never replaces a recorded one', async () => {
    const attached = await ledger.register({ id: 't-pane', taskWorkspaceId: 'ws-t3', ownerWorkspaceId: 'ws-bot', title: 'pane', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } });
    expect(attached.dispatch?.origin.botId).toBe('bot-0000000a');
    const kept = await ledger.register({ id: 't-other', taskWorkspaceId: 'ws-t2', ownerWorkspaceId: 'ws-bot', title: 'other', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } });
    expect(kept.dispatch?.origin.botId).toBe('bot-0000000b');
    // Replayed from the log by a fresh instance.
    expect(new TaskLedger({ dir }).get('t-pane')?.dispatch?.origin.botId).toBe('bot-0000000a');
  });
});
