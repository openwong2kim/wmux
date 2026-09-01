import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PromotedSkillStore, getPromotedArchiveDir, getPromotedSkillsDir } from '../PromotedSkillStore';
import {
  PROMOTED_ARCHIVE_MS,
  PROMOTED_DELETE_MS,
  PROMOTED_SCHEMA_VERSION,
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

  it('takes a flow past the delete threshold out of the live tree', async () => {
    // Via the archive, not straight to deletion — see the ladder cases below.
    const dead = { ...recordFor('ws1', 'dead'), lastRunAt: now - PROMOTED_DELETE_MS - 1 };
    await store.put(dead);
    const res = await store.sweep(now);
    expect(res.archived).toBe(1);
    expect(store.list('ws1')).toEqual([]);
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'dead.json'))).toBe(true);
  });

  it('sweeps every workspace in one pass', async () => {
    await store.put({ ...recordFor('ws1', 'a'), lastRunAt: now - PROMOTED_ARCHIVE_MS - 1 });
    await store.put({ ...recordFor('ws2', 'b'), lastRunAt: now - PROMOTED_DELETE_MS - 1 });
    await store.put(recordFor('ws3', 'c', {}, now));
    const res = await store.sweep(now);
    // Both leave the live tree on this pass; the long-dead one is deleted on
    // the next, after its stop in the archive.
    expect(res).toEqual({ archived: 2, removed: 0 });
    expect(store.list('ws3')).toHaveLength(1);
    expect((await store.sweep(now)).removed).toBe(1);
  });

  it('archives an unreadable file rather than deleting it', async () => {
    // The ladder promises a stop in the archive before anything is gone, and
    // a corrupt file is exactly the case where a human might want to look at
    // what was in it.
    const file = path.join(getPromotedSkillsDir(dir), 'ws1', 'ghost.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json at all');
    await store.sweep(now);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'ghost.json'))).toBe(true);
  });

  it('leaves a file written by a NEWER wmux completely alone', async () => {
    // The downgrade case. Running an older build once must not destroy flows
    // the newer build wrote and can still read.
    const file = path.join(getPromotedSkillsDir(dir), 'ws1', 'future.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const future = JSON.stringify({
      ...recordFor('ws1', 'future'),
      version: PROMOTED_SCHEMA_VERSION + 1,
      somethingNew: true,
    });
    fs.writeFileSync(file, future);
    await store.sweep(now);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(future);
    // Not archived either — untouched means untouched.
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'future.json'))).toBe(false);
  });

  it('deletes an archived flow once it passes the delete threshold', async () => {
    // Without an archive walk this rung was unreachable: archiving MOVES the
    // file out of the live tree, so the live walk could never see it again.
    const record = { ...recordFor('ws1', 'old'), lastRunAt: now - PROMOTED_ARCHIVE_MS - 1 };
    await store.put(record);
    expect((await store.sweep(now)).archived).toBe(1);
    const archived = path.join(getPromotedArchiveDir(dir), 'ws1', 'old.json');
    expect(fs.existsSync(archived)).toBe(true);

    // Still inside the delete window: it stays.
    expect((await store.sweep(now + 1)).removed).toBe(0);
    expect(fs.existsSync(archived)).toBe(true);

    // Past it: gone.
    const later = record.lastRunAt + PROMOTED_DELETE_MS + 1;
    expect((await store.sweep(later)).removed).toBe(1);
    expect(fs.existsSync(archived)).toBe(false);
  });

  it('archives a long-dead live flow before deleting it, never straight out', async () => {
    // A machine that was off for three months must not skip the archive rung.
    const dead = { ...recordFor('ws1', 'ancient'), lastRunAt: now - PROMOTED_DELETE_MS * 2 };
    await store.put(dead);
    const first = await store.sweep(now);
    expect(first.archived).toBe(1);
    expect(first.removed).toBe(0);
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'ancient.json'))).toBe(true);
    // The NEXT sweep is the one that deletes it.
    expect((await store.sweep(now)).removed).toBe(1);
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

