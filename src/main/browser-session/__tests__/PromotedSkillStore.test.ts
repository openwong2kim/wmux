import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PromotedSkillStore, getPromotedArchiveDir, getPromotedSkillsDir } from '../PromotedSkillStore';
import {
  PROMOTED_ARCHIVE_MS,
  PROMOTED_DELETE_MS,
  buildPromotedRecord,
  type PromotedRecord,
} from '../../../shared/browserReplay/promotedSkill';
import { stepsFingerprint, type TraceRecord, type TraceStep } from '../../../shared/browserReplay/actionTrace';

const step = (over: Partial<TraceStep> = {}): TraceStep => ({
  tool: 'browser_click',
  axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
  args: {},
  ...over,
});

const trace = (over: Partial<TraceRecord> = {}): TraceRecord => ({
  id: 'tr_1',
  name: 'invoice export',
  urlKey: 'https://billing.example.com/invoices',
  surfaceShape: 'abc',
  steps: [step()],
  observedCount: 1,
  successCount: 3,
  failCount: 0,
  createdAt: 1_000,
  lastUsedAt: 2_000,
  ...over,
});

const recordFor = (
  workspaceId: string,
  slug: string,
  over: Partial<TraceRecord> = {},
  now = 10_000,
): PromotedRecord => {
  const source = trace(over);
  return buildPromotedRecord(source, {
    workspaceId,
    slug,
    fingerprint: stepsFingerprint(source.steps),
    now,
  });
};

let dir: string;
let store: PromotedSkillStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-promoted-'));
  store = new PromotedSkillStore(dir);
});

afterEach(async () => {
  await store.drain();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('put / get / list', () => {
  it('writes a flow and reads it back', async () => {
    const record = recordFor('ws1', 'invoice-export');
    const res = await store.put(record);
    expect(res.ok).toBe(true);
    expect(store.get('ws1', 'invoice-export')?.name).toBe('invoice export');
    expect(store.list('ws1')).toHaveLength(1);
  });

  it('files each flow under its own workspace', async () => {
    await store.put(recordFor('ws1', 'a'));
    await store.put(recordFor('ws2', 'b'));
    expect(store.list('ws1').map((r) => r.slug)).toEqual(['a']);
    expect(store.list('ws2').map((r) => r.slug)).toEqual(['b']);
    // The isolation is the point: one workspace naming another's slug gets
    // nothing, not the other workspace's flow.
    expect(store.get('ws1', 'b')).toBeNull();
  });

  it('finds a flow by the trace name the agent knows', async () => {
    await store.put(recordFor('ws1', 'invoice-export'));
    expect(store.getByName('ws1', 'invoice export')?.slug).toBe('invoice-export');
    expect(store.getByName('ws1', 'nope')).toBeNull();
  });

  it('filters by page for the hint pipe', async () => {
    await store.put(recordFor('ws1', 'a'));
    await store.put(recordFor('ws1', 'b', { urlKey: 'https://other.example.com/x' }));
    expect(store.listForUrlKey('ws1', 'https://billing.example.com/invoices').map((r) => r.slug)).toEqual(['a']);
    expect(store.listForUrlKey('ws1', '')).toEqual([]);
  });

  it('returns nothing for a workspace that has promoted nothing', () => {
    expect(store.list('never-used')).toEqual([]);
    expect(store.get('never-used', 'x')).toBeNull();
  });
});

describe('identity guards', () => {
  it('refuses a slug that is not already normalised', async () => {
    const res = await store.put(recordFor('ws1', '../escape'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unusable/);
  });

  it('refuses an unusable workspace identity', async () => {
    for (const bad of ['', '..', '__proto__', 'a/b', 'x'.repeat(200)]) {
      expect((await store.put(recordFor(bad, 'ok'))).ok).toBe(false);
    }
  });

  it('writes nothing outside the store tree', async () => {
    await store.put(recordFor('ws1', 'invoice-export'));
    const live = getPromotedSkillsDir(dir);
    const written = fs.readdirSync(path.join(live, 'ws1'));
    expect(written).toEqual(['invoice-export.json']);
    // Nothing leaked up a level.
    expect(fs.readdirSync(dir).sort()).toEqual(['promoted-skills']);
  });
});

describe('overwrite protection', () => {
  it('refuses to replace a different flow holding the same slug', async () => {
    await store.put(recordFor('ws1', 'invoice-export'));
    const other = recordFor('ws1', 'invoice-export', {
      name: 'Invoice Export',
      steps: [step({ tool: 'browser_hover' }), step()],
    });
    const res = await store.put(other);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/already promoted/);
    // The resident flow is untouched.
    expect(store.get('ws1', 'invoice-export')?.steps).toHaveLength(1);
  });

  it('allows a re-promote of the same steps and keeps the usage history', async () => {
    const first = recordFor('ws1', 'invoice-export');
    await store.put(first);
    await store.touch('ws1', 'invoice-export', { ...first, runCount: 7, lastRunAt: 55_555 });
    const again = recordFor('ws1', 'invoice-export', {}, 99_999);
    const res = await store.put(again);
    expect(res.ok).toBe(true);
    const kept = store.get('ws1', 'invoice-export')!;
    expect(kept.runCount).toBe(7);
    expect(kept.lastRunAt).toBe(55_555);
    expect(kept.promotedAt).toBe(first.promotedAt);
  });
});

describe('remove', () => {
  it('deletes a flow this workspace owns', async () => {
    await store.put(recordFor('ws1', 'invoice-export'));
    expect(await store.remove('ws1', 'invoice-export')).toBe(true);
    expect(store.get('ws1', 'invoice-export')).toBeNull();
  });

  it('reports false for a flow that is not there', async () => {
    expect(await store.remove('ws1', 'nothing')).toBe(false);
  });

  it('refuses to delete through an unusable slug', async () => {
    expect(await store.remove('ws1', '../../etc')).toBe(false);
  });

  it('refuses a record whose stored workspace disagrees with its directory', async () => {
    // Simulates a file copied between workspace directories by hand. The
    // directory says ws2 may serve it; the record says ws1 owns it.
    const foreign = recordFor('ws1', 'invoice-export');
    const file = path.join(getPromotedSkillsDir(dir), 'ws2', 'invoice-export.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(foreign));
    expect(store.list('ws2')).toEqual([]);
    expect(store.get('ws2', 'invoice-export')).toBeNull();
    expect(await store.remove('ws2', 'invoice-export')).toBe(false);
  });
});

describe('touch', () => {
  it('updates the counters in place', async () => {
    const record = recordFor('ws1', 'invoice-export');
    await store.put(record);
    await store.touch('ws1', 'invoice-export', { ...record, runCount: 3, lastRunAt: 42 });
    expect(store.get('ws1', 'invoice-export')?.runCount).toBe(3);
  });

  it('never recreates a flow that was demoted', async () => {
    const record = recordFor('ws1', 'invoice-export');
    await store.put(record);
    await store.remove('ws1', 'invoice-export');
    await store.touch('ws1', 'invoice-export', { ...record, runCount: 9 });
    expect(store.get('ws1', 'invoice-export')).toBeNull();
  });
});

describe('sweep', () => {
  const now = 1_000_000_000_000;

  it('leaves a recently used flow alone', async () => {
    await store.put(recordFor('ws1', 'live', {}, now));
    const res = await store.sweep(now);
    expect(res).toEqual({ archived: 0, removed: 0 });
    expect(store.list('ws1')).toHaveLength(1);
  });

  it('moves an idle flow out of the live tree rather than deleting it', async () => {
    const idle = { ...recordFor('ws1', 'idle'), lastRunAt: now - PROMOTED_ARCHIVE_MS - 1 };
    await store.put(idle);
    const res = await store.sweep(now);
    expect(res.archived).toBe(1);
    // Gone from the live tree, so it can never be hinted again...
    expect(store.list('ws1')).toEqual([]);
    // ...but recoverable by hand.
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'idle.json'))).toBe(true);
  });

  it('deletes a flow idle past the delete threshold', async () => {
    const dead = { ...recordFor('ws1', 'dead'), lastRunAt: now - PROMOTED_DELETE_MS - 1 };
    await store.put(dead);
    const res = await store.sweep(now);
    expect(res.removed).toBe(1);
    expect(store.list('ws1')).toEqual([]);
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'dead.json'))).toBe(false);
  });

  it('sweeps every workspace in one pass', async () => {
    await store.put({ ...recordFor('ws1', 'a'), lastRunAt: now - PROMOTED_ARCHIVE_MS - 1 });
    await store.put({ ...recordFor('ws2', 'b'), lastRunAt: now - PROMOTED_DELETE_MS - 1 });
    await store.put(recordFor('ws3', 'c', {}, now));
    const res = await store.sweep(now);
    expect(res).toEqual({ archived: 1, removed: 1 });
    expect(store.list('ws3')).toHaveLength(1);
  });

  it('drops an orphan file that no longer parses as a record', async () => {
    const file = path.join(getPromotedSkillsDir(dir), 'ws1', 'ghost.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version": 999, "junk": true}');
    await store.sweep(now);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is a no-op when nothing was ever promoted', async () => {
    expect(await store.sweep(now)).toEqual({ archived: 0, removed: 0 });
  });
});

