import type { NativeFrozenRing, NativeOutputChunk, NativeRingStorage } from '../../shared/nativeTerminalCore';
import type { ReplayGeometry } from '../RingBuffer';

/**
 * A JS stand-in for the native ring (`ring-v1`) whose calls can be told to
 * refuse an allocation the way the native core does (#3440): throw
 * `ALLOC_FAILED: ...` and leave the ring exactly as it was.
 */
export type FakeRingCall = 'construct' | 'write' | 'writeChunk' | 'readAll' | 'readAllWithGeometry' | 'freeze' | 'noteGeometry';

export const fakeRingControl: { refuse: Map<FakeRingCall, number | Error>; live: Set<FakeNativeRing>; constructs: number } = {
  refuse: new Map(),
  live: new Set(),
  /** Every attempt to create a ring, refused ones included. */
  constructs: 0,
};

export function allocRefusal(what = 'ring'): Error {
  return new Error(`ALLOC_FAILED: could not allocate 144924 bytes for ${what}`);
}

/** Refuse the next `times` calls of `call` with an ALLOC_FAILED (or the given error, once). */
export function refuseNext(call: FakeRingCall, times: number | Error = 1): void {
  fakeRingControl.refuse.set(call, times);
}

export function resetFakeRing(): void {
  fakeRingControl.refuse.clear();
  fakeRingControl.live.clear();
  fakeRingControl.constructs = 0;
}

function check(call: FakeRingCall): void {
  const left = fakeRingControl.refuse.get(call);
  if (left === undefined) return;
  if (left instanceof Error) { fakeRingControl.refuse.delete(call); throw left; }
  if (left <= 1) fakeRingControl.refuse.delete(call);
  else fakeRingControl.refuse.set(call, left - 1);
  throw allocRefusal(call);
}

export class FakeNativeRing implements NativeRingStorage {
  private data = Buffer.alloc(0);
  private written = 0;
  private marks: Array<{ at: number; cols: number; rows: number }> = [];
  disposed = false;

  constructor(private readonly capacity: number) {
    fakeRingControl.constructs++;
    check('construct');
    fakeRingControl.live.add(this);
  }
  get size(): number { return this.data.length; }
  get allocatedBytes(): number { return this.data.length; }
  get totalBytesWritten(): number { return this.written; }
  get hasGeometryChanges(): boolean { return this.marks.length > 1; }
  write(bytes: Uint8Array): void {
    check('write');
    const next = Buffer.concat([this.data, Buffer.from(bytes)]);
    this.data = next.length > this.capacity ? next.subarray(next.length - this.capacity) : next;
    this.written += bytes.length;
  }
  writeChunk(chunk: NativeOutputChunk): void {
    check('writeChunk');
    this.write(chunk.readBytes());
  }
  clear(): void { this.data = Buffer.alloc(0); }
  readAll(): Buffer {
    check('readAll');
    return Buffer.from(this.data);
  }
  noteGeometry(cols: number, rows: number): void {
    check('noteGeometry');
    this.marks.push({ at: this.written, cols, rows });
  }
  settleGeometry(): void { /* every mark is applied here */ }
  readAllWithGeometry(): { data: Buffer; writtenAt: number; geometry?: ReplayGeometry | null } {
    check('readAllWithGeometry');
    const start = this.written - this.data.length;
    const [first, ...rest] = this.marks;
    return {
      data: Buffer.from(this.data),
      writtenAt: this.written,
      geometry: first ? { start: { cols: first.cols, rows: first.rows }, changes: rest.map((m) => ({ offset: Math.max(0, m.at - start), cols: m.cols, rows: m.rows })) } : null,
    };
  }
  dispose(): void { this.disposed = true; fakeRingControl.live.delete(this); }
  freeze(): NativeFrozenRing {
    check('freeze');
    const data = Buffer.from(this.data);
    const writtenAt = this.written;
    return { size: data.length, writtenAt, geometry: null, readAll: () => Buffer.from(data), dispose: () => undefined };
  }
}

/** The `loadNativeTerminalCore` result a RingBuffer needs (`ring-v1`). */
export const fakeRingModule = { NativeRing: FakeNativeRing };
