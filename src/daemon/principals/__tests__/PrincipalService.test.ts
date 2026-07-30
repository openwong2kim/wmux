// ─── PrincipalService tests ──────────────────────────────────────────
// Verifies the core invariants of the R2 principal registry:
//   1. upsert → list round trip + liveness live
//   2. On restart (reconstruction) every pane-agent is backfilled stale + human:me seed
//   3. markStaleByPtyId / markStaleByWorkspace / remove
//   4. ptyIdOf preserves the routing coordinate independently of liveness
// The writer is injected as an in-memory fake, per the ChannelService.test convention.

import { describe, it, expect, vi } from 'vitest';
import { PrincipalService } from '../PrincipalService';
import type { PrincipalWriterLike } from '../PrincipalService';
import {
  HUMAN_SELF_PRINCIPAL_ID,
  panePrincipalId,
  type PrincipalState,
} from '../../../shared/principals';

/** In-memory fake writer. load() returns a deep copy of the last saved state —
 *  building a second service with the same writer simulates a daemon restart. */
function makeFakeWriter(): PrincipalWriterLike & { savedCount: () => number } {
  let last: PrincipalState | null = null;
  const clone = (s: PrincipalState): PrincipalState => ({
    version: s.version,
    principals: s.principals.map((p) => ({ ...p })),
  });
  const saveImmediate = vi.fn((state: PrincipalState): boolean => {
    last = clone(state);
    return true;
  });
  return {
    saveImmediate,
    saveDebounced: (state: PrincipalState) => {
      last = clone(state);
    },
    load: () => (last ? clone(last) : { version: 1, principals: [] }),
    savedCount: () => saveImmediate.mock.calls.length,
  };
}

const paneInput = (n: number) => ({
  id: panePrincipalId(`ws-${n}`, `pane-${n}`),
  kind: 'pane-agent' as const,
  display: `w${n}-1(claude)`,
  reachability: 'renderer-hook' as const,
  workspaceId: `ws-${n}`,
  paneId: `pane-${n}`,
  ptyId: `pty-${n}`,
  memberId: `w${n}-1(claude)`,
  agentSlug: 'claude',
});

describe('PrincipalService', () => {
  it('seed: human:me exists as live on construction', () => {
    const svc = new PrincipalService({ writer: makeFakeWriter() });
    const human = svc.find(HUMAN_SELF_PRINCIPAL_ID);
    expect(human).toBeDefined();
    expect(human?.kind).toBe('human');
    expect(human?.liveness).toBe('live');
    expect(human?.reportsTo).toBeNull(); // company-mode reserved — always null in v0
  });

  it('upsert → list round trip: a new pane-agent registers as live and its ptyId is swapped on update', () => {
    const svc = new PrincipalService({ writer: makeFakeWriter(), now: () => 1000 });
    const created = svc.upsert(paneInput(1));
    expect(created.liveness).toBe('live');
    expect(created.createdAt).toBe(1000);

    // Agent restart: same id, new ptyId → swap + stays live
    const updated = svc.upsert({ ...paneInput(1), ptyId: 'pty-1b' });
    expect(updated.ptyId).toBe('pty-1b');
    expect(svc.list().filter((p) => p.kind === 'pane-agent')).toHaveLength(1);
  });

  it('restart backfill: on reconstruction every pane-agent is stale, human:me restored to live', () => {
    const writer = makeFakeWriter();
    const svc1 = new PrincipalService({ writer });
    svc1.upsert(paneInput(1));
    svc1.upsert(paneInput(2));

    // Simulate a daemon restart — build a second service with the same writer
    const svc2 = new PrincipalService({ writer });
    const agents = svc2.list().filter((p) => p.kind === 'pane-agent');
    expect(agents).toHaveLength(2);
    expect(agents.every((p) => p.liveness === 'stale')).toBe(true);
    expect(svc2.find(HUMAN_SELF_PRINCIPAL_ID)?.liveness).toBe('live');
  });

  it('markStaleByPtyId(session:died): transitions only that ptyId to stale', () => {
    const svc = new PrincipalService({ writer: makeFakeWriter() });
    svc.upsert(paneInput(1));
    svc.upsert(paneInput(2));

    expect(svc.markStaleByPtyId('pty-1')).toBe(true);
    expect(svc.find(panePrincipalId('ws-1', 'pane-1'))?.liveness).toBe('stale');
    expect(svc.find(panePrincipalId('ws-2', 'pane-2'))?.liveness).toBe('live');
    // Already stale → no change
    expect(svc.markStaleByPtyId('pty-1')).toBe(false);
  });

  it('markStaleByWorkspace: transitions only that workspace\'s pane-agents to stale', () => {
    const svc = new PrincipalService({ writer: makeFakeWriter() });
    svc.upsert(paneInput(1));
    svc.upsert(paneInput(2));

    expect(svc.markStaleByWorkspace('ws-1')).toBe(true);
    expect(svc.find(panePrincipalId('ws-1', 'pane-1'))?.liveness).toBe('stale');
    expect(svc.find(panePrincipalId('ws-2', 'pane-2'))?.liveness).toBe('live');
  });

  it('remove: removes a principal whose coordinate vanished on pane close, but human:me cannot be removed', () => {
    const svc = new PrincipalService({ writer: makeFakeWriter() });
    svc.upsert(paneInput(1));

    expect(svc.remove(panePrincipalId('ws-1', 'pane-1'))).toBe(true);
    expect(svc.find(panePrincipalId('ws-1', 'pane-1'))).toBeUndefined();
    expect(svc.remove(HUMAN_SELF_PRINCIPAL_ID)).toBe(false);
    expect(svc.find(HUMAN_SELF_PRINCIPAL_ID)).toBeDefined();
  });

  it('ptyIdOf: preserves the routing coordinate across restart backfill', () => {
    const writer = makeFakeWriter();
    const svc1 = new PrincipalService({ writer });
    svc1.upsert(paneInput(1));
    const id = panePrincipalId('ws-1', 'pane-1');

    // Restart backfill makes the registry row stale even though the daemon
    // rebuilds the persisted session as detached. Callers that already hold a
    // live-session snapshot still need the coordinate so that snapshot — not
    // renderer-owned registry liveness — can decide whether the PTY exists.
    const svc2 = new PrincipalService({ writer });
    expect(svc2.find(id)?.liveness).toBe('stale');
    expect(svc2.ptyIdOf(id)).toBe('pty-1');

    svc2.remove(id);
    expect(svc2.ptyIdOf(id)).toBeUndefined();
  });
});
