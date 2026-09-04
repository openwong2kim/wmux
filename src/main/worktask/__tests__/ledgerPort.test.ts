import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { createHostedLedgerPort } from '../ledgerPort';
import type { LedgerGateResult } from '../../../shared/ledger';

function gate(exitCode: number | null): LedgerGateResult {
  return { exitCode, tail: 'ok', at: 1_000, command: 'npm test', recordedBy: 'system' };
}

async function withLedger(fn: (ledger: TaskLedger) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wmux-ledger-port-'));
  try {
    await fn(new TaskLedger({ dir, log: () => undefined }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createHostedLedgerPort', () => {
  it('reads the hosted entry and records a gate as the system actor', async () => {
    await withLedger(async (ledger) => {
      await ledger.register({
        id: 'wtask-1',
        taskWorkspaceId: 'ws-task',
        ownerWorkspaceId: 'ws-owner',
        title: 'gate me',
      });
      const port = createHostedLedgerPort(() => ledger);

      const snapshot = await port.read('wtask-1');
      expect(snapshot).toEqual({ id: 'wtask-1', rev: 1 });

      const written = await port.writeGate({
        taskId: 'wtask-1',
        expectedRev: 1,
        actor: { kind: 'system', workspaceId: 'ws-daemon' },
        gate: gate(0),
      });
      expect(written).toEqual({ ok: true, rev: 2 });
      // recordGate is the only provenance `completed` trusts, so the stored
      // verdict must carry the system stamp rather than the caller's word.
      expect(ledger.get('wtask-1')?.gate).toMatchObject({ exitCode: 0, recordedBy: 'system' });
    });
  });

  it('answers conflict on a stale expectedRev and not_found for an unknown task', async () => {
    await withLedger(async (ledger) => {
      await ledger.register({
        id: 'wtask-2',
        taskWorkspaceId: 'ws-task',
        ownerWorkspaceId: 'ws-owner',
        title: 'raced',
      });
      const port = createHostedLedgerPort(() => ledger);
      // Someone else wrote first: the row is at rev 2, our snapshot said 1.
      await ledger.recordGate('wtask-2', gate(1));

      const stale = await port.writeGate({
        taskId: 'wtask-2',
        expectedRev: 1,
        actor: { kind: 'system', workspaceId: 'ws-daemon' },
        gate: gate(0),
      });
      expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
      // The loser must not have overwritten the winner's verdict.
      expect(ledger.get('wtask-2')?.gate).toMatchObject({ exitCode: 1 });

      expect(await port.read('nope')).toBeNull();
      expect(
        await port.writeGate({
          taskId: 'nope',
          expectedRev: 1,
          actor: { kind: 'system', workspaceId: 'ws-daemon' },
          gate: gate(0),
        }),
      ).toMatchObject({ ok: false, reason: 'not_found' });
    });
  });
});
