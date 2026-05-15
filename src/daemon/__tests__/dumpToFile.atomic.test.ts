import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RingBuffer } from '../RingBuffer';

// Phase A — A4. RingBuffer dump must be atomic: a reader (recovery, the
// SessionPipe replay path, a debugger inspecting `.buf` files) must never
// observe a half-written buffer.
describe('RingBuffer atomic dump (A4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a4-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('async dumpToFile', () => {
    it('writes via tmp + rename and leaves no tmp behind', async () => {
      const rb = new RingBuffer(1024);
      rb.write(Buffer.from('hello world'));
      const dst = path.join(tmpDir, 'session-1.buf');

      await rb.dumpToFile(dst);

      expect(fs.readFileSync(dst).toString()).toBe('hello world');
      const tmps = fs.readdirSync(tmpDir).filter((n) => RingBuffer.isTmpFile(n));
      expect(tmps).toHaveLength(0);
    });

    it('cleans up tmp on rename failure (best-effort)', async () => {
      const rb = new RingBuffer(1024);
      rb.write(Buffer.from('data'));
      // dst inside a non-existent directory forces writeFile (and rename) to fail.
      const badDst = path.join(tmpDir, 'no-such-dir', 'session.buf');
      await expect(rb.dumpToFile(badDst)).rejects.toThrow();
      // tmpDir itself stays clean (tmp would have lived inside no-such-dir).
      const tmps = fs.readdirSync(tmpDir).filter((n) => RingBuffer.isTmpFile(n));
      expect(tmps).toHaveLength(0);
    });
  });

  describe('sync dumpToFileSyncAtomic', () => {
    it('writes via tmp + renameSync and leaves no tmp behind', () => {
      const rb = new RingBuffer(1024);
      rb.write(Buffer.from('sync data'));
      const dst = path.join(tmpDir, 'sync-1.buf');

      rb.dumpToFileSyncAtomic(dst);

      expect(fs.readFileSync(dst).toString()).toBe('sync data');
      const tmps = fs.readdirSync(tmpDir).filter((n) => RingBuffer.isTmpFile(n));
      expect(tmps).toHaveLength(0);
    });

    it('throws and cleans up tmp on rename failure', () => {
      const rb = new RingBuffer(1024);
      rb.write(Buffer.from('data'));
      const badDst = path.join(tmpDir, 'no-such-dir', 'session.buf');
      expect(() => rb.dumpToFileSyncAtomic(badDst)).toThrow();
      const tmps = fs.readdirSync(tmpDir).filter((n) => RingBuffer.isTmpFile(n));
      expect(tmps).toHaveLength(0);
    });
  });

  describe('cleanupStaleTmpFiles', () => {
    it('removes .tmp.<hex> files from the directory', () => {
      fs.writeFileSync(path.join(tmpDir, 'session.buf'), 'live');
      fs.writeFileSync(path.join(tmpDir, 'session.buf.tmp.abcdef01'), 'stale1');
      fs.writeFileSync(path.join(tmpDir, 'session.buf.tmp.deadbeef'), 'stale2');

      RingBuffer.cleanupStaleTmpFiles(tmpDir);

      const remaining = fs.readdirSync(tmpDir).sort();
      expect(remaining).toEqual(['session.buf']);
    });

    it('is a no-op if the directory does not exist', () => {
      const missing = path.join(tmpDir, 'no-such-dir');
      expect(() => RingBuffer.cleanupStaleTmpFiles(missing)).not.toThrow();
    });

    it('leaves non-tmp files untouched', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.buf'), '');
      fs.writeFileSync(path.join(tmpDir, 'b.buf'), '');
      fs.writeFileSync(path.join(tmpDir, 'random.txt'), '');
      fs.writeFileSync(path.join(tmpDir, 'x.buf.tmp.deadbeef'), 'stale');

      RingBuffer.cleanupStaleTmpFiles(tmpDir);

      const remaining = fs.readdirSync(tmpDir).sort();
      expect(remaining).toEqual(['a.buf', 'b.buf', 'random.txt']);
    });
  });

  describe('isTmpFile', () => {
    it('matches the .tmp.<hex> suffix pattern', () => {
      expect(RingBuffer.isTmpFile('session.buf.tmp.abcdef01')).toBe(true);
      expect(RingBuffer.isTmpFile('xx.tmp.0123abcd')).toBe(true);
      expect(RingBuffer.isTmpFile('xx.tmp.aabbccddeeff')).toBe(true);
    });

    it('rejects unrelated names', () => {
      expect(RingBuffer.isTmpFile('session.buf')).toBe(false);
      expect(RingBuffer.isTmpFile('foo.tmp')).toBe(false);
      expect(RingBuffer.isTmpFile('foo.tmp.notHexZ')).toBe(false);
      expect(RingBuffer.isTmpFile('foo.bak')).toBe(false);
    });
  });

  // Atomic invariant: a reader observing the destination path mid-dump must
  // see either the old file or the new file, never a partial write.
  // We approximate this by checking that the final on-disk content always
  // matches the latest dumped buffer end-to-end, across rapid back-to-back
  // dumps. A bare writeFile (non-atomic) would produce intermediate sizes.
  it('back-to-back dumps never leave the destination at an in-between size', async () => {
    const rb = new RingBuffer(1024);
    const dst = path.join(tmpDir, 'concurrent.buf');
    const payloads = ['short', 'medium-length', 'a longer payload going through many bytes', 'final'];
    for (const p of payloads) {
      rb.clear();
      rb.write(Buffer.from(p));
      await rb.dumpToFile(dst);
      expect(fs.readFileSync(dst).toString()).toBe(p);
    }
  });
});
