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
 * leaves the ring asleep and consistent (reads, writes and dumps agree): a
 * reader retries at once and sees the refusal, a dump inside the backoff
 * skips the wake and appends the held output to the `.buf`.
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
    // A reader retries at once, inside the backoff too; refused again, it
    // throws the refusal rather than pass the held output off as the history.
    refuseNext('construct');
    expect(() => ring.readAll()).toThrow(/^ALLOC_FAILED: /);
    expect(() => ring.readAllWithGeometry()).not.toThrow(); // retried at once: this one wakes
    expect(ring.isHibernated).toBe(false);
    expect(ring.readAll().toString()).toBe('history+new');
    expect(ring.totalBytesWritten).toBe(11);
  });

  it('readers inside the backoff retry the wake at once and throw a refusal; a snapshot copy is just not made', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct', 3);
    expect(() => ring.readAll()).toThrow(/^ALLOC_FAILED: /);
    const attempts = fakeRingControl.constructs;
    expect(() => ring.readAllWithGeometry()).toThrow(/^ALLOC_FAILED: /);
    expect(ring.freezeNative()).toBeUndefined();
    expect(fakeRingControl.constructs).toBe(attempts + 2);
    expect(ring.isHibernated).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('history');
    // No clock moved: the next read wakes.
    expect(ring.readAll().toString()).toBe('history');
    expect(ring.isHibernated).toBe(false);
  });

  it('a dump inside the backoff after a refused wake skips the wake: no allocation, the held output is appended to the .buf', async () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    expect(await ring.hibernate(file, () => true)).toBeGreaterThan(0);
    refuseNext('construct');
    ring.write(Buffer.from('+new')); // the wake is refused: held
    const attempts = fakeRingControl.constructs;
    await ring.dumpToFile(file);
    ring.dumpToFileSyncAtomic(file);
    expect(fakeRingControl.constructs).toBe(attempts);
    expect(ring.isHibernated).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('history+new');
    // Past the backoff a dump wakes the ring again.
    now += 1001;
    ring.write(Buffer.from('!'));
    await ring.dumpToFile(file);
    expect(fakeRingControl.constructs).toBeGreaterThan(attempts);
    expect(ring.isHibernated).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('history+new!');
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
    expect(ring.clearGeneration).toBe(1);
    await ring.dumpToFile(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(ring.readAll().toString()).toBe('');
  });
});
