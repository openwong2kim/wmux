// Real-filesystem behaviour of the bounded tail reader: files larger than the
// read cap, truncation mid-write, rotation, and the FIFO refusal that keeps a
// hook-supplied path from blocking the daemon's event loop forever.
//
// Runtime config (`fileParallelism: false`) so tmpdir churn is deterministic.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { TAIL_BYTES, readTranscriptDelta, readTranscriptPage } from '../readTail';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-readtail-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One synthetic assistant entry, padded so a few thousand of them exceed 2MB. */
function entry(i: number, padBytes = 400): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `synthetic-${String(i).padStart(6, '0')}`,
    timestamp: new Date(Date.UTC(2026, 6, 27, 0, 0, i % 60)).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `line ${i} ${'x'.repeat(padBytes)}` }] },
  });
}

function writeEntries(file: string, count: number): void {
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) chunks.push(entry(i));
  fs.writeFileSync(file, chunks.join('\n') + '\n', 'utf8');
}

describe('readTranscriptPage — file far larger than the cap', () => {
  it('reads at most TAIL_BYTES and discards the partial head line', () => {
    const file = path.join(dir, 'big.jsonl');
    writeEntries(file, 4000);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(2 * 1024 * 1024);

    const page = readTranscriptPage(file)!;
    expect(page.truncatedHead).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.cursor.fileSize).toBe(size);
    expect(page.cursor.tailOffset).toBe(size);
    // The window never exceeds the cap, and the head offset sits inside it.
    expect(size - page.cursor.headOffset).toBeLessThanOrEqual(TAIL_BYTES);
    expect(page.cursor.headOffset).toBeGreaterThan(0);

    // Every event came from a COMPLETE line: the partial head was dropped, so
    // no event is missing its text.
    for (const event of page.events) {
      if (event.kind === 'assistant_text') expect(event.text).toMatch(/^line \d+ x+$/);
    }

    // The head offset is a real line boundary.
    const fd = fs.openSync(file, 'r');
    try {
      const probe = Buffer.alloc(1);
      fs.readSync(fd, probe, 0, 1, page.cursor.headOffset);
      expect(probe.toString('utf8')).toBe('{');
      fs.readSync(fd, probe, 0, 1, page.cursor.headOffset - 1);
      expect(probe.toString('utf8')).toBe('\n');
    } finally {
      fs.closeSync(fd);
    }
  });

  it('pages BACKWARD from a previous headOffset in bounded chunks', () => {
    const file = path.join(dir, 'big.jsonl');
    writeEntries(file, 4000);

    const first = readTranscriptPage(file)!;
    const second = readTranscriptPage(file, { before: first.cursor.headOffset })!;
    expect(second.cursor.tailOffset).toBe(first.cursor.headOffset);
    expect(second.cursor.headOffset).toBeLessThan(first.cursor.headOffset);
    expect(first.cursor.headOffset - second.cursor.headOffset).toBeLessThanOrEqual(TAIL_BYTES);
    expect(second.truncatedHead).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(second.events.length).toBeGreaterThan(0);

    // Walking head-ward terminates at offset 0 with hasMore:false.
    let cursor = second.cursor.headOffset;
    let guard = 0;
    let last = second;
    while (cursor > 0 && guard++ < 200) {
      last = readTranscriptPage(file, { before: cursor })!;
      cursor = last.cursor.headOffset;
    }
    expect(cursor).toBe(0);
    expect(last.hasMore).toBe(false);
    expect(last.truncatedHead).toBe(false);
  });

  it('caps a delta read too, and the next delta picks up the remainder', () => {
    const file = path.join(dir, 'big.jsonl');
    writeEntries(file, 4000);
    const size = fs.statSync(file).size;

    const first = readTranscriptDelta(file, 0)!;
    expect(first.reset).toBe(false);
    expect(first.cursor.tailOffset).toBeLessThan(size);
    expect(first.cursor.tailOffset - first.cursor.headOffset).toBeLessThanOrEqual(TAIL_BYTES);

    let offset = first.cursor.tailOffset;
    let guard = 0;
    while (offset < size && guard++ < 200) {
      const next = readTranscriptDelta(file, offset)!;
      expect(next.reset).toBe(false);
      expect(next.cursor.tailOffset).toBeGreaterThan(offset);
      offset = next.cursor.tailOffset;
    }
    expect(offset).toBe(size);
  });

  it('advances past a single entry larger than the cap instead of livelocking', () => {
    const file = path.join(dir, 'huge-line.jsonl');
    const huge = JSON.stringify({
      type: 'assistant',
      uuid: 'huge-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(TAIL_BYTES + 5000) }] },
    });
    fs.writeFileSync(file, huge + '\n' + entry(1) + '\n', 'utf8');

    const first = readTranscriptDelta(file, 0)!;
    // No complete line fit in the window, so the reader skipped the window
    // rather than returning the same offset forever.
    expect(first.events).toEqual([]);
    expect(first.cursor.tailOffset).toBeGreaterThan(0);

    let offset = first.cursor.tailOffset;
    let guard = 0;
    const size = fs.statSync(file).size;
    while (offset < size && guard++ < 20) {
      const next = readTranscriptDelta(file, offset)!;
      expect(next.cursor.tailOffset).toBeGreaterThan(offset);
      offset = next.cursor.tailOffset;
    }
    expect(offset).toBe(size);
  });
});