describe('check-then-act is atomic', () => {
  it('does not resurrect a swept flow through a concurrent re-promote', async () => {
    // put reads the resident record to merge its counters. If the read and
    // the write straddled the chain, a sweep landing between them would be
    // undone by the merge — the flow would come back with counters from a
    // record that had just been archived.
    const now = 2_000_000_000_000;
    const idle = { ...recordFor('ws1', 'race'), lastRunAt: now - PROMOTED_ARCHIVE_MS - 1 };
    await store.put(idle);
    const [, sweepResult] = await Promise.all([
      store.put({ ...recordFor('ws1', 'race'), lastRunAt: now }),
      store.sweep(now),
    ]);
    await store.drain();
    // Whichever order the two landed in, the store is self-consistent: the
    // flow is in exactly one of the two trees, never both and never neither.
    const live = fs.existsSync(path.join(getPromotedSkillsDir(dir), 'ws1', 'race.json'));
    const archived = fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'race.json'));
    expect(live !== archived).toBe(true);
    expect(sweepResult.archived + sweepResult.removed).toBeLessThanOrEqual(1);
  });

  it('interleaved touches do not lose an update', async () => {
    const record = recordFor('ws1', 'counted');
    await store.put(record);
    await Promise.all([
      store.touch('ws1', 'counted', { ...record, runCount: 1, lastRunAt: 10 }),
      store.touch('ws1', 'counted', { ...record, runCount: 2, lastRunAt: 20 }),
      store.touch('ws1', 'counted', { ...record, runCount: 3, lastRunAt: 30 }),
    ]);
    await store.drain();
    // Serialised, so the last one on the chain is what stands — not a torn
    // mixture of two writers' fields.
    const kept = store.get('ws1', 'counted')!;
    expect(kept.runCount).toBe(3);
    expect(kept.lastRunAt).toBe(30);
  });

  it('a touch merges only counters, never the caller stale steps', async () => {
    // The caller resolved its record before the replay ran. Writing it back
    // wholesale would revert a re-promote that landed in between.
    const original = recordFor('ws1', 'merge');
    await store.put(original);
    const stale = { ...original, runCount: 1, lastRunAt: 99 };
    // A re-promote with the same fingerprint but different steps is not
    // possible by construction, so simulate the field that must not travel.
    await store.touch('ws1', 'merge', { ...stale, host: 'attacker.example.com' });
    const kept = store.get('ws1', 'merge')!;
    expect(kept.runCount).toBe(1);
    expect(kept.lastRunAt).toBe(99);
    expect(kept.host).toBe('billing.example.com');
  });

  it('a demote racing a re-promote never deletes the new record silently', async () => {
    const record = recordFor('ws1', 'raced');
    await store.put(record);
    const [removed] = await Promise.all([
      store.remove('ws1', 'raced'),
      store.put(recordFor('ws1', 'raced')),
    ]);
    await store.drain();
    const present = store.get('ws1', 'raced') !== null;
    // Either the demote won (removed, absent) or the put won (present). What
    // must never happen is "reported removed" AND the file still there with
    // the caller believing it is gone, or vice versa.
    expect(typeof removed).toBe('boolean');
    expect(present === !removed || present).toBe(true);
  });
});

describe('removal leaves no readable copy behind', () => {
  // atomicWriteJSON keeps a `.bak` beside each record, and atomicReadJSONSync
  // falls back through those suffixes. Both facts make a leftover backup more
  // than untidy: it is a full copy of the steps (so of whatever was typed),
  // and it is a file a read could bring the record back from.
  const bakOf = (workspaceId: string, slug: string) =>
    path.join(getPromotedSkillsDir(dir), workspaceId, `${slug}.json.bak`);

  const seedWithBackup = async (workspaceId: string, slug: string) => {
    const record = recordFor(workspaceId, slug);
    await store.put(record);
    // A second write of the same fingerprint is what mints the .bak.
    await store.touch(workspaceId, slug, { ...record, runCount: 1, lastRunAt: 5 });
    await store.drain();
    return record;
  };

  it('mints a backup in the ordinary course of writing (guards the premise)', async () => {
    await seedWithBackup('ws1', 'invoice-export');
    expect(fs.existsSync(bakOf('ws1', 'invoice-export'))).toBe(true);
  });

  it('demote removes the backup along with the record', async () => {
    await seedWithBackup('ws1', 'invoice-export');
    expect(await store.remove('ws1', 'invoice-export')).toBe(true);
    await store.drain();
    expect(fs.existsSync(bakOf('ws1', 'invoice-export'))).toBe(false);
    expect(store.get('ws1', 'invoice-export')).toBeNull();
  });

  it('a demoted flow cannot be read back from its backup', async () => {
    const record = await seedWithBackup('ws1', 'invoice-export');
    await store.remove('ws1', 'invoice-export');
    await store.drain();
    // Recreate only the backup, as a stale one would have survived before.
    fs.writeFileSync(bakOf('ws1', 'invoice-export'), JSON.stringify(record));
    expect(store.get('ws1', 'invoice-export')).toBeNull();
    expect(store.list('ws1')).toEqual([]);
  });

  it('archiving takes the backup out of the live tree', async () => {
    const now = 3_000_000_000_000;
    await seedWithBackup('ws1', 'idle');
    await store.touch('ws1', 'idle', {
      ...recordFor('ws1', 'idle'),
      runCount: 1,
      lastRunAt: now - PROMOTED_ARCHIVE_MS - 1,
    });
    await store.drain();
    expect((await store.sweep(now)).archived).toBe(1);
    await store.drain();
    expect(fs.existsSync(bakOf('ws1', 'idle'))).toBe(false);
    expect(store.list('ws1')).toEqual([]);
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'idle.json'))).toBe(true);
  });

  it('deleting from the archive removes its backups too', async () => {
    const now = 4_000_000_000_000;
    const archived = path.join(getPromotedArchiveDir(dir), 'ws1', 'dead.json');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    const record = { ...recordFor('ws1', 'dead'), lastRunAt: now - PROMOTED_DELETE_MS - 1 };
    fs.writeFileSync(archived, JSON.stringify(record));
    fs.writeFileSync(`${archived}.bak`, JSON.stringify(record));
    expect((await store.sweep(now)).removed).toBe(1);
    await store.drain();
    expect(fs.existsSync(archived)).toBe(false);
    expect(fs.existsSync(`${archived}.bak`)).toBe(false);
  });

  it('quarantining a corrupt record does not strand its backup', async () => {
    const now = 5_000_000_000_000;
    const file = path.join(getPromotedSkillsDir(dir), 'ws1', 'corrupt.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    fs.writeFileSync(`${file}.bak`, '{ also not json');
    await store.sweep(now);
    await store.drain();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    expect(fs.existsSync(path.join(getPromotedArchiveDir(dir), 'ws1', 'corrupt.json'))).toBe(true);
  });
});
