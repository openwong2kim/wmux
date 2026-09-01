import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActionCacheStore, getActionCachePath } from '../ActionCacheStore';
import {
  MAX_TRACES_PER_WORKSPACE,
  QUARANTINE_FAIL_STREAK,
  TRACE_TTL_MS,
  isQuarantined,
  type TraceRecord,
} from '../../../shared/browserReplay/actionTrace';

let dir: string;

function draft(overrides: Partial<TraceRecord> = {}): TraceRecord {
  const now = Date.now();
  return {
    id: 'tr_a',
    name: 'login',
    urlKey: 'https://example.com/login',
    surfaceShape: 'shape-a',
    steps: [
      {
        tool: 'browser_click',
        axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
        args: {},
      },
    ],
    observedCount: 1,
    successCount: 0,
    failCount: 0,
    createdAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-action-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ActionCacheStore — workspace isolation', () => {
  it('never serves one workspace a trace another workspace saved', async () => {
    const store = new ActionCacheStore(dir);
    await store.put('ws-1', draft({ name: 'secret-flow' }));
    expect(store.list('ws-1').map((t) => t.name)).toEqual(['secret-flow']);
    expect(store.list('ws-2')).toEqual([]);
    expect(store.get('ws-2', 'secret-flow')).toBeNull();
  });

  it('forgetting one workspace leaves the other intact', async () => {
    const store = new ActionCacheStore(dir);
    await store.put('ws-1', draft());
    await store.put('ws-2', draft());
    await store.forget('ws-1');
    expect(store.list('ws-1')).toEqual([]);
    expect(store.list('ws-2')).toHaveLength(1);
  });

  it('refuses a prototype-polluting workspace key', async () => {
    const store = new ActionCacheStore(dir);
    const result = await store.put('__proto__', draft());
    expect(result.ok).toBe(false);
    expect(store.list('__proto__')).toEqual([]);
  });
});

describe('ActionCacheStore — persistence', () => {
  it('survives a fresh store over the same directory (the restart case)', async () => {
    const first = new ActionCacheStore(dir);
    await first.put('ws-1', draft());
    first.flushSync();

    const second = new ActionCacheStore(dir);
    expect(second.get('ws-1', 'login')?.steps).toHaveLength(1);
  });

  it('loads as empty from a corrupt file instead of throwing', () => {
    fs.writeFileSync(getActionCachePath(dir), '{ not json');
    expect(new ActionCacheStore(dir).list('ws-1')).toEqual([]);
  });

  it('drops a malformed record but keeps its well-formed neighbours', () => {
    fs.writeFileSync(
      getActionCachePath(dir),
      JSON.stringify({ version: 1, workspaces: { 'ws-1': [draft(), { name: 'junk' }] } }),
    );
    expect(new ActionCacheStore(dir).list('ws-1').map((t) => t.name)).toEqual(['login']);
  });

  it('does not lose a mutation made while an earlier write is still debounced', async () => {
    const store = new ActionCacheStore(dir);
    await store.put('ws-1', draft({ name: 'first' }));
    await store.put('ws-1', draft({ name: 'second', id: 'tr_b' }));
    store.flushSync();
    expect(new ActionCacheStore(dir).list('ws-1').map((t) => t.name).sort()).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('ActionCacheStore — caps and TTL', () => {
  it('keeps only the most recently used traces at the per-workspace cap', async () => {
    const store = new ActionCacheStore(dir);
    for (let i = 0; i < MAX_TRACES_PER_WORKSPACE + 3; i++) {
      await store.put('ws-1', draft({ name: `flow${i}`, id: `tr_${i}` }));
    }
    const kept = store.list('ws-1');
    expect(kept).toHaveLength(MAX_TRACES_PER_WORKSPACE);
    expect(kept.map((t) => t.name)).toContain(`flow${MAX_TRACES_PER_WORKSPACE + 2}`);
  });

  it('forgets a trace older than the TTL on load', () => {
    const stale = draft({ lastUsedAt: Date.now() - TRACE_TTL_MS - 1_000 });
    fs.writeFileSync(
      getActionCachePath(dir),
      JSON.stringify({ version: 1, workspaces: { 'ws-1': [stale] } }),
    );
    expect(new ActionCacheStore(dir).list('ws-1')).toEqual([]);
  });
});

describe('ActionCacheStore — re-save and stats', () => {
  it('a re-save keeps the id and the success history and counts an observation', async () => {
    const store = new ActionCacheStore(dir);
    await store.put('ws-1', draft());
    await store.stats('ws-1', 'login', { ok: true });
    const again = await store.put('ws-1', draft({ id: 'tr_DIFFERENT' }));
    expect(again.trace?.id).toBe('tr_a');
    expect(again.trace?.successCount).toBe(1);
    expect(again.trace?.observedCount).toBe(2);
  });

  it('a re-save lifts the quarantine the old steps had earned', async () => {
    const store = new ActionCacheStore(dir);
    await store.put('ws-1', draft());
    for (let i = 0; i < QUARANTINE_FAIL_STREAK; i++) {
      await store.stats('ws-1', 'login', { ok: false, failedStep: 1 });
    }
    expect(isQuarantined(store.get('ws-1', 'login')!)).toBe(true);
    const again = await store.put('ws-1', draft());
    expect(isQuarantined(again.trace!)).toBe(false);
  });

  it('stats on an unknown trace is a no-op, not a create', async () => {
    const store = new ActionCacheStore(dir);
    expect(await store.stats('ws-1', 'nope', { ok: true })).toBeNull();
    expect(store.list('ws-1')).toEqual([]);
  });

  it('forget reports how many records it removed', async () => {
    const store = new ActionCacheStore(dir);
    await store.put('ws-1', draft({ name: 'a' }));
    await store.put('ws-1', draft({ name: 'b', id: 'tr_b' }));
    expect(await store.forget('ws-1', 'a')).toBe(1);
    expect(await store.forget('ws-1', 'a')).toBe(0);
    expect(await store.forget('ws-1')).toBe(1);
  });
});
