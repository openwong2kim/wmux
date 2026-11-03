import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../RingBuffer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const CHUNK = 256 * 1024;

/** Terminal-like output: repetitive lines (compressible) with a noisy stretch. */
function output(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = i % 4096 < 3072 ? 0x20 + ((i + seed) % 80) : x >>> 24;
  }
  return out;
}

// A digest: a deep equality walk over megabytes of Buffer is far too slow.
const digest = (data: Buffer) => `${data.length}:${crypto.createHash('sha256').update(data).digest('hex')}`;

/** Every read the daemon makes of a ring, for byte-for-byte comparison. */
function reads(ring: RingBuffer) {
  const { data, ...withGeometry } = ring.readAllWithGeometry();
  return {
    all: digest(ring.readAll()),
    withGeometry: { ...withGeometry, data: digest(data) },
    size: ring.size,
    total: ring.totalBytesWritten,
    geometryChanges: ring.hasGeometryChanges,
    hibernated: ring.isHibernated,
  };
}

describe('RingBuffer compression', () => {
  it('serves the same bytes as a plain ring through chunk edges, overflow, geometry and hibernation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rb-compress-'));
    dirs.push(dir);
    const capacity = 4 * CHUNK + 12_345; // not a whole number of chunks
    const plain = new RingBuffer(capacity, 'node');
    const packed = new RingBuffer(capacity, 'node', { compress: true });
    const both = (fn: (ring: RingBuffer) => void) => { fn(plain); fn(packed); };
    const check = () => expect(reads(packed)).toEqual(reads(plain));

    both((r) => r.noteGeometry(120, 30));
    // Exactly one chunk, one byte past an edge, a run of PTY-sized writes,
    // then a write larger than the whole ring.
    for (const [i, size] of [CHUNK, 1, CHUNK - 1, 4096, 65536, 16384].entries()) {
      const data = output(size, i);
      both((r) => r.write(data));
      check();
    }
    both((r) => r.noteGeometry(80, 24));
    for (let i = 0; i < 40; i++) {
      const data = output(4096 + ((i * 7919) % 61440), 100 + i);
      both((r) => r.write(data));
      if (i % 9 === 0) both((r) => r.noteGeometry(80 + i, 24));
    }
    check();
    const huge = output(capacity + CHUNK + 7, 999);
    both((r) => r.write(huge));
    check();
    both((r) => r.noteGeometry(100, 40));
    both((r) => r.write(output(300_000, 7)));
    check();
    expect(packed.allocatedBytes).toBeLessThan(plain.allocatedBytes / 2);

    // Hibernate, read back from the file, keep writing after the wake.
    const plainFile = path.join(dir, 'plain.buf');
    const packedFile = path.join(dir, 'packed.buf');
    const plainReleased = await plain.hibernate(plainFile, () => true);
    const packedReleased = await packed.hibernate(packedFile, () => true);
    expect(plainReleased).toBeGreaterThan(0);
    expect(packedReleased).toBeGreaterThan(0);
    expect(digest(fs.readFileSync(packedFile))).toBe(digest(fs.readFileSync(plainFile)));
    check(); // the read wakes both
    both((r) => r.write(output(CHUNK + 3, 42)));
    check();
    both((r) => r.dumpToFileSyncAtomic(path.join(dir, r === plain ? 'plain.dump' : 'packed.dump')));
    expect(digest(fs.readFileSync(path.join(dir, 'packed.dump')))).toBe(digest(fs.readFileSync(path.join(dir, 'plain.dump'))));

    both((r) => r.clear());
    check();
    expect(packed.allocatedBytes).toBeLessThanOrEqual(CHUNK);
    both((r) => r.write(output(5000, 3)));
    check();
  });

  it('keeps a ring smaller than one chunk within its capacity', () => {
    const plain = new RingBuffer(100_003, 'node');
    const packed = new RingBuffer(100_003, 'node', { compress: true });
    for (let i = 0; i < 30; i++) {
      const data = output(1 + ((i * 15_013) % 70_000), i);
      plain.write(data);
      packed.write(data);
      expect(reads(packed)).toEqual(reads(plain));
    }
    expect(packed.size).toBe(100_003);
  });
});