describe('readTranscriptPage — truncated mid-write', () => {
  it('keeps the last COMPLETE entry and shows no zero-fill artifact', () => {
    const file = path.join(dir, 'partial.jsonl');
    const complete = [entry(1), entry(2)].join('\n') + '\n';
    // A half-written final line: exactly what a reader racing the writer sees.
    fs.writeFileSync(file, complete + '{"type":"assistant","uuid":"synthetic-000003","mess', 'utf8');

    const page = readTranscriptPage(file)!;
    expect(page.events).toHaveLength(2);
    expect(page.cursor.tailOffset).toBe(Buffer.byteLength(complete, 'utf8'));
    expect(page.cursor.tailOffset).toBeLessThan(page.cursor.fileSize);
    const serialized = JSON.stringify(page.events);
    expect(serialized).not.toContain('\u0000');
    expect(serialized).not.toContain('synthetic-000003');
  });

  it('a shrinking file (truncation) makes the next delta a reset', () => {
    const file = path.join(dir, 'shrink.jsonl');
    writeEntries(file, 50);
    const before = readTranscriptDelta(file, 0)!;
    expect(before.reset).toBe(false);

    fs.writeFileSync(file, entry(0) + '\n', 'utf8');
    const after = readTranscriptDelta(file, before.cursor.tailOffset)!;
    expect(after.reset).toBe(true);
    expect(after.events).toHaveLength(1);
    expect(after.cursor.tailOffset).toBe(fs.statSync(file).size);
  });
});

describe('readTranscript* — rotation', () => {
  it('reports reset when the file is replaced by a smaller one', () => {
    const file = path.join(dir, 'rotate.jsonl');
    writeEntries(file, 200);
    const before = readTranscriptDelta(file, 0)!;

    // Atomic replace, the way a rotation or a fresh session arrives.
    const replacement = path.join(dir, 'rotate.next');
    fs.writeFileSync(replacement, entry(999) + '\n', 'utf8');
    fs.renameSync(replacement, file);

    const after = readTranscriptDelta(file, before.cursor.tailOffset)!;
    expect(after.reset).toBe(true);
    expect(after.events).toHaveLength(1);
  });

  it('returns null once the file is deleted', () => {
    const file = path.join(dir, 'gone.jsonl');
    writeEntries(file, 5);
    expect(readTranscriptPage(file)).not.toBeNull();
    fs.rmSync(file);
    expect(readTranscriptPage(file)).toBeNull();
    expect(readTranscriptDelta(file, 0)).toBeNull();
  });
});

describe('readTranscript* — FIFO refusal', () => {
  const isWin32 = process.platform === 'win32';

  it.skipIf(isWin32)('RETURNS on a FIFO instead of blocking on open', () => {
    const fifo = path.join(dir, 'transcript.fifo');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      // No mkfifo on this runner — the lstat guard is covered by the directory
      // case in the unit tests.
      return;
    }
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);

    // The assertion IS that these calls return at all: openSync on a FIFO with
    // no writer blocks forever and there is no timeout that could rescue it.
    const startedAt = Date.now();
    expect(readTranscriptPage(fifo)).toBeNull();
    expect(readTranscriptDelta(fifo, 0)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
