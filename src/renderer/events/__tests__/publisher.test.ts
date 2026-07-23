import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishA2aTask } from '../publisher';
import { isVerifiedItem } from '../../../shared/completionEvidence';
import type { EvidenceItem, TaskState } from '../../../shared/types';

// publisher.publish() delegates to window.electronAPI.events.publish. Node test env has no
// window, so plant a mock on globalThis.window to capture emit payloads (publisher tolerates
// absence via typeof window guard — without mock, emits are swallowed).
let published: Array<Record<string, unknown>>;

beforeEach(() => {
  published = [];
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      events: {
        publish: (input: Record<string, unknown>) => {
          published.push(input);
        },
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('publishA2aTask — verifiedItemCount attachment (§6.M PR-C)', () => {
  it('terminal transition + verification count → verifiedItemCount on event', () => {
    publishA2aTask('ws-from', 'ws-to', 't1', 'completed', 'updated', undefined, 1);
    expect(published).toHaveLength(1);
    const e = published[0];
    expect(e.type).toBe('a2a.task');
    expect(e.workspaceId).toBe('ws-from'); // base scope === sender (fail-safe invariant)
    expect(e.verifiedItemCount).toBe(1);
  });

  it('unverified completion (count 0) → 0 emitted distinct from absent (!== undefined guard)', () => {
    // 0 = "completed but no verified items" — a grade signal distinct from absence
    // (created/cancelled), so it must be emitted (!== undefined guard, not truthiness).
    publishA2aTask('ws-from', 'ws-to', 't1', 'completed', 'updated', undefined, 0);
    expect(published[0]).toHaveProperty('verifiedItemCount', 0);
  });

  it('created/cancelled without evidence (count undefined) → field absent', () => {
    publishA2aTask('ws-from', 'ws-to', 't1', 'submitted', 'created', undefined, undefined);
    expect(published[0]).not.toHaveProperty('verifiedItemCount');
    published = [];
    publishA2aTask('ws-from', 'ws-to', 't1', 'canceled', 'cancelled', undefined, undefined);
    expect(published[0]).not.toHaveProperty('verifiedItemCount');
  });

  it('messagePreview and verifiedItemCount coexist (independently attached)', () => {
    publishA2aTask('ws-from', 'ws-to', 't1', 'completed', 'updated', 'preview', 2);
    expect(published[0]).toMatchObject({ messagePreview: 'preview', verifiedItemCount: 2 });
  });
});

// Isomorphic to emitA2aTaskEvent (useRpcBridge) derivation: count task.status.evidence.items
// via isVerifiedItem. Validates observation contract (evidence grade → emit) at emitter
// boundary — reproduces derivation with same isVerifiedItem and publishA2aTask without
// pulling the 2000-line React hook into node tests.
describe('evidence grade derivation → emission (observation contract, §6.M PR-C)', () => {
  const verified: EvidenceItem = { kind: 'command', status: 'passed', summary: 'ok', command: 'npm test' };
  const unverified: EvidenceItem = { kind: 'inspection', status: 'unverified', summary: 'self-reported' };

  // Isomorphic to emitA2aTaskEvent derivation: derive only on **terminal transition
  // (completed/failed) + evidence** (state gate — Codex+GLM review). Non-terminal transitions
  // do not emit grade even when evidence is present.
  function emitFor(items: EvidenceItem[] | undefined, state: TaskState = 'completed'): Record<string, unknown> {
    const isTerminal = state === 'completed' || state === 'failed';
    const verifiedItemCount = isTerminal && items ? items.filter(isVerifiedItem).length : undefined;
    publishA2aTask('ws-from', 'ws-to', 't1', state, 'updated', undefined, verifiedItemCount);
    return published[published.length - 1];
  }

  it('verified 1 + unverified 1 → verifiedItemCount=1', () => {
    expect(emitFor([verified, unverified]).verifiedItemCount).toBe(1);
  });

  it('unverified only → verifiedItemCount=0', () => {
    expect(emitFor([unverified]).verifiedItemCount).toBe(0);
  });

  it('no evidence (created/cancelled/working) → field absent', () => {
    expect(emitFor(undefined)).not.toHaveProperty('verifiedItemCount');
  });

  it('working transition + evidence → field absent (grade on terminal transitions only, review Codex+GLM)', () => {
    // Daemon accepts evidence on non-terminal transitions too (PR-B else-if), but grade emits
    // only on completed/failed — a working event carrying grade would violate the contract.
    expect(emitFor([verified], 'working')).not.toHaveProperty('verifiedItemCount');
  });

  it('failed transition + evidence → grade emitted (terminal transition)', () => {
    expect(emitFor([unverified], 'failed').verifiedItemCount).toBe(0);
  });
});
