// @wmux-lane integration — writes and reads real .buf files in a mkdtemp directory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../RingBuffer';
import { fakeRingControl, fakeRingModule, refuseNext, resetFakeRing } from './_fakeNativeRing';

/**
 * #3440, the paths that touch the ring's `.buf`: a refused full read never
 * replaces a good dump, and a native ring that cannot be re-created on wake
 * leaves the ring asleep and consistent (reads, writes and dumps agree).
 */
vi.mock('../../shared/nativeTerminalCore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/nativeTerminalCore')>(),
  loadNativeTerminalCore: vi.fn(() => fakeRingModule),
}));

describe('RingBuffer (rust) .buf paths: a refused native allocation', () => {
  let dir: string;
  let file: string;
  // The wake backoff is a second of Date.now(); the tests move this clock.
  let now = 1_700_000_000_000;
  beforeEach(() => {
    resetFakeRing();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ring-alloc-'));
    file = path.join(dir, 'session.buf');
  });
  afterEach(() => {
    resetFakeRing();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a dump whose read is refused fails and leaves the last good .buf untouched', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    await ring.dumpToFile(file);
    ring.write(Buffer.from(' more'));
    refuseNext('readAll');
    await expect(ring.dumpToFile(file)).rejects.toThrow(/^ALLOC_FAILED: /);
    expect(fs.readFileSync(file, 'utf8')).toBe('history');
    refuseNext('readAll');
    expect(() => ring.dumpToFileSyncAtomic(file)).toThrow(/^ALLOC_FAILED: /);
    expect(fs.readFileSync(file, 'utf8')).toBe('history');
    expect(fs.readdirSync(dir)).toEqual(['session.buf']);
  });

  it('a hibernation whose release read is refused keeps the ring in memory', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    await ring.dumpToFile(file);
    refuseNext('readAllWithGeometry');
    await expect(ring.hibernate(file, () => true)).rejects.toThrow(/^ALLOC_FAILED: /);
    expect(ring.isHibernated).toBe(false);
    expect(ring.readAll().toString()).toBe('history');
  });

  it('stays asleep when waking is refused, holds output meanwhile, and wakes with all of it later', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct');
    expect(() => ring.write(Buffer.from('+new'))).not.toThrow();
    expect(ring.isHibernated).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('history');
    // Past the backoff a reader retries; refused again, it still gets the
    // held output, never a throw.
    now += 1001;
    refuseNext('construct');
    expect(ring.readAll().toString()).toBe('+new');
    expect(ring.isHibernated).toBe(true);
    expect(ring.readAll().toString()).toBe('+new');
    now += 1001;
    expect(ring.readAll().toString()).toBe('history+new');
    expect(ring.isHibernated).toBe(false);
    expect(ring.totalBytesWritten).toBe(11);
  });

  it('after a refused wake, reads and dumps inside the backoff neither re-read the .buf nor retry the allocation', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct');
    expect(ring.readAll().toString()).toBe('');
    const attempts = fakeRingControl.constructs;
    // The allocation would now succeed, but every access inside the second
    // serves what is held and leaves the file alone.
    ring.write(Buffer.from('+new'));
    expect(ring.readAll().toString()).toBe('+new');
    expect(ring.readAllWithGeometry().data.toString()).toBe('+new');
    await ring.dumpToFile(file);
    expect(fakeRingControl.constructs).toBe(attempts);
    expect(ring.isHibernated).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('history+new');
    now += 1001;
    expect(ring.readAll().toString()).toBe('history+new');
    expect(fakeRingControl.constructs).toBe(attempts + 1);
    expect(ring.isHibernated).toBe(false);
  });

  it('a full held output that cannot become the ring is kept as its newest bytes, and a dump writes exactly those', async () => {
    const ring = new RingBuffer(16, 'rust');
    ring.write(Buffer.from('old-history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct', 2);
    ring.write(Buffer.from('abcdefghij')); // the wake is refused (1): held
    ring.write(Buffer.from('klmnopqrst')); // held output fills the ring: re-creating it is refused (2)
    expect(ring.isHibernated).toBe(true);
    await ring.dumpToFile(file); // inside the backoff the dump does not wake: the file is rewritten from the held bytes
    expect(fs.readFileSync(file, 'utf8')).toBe('efghijklmnopqrst');
    now += 1001;
    expect(ring.readAll().toString()).toBe('efghijklmnopqrst');
    expect(ring.isHibernated).toBe(false);
    expect(ring.totalBytesWritten).toBe(31);
  });

  it('a clear while asleep that cannot re-create the ring empties it, and the next dump empties the .buf', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('secret history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct');
    expect(() => ring.clear()).not.toThrow();
    expect(ring.size).toBe(0);
    await ring.dumpToFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(ring.readAll().toString()).toBe('');
  });
});