describe('fail-soft', () => {
  it('survives a torn file without losing the others', async () => {
    await store.put(recordFor('ws1', 'good'));
    const torn = path.join(getPromotedSkillsDir(dir), 'ws1', 'torn.json');
    fs.writeFileSync(torn, '{ this is not json');
    // The readable flow still serves; the torn one is simply absent.
    expect(store.list('ws1').map((r) => r.slug)).toEqual(['good']);
  });

  it('ignores non-JSON entries in the tree', async () => {
    await store.put(recordFor('ws1', 'good'));
    fs.writeFileSync(path.join(getPromotedSkillsDir(dir), 'ws1', 'README.txt'), 'notes');
    expect(store.list('ws1')).toHaveLength(1);
  });

  it('reports a failed write instead of throwing', async () => {
    // A real ENOTDIR rather than a mocked fs: the workspace directory the
    // write needs is occupied by a file, which is exactly the shape of the
    // failure a user hits after a bad manual edit.
    const live = getPromotedSkillsDir(dir);
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'ws1'), 'not a directory');
    const res = await store.put(recordFor('ws1', 'invoice-export'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/could not be written/);
  });

  it('reports rather than throws when a flow file is unreadable', async () => {
    // The file exists but is a directory, so nothing can parse it. Both the
    // read and the delete have to fail closed instead of propagating.
    const file = path.join(getPromotedSkillsDir(dir), 'ws1', 'weird.json');
    fs.mkdirSync(file, { recursive: true });
    expect(store.get('ws1', 'weird')).toBeNull();
    expect(store.list('ws1')).toEqual([]);
    expect(await store.remove('ws1', 'weird')).toBe(false);
  });
});
