import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../RingBuffer';
import { nativeCorePath } from '../../shared/nativeTerminalCore';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  vi.unstubAllEnvs();
});

// The rust rows need the built module: they skip without it, and fail under
// WMUX_REQUIRE_RUST_CORE.
const modulePath = nativeCorePath();
const native = fs.existsSync(modulePath);
if (!native && process.env.WMUX_REQUIRE_RUST_CORE) throw new Error(`native core missing: ${modulePath}`);

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

describe.each([
  { backend: 'node' as const, skip: false },
  { backend: 'rust' as const, skip: !native },
])('RingBuffer compression ($backend ring)', ({ backend, skip }) => {
  const ring = (capacity: number, compress = false) => {
    if (backend === 'rust') vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath);
    const made = new RingBuffer(capacity, backend, { compress });
    expect(made.backend).toBe(backend);
    return made;
  };

  it.skipIf(skip)('serves the same bytes as a plain ring through chunk edges, overflow, geometry and hibernation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rb-compress-'));
    dirs.push(dir);
    const capacity = 4 * CHUNK + 12_345; // not a whole number of chunks
    const plain = ring(capacity);
    const packed = ring(capacity, true);
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
    // The woken ring compresses again.
    expect(packed.allocatedBytes).toBeLessThan(plain.allocatedBytes / 2);
    // A native snapshot copy holds the same bytes.
    const frozen = (r: RingBuffer) => {
      const copy = r.freezeNative();
      if (!copy) return null;
      const result = { data: digest(copy.readAll()), writtenAt: copy.writtenAt, size: copy.size, geometry: copy.geometry };
      copy.dispose();
      return result;
    };
    const frozenPlain = frozen(plain);
    expect(frozenPlain === null).toBe(backend === 'node');
    expect(frozen(packed)).toEqual(frozenPlain);
    both((r) => r.dumpToFileSyncAtomic(path.join(dir, r === plain ? 'plain.dump' : 'packed.dump')));
    expect(digest(fs.readFileSync(path.join(dir, 'packed.dump')))).toBe(digest(fs.readFileSync(path.join(dir, 'plain.dump'))));

    both((r) => r.clear());
    check();
    expect(packed.allocatedBytes).toBeLessThanOrEqual(CHUNK);
    both((r) => r.write(output(5000, 3)));
    check();
  });

  it.skipIf(skip)('keeps a ring smaller than one chunk within its capacity', () => {
    const plain = ring(100_003);
    const packed = ring(100_003, true);
    for (let i = 0; i < 30; i++) {
      const data = output(1 + ((i * 15_013) % 70_000), i);
      plain.write(data);
      packed.write(data);
      expect(reads(packed)).toEqual(reads(plain));
    }
    expect(packed.size).toBe(100_003);
  });
});

describe('a dump of a compressed rust ring', () => {
  it.skipIf(!native)('writes nothing when the ring is disposed while its bytes are read', async () => {
    vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rb-dispose-'));
    dirs.push(dir);
    const packed = new RingBuffer(4 * CHUNK, 'rust', { compress: true });
    packed.write(output(3 * CHUNK, 1));
    // The session is destroyed while the worker decompresses (index.ts
    // disposes the ring, then deletes its .buf).
    const storage = (packed as unknown as { native: { readAllAsync(): Promise<Buffer> } }).native;
    const read = storage.readAllAsync.bind(storage);
    storage.readAllAsync = async () => {
      const bytes = await read();
      packed.dispose();
      return bytes;
    };
    await packed.dumpToFile(path.join(dir, 'session.buf'));
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
