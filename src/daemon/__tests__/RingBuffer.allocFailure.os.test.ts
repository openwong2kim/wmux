// @wmux-lane integration — writes and reads real .buf files in a mkdtemp directory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../RingBuffer';
import { fakeRingModule, refuseNext, resetFakeRing } from './_fakeNativeRing';

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
  beforeEach(() => {
    resetFakeRing();
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
    refuseNext('construct');
    // A reader still gets the held output, never a throw.
    expect(ring.readAll().toString()).toBe('+new');
    expect(ring.isHibernated).toBe(true);
    expect(ring.readAll().toString()).toBe('history+new');
    expect(ring.isHibernated).toBe(false);
    expect(ring.totalBytesWritten).toBe(11);
  });

  it('a full held output that cannot become the ring is kept as its newest bytes, and a dump writes exactly those', async () => {
    const ring = new RingBuffer(16, 'rust');
    ring.write(Buffer.from('old-history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct', 3);
    ring.write(Buffer.from('abcdefghij')); // the wake is refused (1): held
    ring.write(Buffer.from('klmnopqrst')); // held output fills the ring: re-creating it is refused (2)
    expect(ring.isHibernated).toBe(true);
    await ring.dumpToFile(file); // the dump's wake is refused (3): the file is rewritten from the held bytes
    expect(fs.readFileSync(file, 'utf8')).toBe('efghijklmnopqrst');
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
