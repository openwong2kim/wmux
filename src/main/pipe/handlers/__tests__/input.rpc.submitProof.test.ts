// A gated delivery into a daemon session that asks for it (a remote A2A
// delivery) reports what it submitted: the session, its incarnation, the
// daemon's key count once main's Enters are in it (the count read right before
// the first Enter plus one per Enter written), and the hash of the text typed.
// No proof when that count cannot be read, or when the delivery did not ask.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { DeliveryPresence } from '../../../../shared/deliveryPresence';
import { promptHash } from '../../../../shared/promptHash';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import { sendToRenderer } from '../_bridge';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const FREE = '⏺ Done.\n\n──────────\n❯ ';
const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };
const TEXT = '[wmux] task rt-00000000000000000000000000000001: reply with PONG';
/** A remote A2A delivery asks for the proof. */
const ASK = { submitProof: true };

let clock: number;
let writes: Array<{ id: string; data: string }>;
/** The daemon reports no key count (an older daemon). */
let noCount: boolean;
/** The daemon's read fails once the paste is written (the read right before the Enter). */
let failAfterPaste: boolean;
/** What the pane's composer shows for the receipt: the text stays there, so the Enter is retried once. */
let composer: string;

function harness() {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (id: string, data: string) => {
      writes.push({ id, data });
      return true;
    },
    getAgentState: async (id: string) => {
      const count = writes.filter((w) => w.id === id).length;
      if (failAfterPaste && count === 1) throw new Error('timeout');
      return {
        agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
        inputQuiet: true, inputRevision: 1, hasDraft: false, keyInputIdleMs: 60_000,
        ...(noCount ? {} : { keyInputRevision: count }),
      };
    },
  };
  return registerInputRpc(
    new RpcRouter(),
    { get: () => undefined } as unknown as PTYManager,
    () => ({}) as BrowserWindow,
    () => dc as never,
    undefined,
    undefined,
    {
      answerPolicy: async () => ({ allowed: false, reason: 'autonomy-off' }),
      deliveryPresence: async () => PROCESS,
      readScreenText: async () => FREE,
      readTurnStartedAt: () => undefined,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: () => undefined,
      readTaskState: async () => 'open',
      subscribeAgentStops: () => () => undefined,
      subscribeAgentNamed: () => () => undefined,
      pendingSetOnce: () => undefined,
      subscribeAgentRecordDropped: () => () => undefined,
    },
  );
}

const written = (id = 'pty-a'): string[] => writes.filter((w) => w.id === id).map((w) => w.data);

beforeEach(() => {
  clock = 1_000_000;
  writes = [];
  noCount = false;
  failAfterPaste = false;
  composer = '';
  vi.mocked(sendToRenderer).mockImplementation(async (_w, method) => {
    if (method === 'input.findOwnerWorkspace') return { workspaceId: 'ws-a' };
    if (method === 'input.readScreen') return { text: composer };
    return null;
  });
});

describe('the submit proof of a gated delivery', () => {
  it('one Enter: the key count read before it, plus one', async () => {
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    // The count before the Enter was 1 (the paste); the daemon counts the Enter as 2.
    expect(res).toEqual({ ok: true, submit: { ptyId: 'pty-a', incarnation: 'inc-1', submitRevision: 2, promptHash: promptHash(TEXT) } });
  });

  it('a retried Enter counts too', async () => {
    // The composer keeps showing the text: no receipt, so the Enter is sent once more.
    composer = `──────────\n❯ ${TEXT}\n──────────`;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r', '\r']);
    expect(res).toMatchObject({ ok: true, submit: { submitRevision: 3, incarnation: 'inc-1', ptyId: 'pty-a' } });
  });

  it('no proof when the key count cannot be read before the Enter', async () => {
    failAfterPaste = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    expect(res).toEqual({ ok: true });
  });

  it('a delivery that does not ask gets none, and its result is as before', async () => {
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code');
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    expect(res).toEqual({ ok: true });
  });

  it('no proof from a daemon that reports no key count', async () => {
    noCount = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(res).toEqual({ ok: true });
  });
});
