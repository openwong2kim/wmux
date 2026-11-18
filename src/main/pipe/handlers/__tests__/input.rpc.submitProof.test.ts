// A gated delivery into a daemon session that asks for it (a remote A2A
// delivery) reports what it submitted: the session, its incarnation, the epoch
// and value of the daemon's key count once main's Enters are in it (the count
// read right before the first Enter plus the Enter writes the daemon counted),
// the hash of the text typed, and the transcript's size at that read. Only for
// writes under the daemon's pane lock; no proof when the count cannot be read,
// when a retried Enter's write may or may not have landed, or when the
// delivery did not ask.

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
/** The daemon reports no key epoch (an older daemon). */
let noEpoch: boolean;
/** The daemon has no pane lock (an older daemon): writes go down the session pipe. */
let noLock: boolean;
/** The daemon's read fails once the paste is written (the read right before the Enter). */
let failAfterPaste: boolean;
/** The retried Enter's held write loses its reply (it may have landed). */
let retryUncertain: boolean;
/** The daemon refuses the retried Enter's held write before writing anything. */
let retryRefused: boolean;
/** What the pane's composer shows for the receipt: the text stays there, so the Enter is retried once. */
let composer: string;
/** Transcript-size asks the daemon got. */
let offsetAsks: number;
/** The transcript-size read fails (a slow transcript path past its timeout). */
let offsetFails: boolean;
/** When each state read started and answered. */
let reads: string[];

function harness() {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (id: string, data: string) => {
      writes.push({ id, data });
      return true;
    },
    getAgentState: async (id: string, opts: { transcriptOffset?: boolean } = {}) => {
      const count = writes.filter((w) => w.id === id).length;
      if (failAfterPaste && count === 1) throw new Error('timeout');
      if (opts.transcriptOffset) offsetAsks += 1;
      const kind = opts.transcriptOffset ? 'size' : 'plain';
      reads.push(`ask ${kind}`);
      await Promise.resolve();
      reads.push(`answer ${kind}`);
      if (opts.transcriptOffset && offsetFails) throw new Error('timeout');
      return {
        agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
        inputQuiet: true, inputRevision: 1, hasDraft: false, keyInputIdleMs: 60_000,
        ...(noCount ? {} : { keyInputRevision: count }),
        ...(noEpoch ? {} : { keyEpoch: 'epoch-1' }),
        ...(opts.transcriptOffset ? { transcriptOffset: 4096 } : {}),
      };
    },
    acquirePaneLock: async () => (noLock ? { held: false as const, why: 'unsupported' as const, detail: 'old' } : { held: true as const, token: 'tok-1' }),
    releasePaneLock: () => undefined,
    writeHeld: async (id: string, _token: string, data: string) => {
      const retry = data === '\r' && writes.filter((w) => w.id === id && w.data === '\r').length === 1;
      if (retry && retryRefused) return { ok: false as const, uncertain: false, detail: 'the pane lock was lost', written: 0 };
      writes.push({ id, data });
      if (retry && retryUncertain) return { ok: false as const, uncertain: true, detail: 'reply lost', written: 0 };
      return { ok: true as const, written: 1 };
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
  noEpoch = false;
  noLock = false;
  failAfterPaste = false;
  retryUncertain = false;
  retryRefused = false;
  composer = '';
  offsetAsks = 0;
  offsetFails = false;
  reads = [];
  vi.mocked(sendToRenderer).mockImplementation(async (_w, method) => {
    if (method === 'input.findOwnerWorkspace') return { workspaceId: 'ws-a' };
    if (method === 'input.readScreen') return { text: composer };
    return null;
  });
});

describe('the submit proof of a gated delivery', () => {
  it('one Enter: the key count read before it, plus the one write the daemon counted', async () => {
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    // The count before the Enter was 1 (the paste); the daemon counts the Enter as 2.
    expect(res).toEqual({
      ok: true,
      submit: { ptyId: 'pty-a', incarnation: 'inc-1', keyEpoch: 'epoch-1', submitRevision: 2, promptHash: promptHash(TEXT), transcriptOffsetAtBase: 4096 },
    });
    expect(offsetAsks).toBe(1);
    // The size is asked only once the plain read has answered: a slow size never holds the baseline's reply.
    const sizeAt = reads.indexOf('ask size');
    expect(reads.slice(sizeAt - 2, sizeAt + 2)).toEqual(['ask plain', 'answer plain', 'ask size', 'answer size']);
  });

  it('a retried Enter counts too', async () => {
    // The composer keeps showing the text: no receipt, so the Enter is sent once more.
    composer = `──────────\n❯ ${TEXT}\n──────────`;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r', '\r']);
    expect(res).toMatchObject({ ok: true, submit: { submitRevision: 3, incarnation: 'inc-1', keyEpoch: 'epoch-1', ptyId: 'pty-a' } });
  });

  it('a transcript size that cannot be read costs only the floor: the Enter retry keeps its baseline', async () => {
    composer = `──────────\n❯ ${TEXT}\n──────────`;
    offsetFails = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r', '\r']);
    expect(res).toEqual({
      ok: true,
      submit: { ptyId: 'pty-a', incarnation: 'inc-1', keyEpoch: 'epoch-1', submitRevision: 3, promptHash: promptHash(TEXT) },
    });
  });

  it('no proof when a retried Enter may or may not have landed', async () => {
    composer = `──────────\n❯ ${TEXT}\n──────────`;
    retryUncertain = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r', '\r']);
    expect(res).toEqual({ ok: true });
  });

  it('a retried Enter the daemon refused before writing anything keeps the first Enter\'s proof', async () => {
    composer = `──────────\n❯ ${TEXT}\n──────────`;
    retryRefused = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    expect(res).toEqual({
      ok: true,
      submit: { ptyId: 'pty-a', incarnation: 'inc-1', keyEpoch: 'epoch-1', submitRevision: 2, promptHash: promptHash(TEXT), transcriptOffsetAtBase: 4096 },
    });
  });

  it('no proof when the key count cannot be read before the Enter', async () => {
    failAfterPaste = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    expect(res).toEqual({ ok: true });
  });

  it('a delivery that does not ask gets none, its result is as before, and the transcript is not asked about', async () => {
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code');
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    expect(res).toEqual({ ok: true });
    expect(offsetAsks).toBe(0);
  });

  it('no proof from a daemon that reports no key count, or no key epoch', async () => {
    noCount = true;
    expect(await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK)).toEqual({ ok: true });
    noCount = false;
    noEpoch = true;
    expect(await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK)).toEqual({ ok: true });
  });

  it('no proof for writes down the session pipe (no pane lock): their count may come after a read', async () => {
    noLock = true;
    const res = await harness().gatedSubmit('pty-a', TEXT, 'Claude Code', ASK);
    expect(written()).toEqual([`\x1b[200~${TEXT}\x1b[201~`, '\r']);
    expect(res).toEqual({ ok: true });
  });
});
