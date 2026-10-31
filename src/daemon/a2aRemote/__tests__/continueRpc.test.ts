// The daemon RPCs main starts a received conversation with: what to start,
// the claim as main reads it, a refusal told apart from a try-again, the
// start's end codes, and the placement forgotten once the start is decided.
import { describe, expect, it, vi } from 'vitest';
import type { HostId } from '../../../shared/a2aRemote';
import { A2A_CONTINUE_RPC, type A2aContinueIncomingState } from '../../../shared/a2aContinue';
import type { ContinueClaim, ContinueClaimResult } from '../continueReceiver';
import type { ContinueRequestRecordV1 } from '../continueRequestStore';
import { registerContinueRpc } from '../continueRpc';

const HOST = '11111111-1111-4111-8111-111111111111' as HostId;
const CID = 'ct-9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const LATER = 'ct-0a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

const request = (continueId: string, expiresAt = '2026-10-29T13:00:00.000Z'): ContinueRequestRecordV1['request'] => ({
  v: 1, continueId, sessionId: '0f1e2d3c-4b5a-4697-8877-665544332211', agent: 'claude',
  repo: { origin: 'github.com/acme/widget', branch: 'feat/x', head: 'a'.repeat(40), sub: 'apps/site' },
  estimate: { bytes: 10, files: 0 }, expiresAt,
});
const rec = (continueId: string, state: A2aContinueIncomingState, expiresAt?: string): ContinueRequestRecordV1 => ({
  v: 1, hostId: HOST, request: request(continueId, expiresAt), state, receivedAt: '', updatedAt: '',
});

function rig(claim: () => ContinueClaimResult = () => ({ ok: true, claim: claimed })) {
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  const records = [rec(CID, 'received'), rec(LATER, 'received', '2026-10-29T11:00:00.000Z')];
  const receiver = {
    claim: vi.fn(async () => claim()),
    started: vi.fn(() => ({ ok: true as const })),
    failed: vi.fn(() => ({ ok: true as const })),
  };
  const placer = { place: vi.fn(), unplace: vi.fn(), forget: vi.fn() };
  registerContinueRpc((m, h) => handlers.set(m, h), {
    receiver,
    requests: {
      get: (h, c) => records.find((r) => r.hostId === h && r.request.continueId === c),
      inState: (s) => records.filter((r) => r.state === s),
    },
    placer,
    hostName: () => 'HOME-A',
    paneTranscript: (ptyId) => (ptyId === 'pty-1' ? '/c/projects/x/id.jsonl' : null),
    now: () => NOW,
  });
  const call = (m: string, p: Record<string, unknown> = {}): Promise<unknown> => {
    const handler = handlers.get(m);
    if (!handler) throw new Error(`${m} is not registered`);
    return handler(p);
  };
  return { call, receiver, placer, records };
}

const claimed: ContinueClaim = {
  hostId: HOST, request: request(CID), rootId: 'web', rootPath: '/repo', permissionMode: 'acceptEdits', bytes: 10,
  manifest: { v: 1, continueId: CID, head: 'a'.repeat(40), transcript: { sha256: 'b'.repeat(64), bytes: 10 }, files: [] },
};

describe('registerContinueRpc', () => {
  it('lists only the received requests that may still start', async () => {
    const r = rig();
    expect(await r.call(A2A_CONTINUE_RPC.work)).toEqual({ received: [{ hostId: HOST, continueId: CID }] });
  });

  it('answers a claim with what main needs and no file of the asker\'s', async () => {
    const r = rig();
    expect(await r.call(A2A_CONTINUE_RPC.claim, { hostId: HOST, continueId: CID })).toEqual({
      ok: true,
      claim: {
        hostId: HOST, hostName: 'HOME-A', continueId: CID, sessionId: '0f1e2d3c-4b5a-4697-8877-665544332211', agent: 'claude',
        repoPath: '/repo', origin: 'github.com/acme/widget', branch: 'feat/x', head: 'a'.repeat(40), sub: 'apps/site', permissionMode: 'acceptEdits',
      },
    });
  });

  it('tells a settled refusal (a code) from one to try again (none)', async () => {
    expect(await rig(() => ({ ok: false, error: 'expired' })).call(A2A_CONTINUE_RPC.claim, { hostId: HOST, continueId: CID }))
      .toEqual({ ok: false, error: 'expired', code: 'expired' });
    expect(await rig(() => ({ ok: false, error: 'the folder was not checked now, try again: x' })).call(A2A_CONTINUE_RPC.claim, { hostId: HOST, continueId: CID }))
      .toEqual({ ok: false, error: 'the folder was not checked now, try again: x' });
  });

  it('takes only the codes a start ends with, and forgets the placement once decided', async () => {
    const r = rig();
    expect(await r.call(A2A_CONTINUE_RPC.failed, { hostId: HOST, continueId: CID, code: 'declined' })).toEqual({ ok: false, error: 'bad-request' });
    expect(r.receiver.failed).not.toHaveBeenCalled();
    expect(await r.call(A2A_CONTINUE_RPC.failed, { hostId: HOST, continueId: CID, code: 'branch-busy' })).toEqual({ ok: true });
    expect(r.receiver.failed).toHaveBeenCalledWith(HOST, CID, 'branch-busy');
    expect(await r.call(A2A_CONTINUE_RPC.started, { hostId: HOST, continueId: CID })).toEqual({ ok: true });
    expect(r.placer.forget.mock.calls).toEqual([[HOST, CID], [HOST, CID]]);
  });

  it('refuses ids that are not a PC and a continue request', async () => {
    const r = rig();
    for (const m of [A2A_CONTINUE_RPC.claim, A2A_CONTINUE_RPC.place, A2A_CONTINUE_RPC.unplace, A2A_CONTINUE_RPC.started, A2A_CONTINUE_RPC.state]) {
      expect(await r.call(m, { hostId: HOST, continueId: 'sp-1', cwd: '/x' })).toEqual({ ok: false, error: 'bad-request' });
    }
    expect(r.placer.place).not.toHaveBeenCalled();
  });

  it('answers a pane\'s bound transcript and a request\'s state', async () => {
    const r = rig();
    expect(await r.call(A2A_CONTINUE_RPC.binding, { ptyId: 'pty-1' })).toEqual({ transcriptPath: '/c/projects/x/id.jsonl' });
    expect(await r.call(A2A_CONTINUE_RPC.binding, { ptyId: 'pty-2' })).toEqual({ transcriptPath: null });
    r.records[0] = { ...r.records[0], state: 'decided', code: 'started' };
    expect(await r.call(A2A_CONTINUE_RPC.state, { hostId: HOST, continueId: CID })).toEqual({ state: 'decided', code: 'started' });
    expect(await r.call(A2A_CONTINUE_RPC.state, { hostId: HOST, continueId: 'ct-ffffffff-4e5f-4a6b-8c7d-0e1f2a3b4c5d' })).toEqual({});
  });
});
