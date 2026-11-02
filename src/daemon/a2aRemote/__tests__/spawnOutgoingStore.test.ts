// The asking PC's request store at its bound: which record makes room.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPAWN_REQUESTS_MAX } from '../../../shared/a2aSpawn';
import { SpawnOutgoingStore, type SpawnOutgoingRecordV1 } from '../spawnOutgoingStore';

const B = '22222222-2222-4222-8222-222222222222';

describe('SpawnOutgoingStore at its bound', () => {
  it('makes room from a final record that takes no answer before an expired one, which still takes a late started', () => {
    let clock = Date.parse('2026-10-23T00:00:00Z');
    // In memory only: nothing is written.
    const store = new SpawnOutgoingStore({ dir: path.join(os.tmpdir(), 'unused'), now: () => clock, write: () => undefined, scheduleHarden: () => undefined });
    const at = () => new Date(clock).toISOString();
    const record = (): SpawnOutgoingRecordV1 => ({
      v: 1, hostId: B, spawnId: `sp-${crypto.randomUUID()}`, agent: 'claude', rootId: 'web',
      from: { workspaceId: 'ws-a', paneId: 'pane-a' }, callerKey: 'pane-a', text: 'go', state: 'sent',
      createdAt: at(), updatedAt: at(), expiresAt: new Date(clock + 3 * 24 * 3600_000).toISOString(),
    });
    const ids: string[] = [];
    for (let i = 0; i < SPAWN_REQUESTS_MAX; i++) {
      const r = record();
      store.add(r);
      ids.push(r.spawnId);
    }
    // The oldest final record is the expired one; a refused one comes next.
    store.settle(B, ids[0], { state: 'expired' });
    clock += 1;
    store.settle(B, ids[1], { state: 'refused', code: 'declined' });
    clock += 1;
    store.add(record());
    expect(store.get(B, ids[0])?.state).toBe('expired');
    expect(store.takesAnswer(B, ids[0])).toBe(true);
    expect(store.get(B, ids[1])).toBeUndefined();
  });

  it('refuses a new request rather than evict an expired one, when nothing else is final', () => {
    let clock = Date.parse('2026-10-23T00:00:00Z');
    const store = new SpawnOutgoingStore({ dir: path.join(os.tmpdir(), 'unused'), now: () => clock, write: () => undefined, scheduleHarden: () => undefined });
    const at = () => new Date(clock).toISOString();
    const record = (): SpawnOutgoingRecordV1 => ({
      v: 1, hostId: B, spawnId: `sp-${crypto.randomUUID()}`, agent: 'claude', rootId: 'web',
      from: { workspaceId: 'ws-a', paneId: 'pane-a' }, callerKey: 'pane-a', text: 'go', state: 'sent',
      createdAt: at(), updatedAt: at(), expiresAt: new Date(clock + 3 * 24 * 3600_000).toISOString(),
    });
    const ids: string[] = [];
    for (let i = 0; i < SPAWN_REQUESTS_MAX; i++) {
      const r = record();
      store.add(r);
      ids.push(r.spawnId);
    }
    store.settle(B, ids[0], { state: 'expired' });
    clock += 1;
    expect(() => store.add(record())).toThrow(/may still be answered/);
    expect(store.takesAnswer(B, ids[0])).toBe(true);
  });
});

describe('SpawnOutgoingStore: the asker\'s label', () => {
  it('is bounded like a link label, kept through settle and a restart; a non-text one is not a record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-label-'));
    try {
      const clock = Date.parse('2026-10-23T00:00:00Z');
      const open = (): SpawnOutgoingStore => new SpawnOutgoingStore({ dir, now: () => clock, scheduleHarden: () => undefined });
      const at = new Date(clock).toISOString();
      const record = (label: unknown): SpawnOutgoingRecordV1 => ({
        v: 1, hostId: B, spawnId: `sp-${crypto.randomUUID()}`, agent: 'claude', rootId: 'web',
        from: { workspaceId: 'ws-a', paneId: 'pane-a' }, callerKey: 'pane-a', text: 'go', state: 'sent',
        createdAt: at, updatedAt: at, expiresAt: new Date(clock + 24 * 3600_000).toISOString(), label,
      } as unknown as SpawnOutgoingRecordV1);
      let store = open();
      const named = record(`  Parser\tseat ${'x'.repeat(80)}  `);
      const blank = record('   ');
      store.add(named);
      store.add(blank);
      const want = `Parser seat ${'x'.repeat(80)}`.slice(0, 64);
      expect(store.get(B, named.spawnId)?.label).toBe(want);
      expect(store.get(B, blank.spawnId)).not.toHaveProperty('label');
      store.settle(B, named.spawnId, { state: 'waiting' });
      store.settle(B, named.spawnId, { state: 'started', linkId: crypto.randomUUID() });
      store = open();
      expect(store.get(B, named.spawnId)).toMatchObject({ state: 'started', label: want });
      expect(() => store.add(record(7))).toThrow(/invalid record/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
