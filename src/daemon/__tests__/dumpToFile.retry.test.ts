import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fix A (axis 2): the async `.buf` dump rename gets a bounded win32-only retry
// for transient handle locks (AV scan / concurrent reader), and dumps to the
// SAME destination are serialized so a retry-delayed older dump can't overwrite
// a newer one (codex #4). We mock node:fs/promises to drive rename outcomes
// deterministically without a real Windows lock; the in-memory RingBuffer parts
// (write/readAll) are untouched.
const mocks = vi.hoisted(() => ({
  rename: vi.fn<(from: string, to: string) => Promise<void>>(),
  writeFile: vi.fn(async () => { /* no-op stub */ }),
  unlink: vi.fn(async () => { /* no-op stub */ }),
}));
vi.mock('node:fs/promises', () => ({
  rename: mocks.rename,
  writeFile: mocks.writeFile,
  unlink: mocks.unlink,
}));

import { RingBuffer } from '../RingBuffer';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
const errWithCode = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  mocks.rename.mockReset();
  mocks.writeFile.mockClear();
  mocks.unlink.mockClear();
});
afterEach(() => {
  setPlatform(realPlatform);
});

describe('RingBuffer.dumpToFile — win32 transient rename retry', () => {
  it('retries a transient EPERM on win32 and eventually succeeds', async () => {
    setPlatform('win32');
    mocks.rename
      .mockRejectedValueOnce(errWithCode('EPERM'))
      .mockRejectedValueOnce(errWithCode('EBUSY'))
      .mockResolvedValueOnce(undefined);
    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('x'));

    await expect(rb.dumpToFile('C:/tmp/s.buf')).resolves.toBeUndefined();
    expect(mocks.rename).toHaveBeenCalledTimes(3); // 2 transient failures + success
    expect(mocks.unlink).not.toHaveBeenCalled(); // no tmp cleanup on eventual success
  });

  it('gives up after exhausting the backoff ladder and cleans up the tmp', async () => {
    setPlatform('win32');
    mocks.rename.mockRejectedValue(errWithCode('EACCES')); // never releases
    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('x'));

    await expect(rb.dumpToFile('C:/tmp/s.buf')).rejects.toThrow('EACCES');
    expect(mocks.rename).toHaveBeenCalledTimes(5); // 1 initial + 4 backoff attempts
    expect(mocks.unlink).toHaveBeenCalledTimes(1); // tmp cleaned up on final failure
  });

  it('does NOT retry on non-win32 — single rename, immediate throw', async () => {
    setPlatform('linux');
    mocks.rename.mockRejectedValue(errWithCode('EPERM'));
    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('x'));

    await expect(rb.dumpToFile('/tmp/s.buf')).rejects.toThrow('EPERM');
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-transient code even on win32', async () => {
    setPlatform('win32');
    mocks.rename.mockRejectedValue(errWithCode('ENOSPC'));
    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('x'));

    await expect(rb.dumpToFile('C:/tmp/s.buf')).rejects.toThrow('ENOSPC');
    expect(mocks.rename).toHaveBeenCalledTimes(1); // disk-full is not a transient lock
  });
});

describe('RingBuffer.dumpToFile — per-destination serialization (codex #4)', () => {
  it('serializes overlapping dumps to the SAME path: newest enqueued renames last', async () => {
    setPlatform('linux');
    const completed: number[] = [];
    let n = 0;
    // The FIRST rename is slow. Without serialization the second (fast) rename
    // would complete first → completed = [2,1]. Serialization forces [1,2].
    mocks.rename.mockImplementation(async () => {
      const id = ++n;
      if (id === 1) await new Promise((r) => setTimeout(r, 30));
      completed.push(id);
    });

    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('a'));
    const p1 = rb.dumpToFile('/tmp/same.buf');
    const p2 = rb.dumpToFile('/tmp/same.buf');
    await Promise.all([p1, p2]);

    expect(mocks.rename).toHaveBeenCalledTimes(2);
    expect(completed).toEqual([1, 2]); // first-enqueued finished before second started
  });

  it('a failing dump does not skip a dump queued behind it on the same path', async () => {
    setPlatform('linux');
    mocks.rename
      .mockRejectedValueOnce(errWithCode('EIO'))
      .mockResolvedValueOnce(undefined);
    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('a'));

    const p1 = rb.dumpToFile('/tmp/same.buf'); // fails
    const p2 = rb.dumpToFile('/tmp/same.buf'); // must still run
    await expect(p1).rejects.toThrow('EIO');
    await expect(p2).resolves.toBeUndefined();
    expect(mocks.rename).toHaveBeenCalledTimes(2);
  });

  it('independent paths are not serialized against each other', async () => {
    setPlatform('linux');
    mocks.rename.mockResolvedValue(undefined);
    const rb = new RingBuffer(1024);
    rb.write(Buffer.from('a'));

    await Promise.all([rb.dumpToFile('/tmp/one.buf'), rb.dumpToFile('/tmp/two.buf')]);
    expect(mocks.rename).toHaveBeenCalledTimes(2);
  });
});
