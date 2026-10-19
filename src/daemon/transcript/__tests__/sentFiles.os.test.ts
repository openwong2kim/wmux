import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGrantSpellings, SentFileIndex, SENT_FILE_MAX_AGE_MS, sentFileParts } from '../sentFiles';

let dir: string;
let transcript: string;
let seq = 0;
const NOW = Date.parse('2026-10-03T12:00:00.000Z');

/** One SendUserFile call and (unless `answered: false`) its result. */
function send(files: unknown, opts: { at?: number; isError?: boolean; answered?: boolean } = {}): string {
  const id = `toolu_${++seq}`;
  const timestamp = new Date(opts.at ?? NOW).toISOString();
  const lines = [JSON.stringify({
    type: 'assistant', timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendUserFile', input: { files } }] },
  })];
  if (opts.answered !== false) {
    lines.push(JSON.stringify({
      type: 'user', timestamp,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(opts.isError ? { is_error: true } : {}) }] },
    }));
  }
  return `${lines.join('\n')}\n`;
}

/** A filler line of exactly `bytes` bytes, newline included. */
function filler(bytes: number): string {
  const head = '{"type":"system","pad":"';
  const tail = '"}\n';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sent-index-'));
  transcript = path.join(dir, 'session.jsonl');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SentFileIndex', () => {
  it('records a successful Read of an image path apart from sent files, and skips other Reads', async () => {
    const read = (filePath: string, isError = false, content: unknown = [{ type: 'image' }]): string => {
      const id = `toolu_${++seq}`;
      const timestamp = new Date(NOW).toISOString();
      return `${[JSON.stringify({
        type: 'assistant', timestamp,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: filePath } }] },
      }), JSON.stringify({
        type: 'user', timestamp,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
      })].join('\n')}\n`;
    };
    fs.writeFileSync(transcript, [
      read('/s/a.PNG'), read('/s/b.jpeg', true), read('/s/c.ts'), send(['/s/d.png']),
      read('/s/text.png', false, [{ type: 'text', text: 'not loaded' }]), read('/s/str.png', false, 'ok'),
    ].join(''));
    const index = new SentFileIndex();
    expect(await index.grantedAt(transcript, '/s/a.PNG', NOW, 'Read')).toBe(NOW);
    // A Read grant is not a SendUserFile grant, and the reverse.
    expect(await index.sentAt(transcript, '/s/a.PNG', NOW)).toBeNull();
    expect(await index.grantedAt(transcript, '/s/d.png', NOW, 'Read')).toBeNull();
    expect(await index.grantedAt(transcript, '/s/b.jpeg', NOW, 'Read')).toBeNull();
    expect(await index.grantedAt(transcript, '/s/c.ts', NOW, 'Read')).toBeNull();
    expect(await index.grantedAt(transcript, '/s/a.PNG', NOW + SENT_FILE_MAX_AGE_MS + 1, 'Read')).toBeNull();
    // A success with no image block in it grants nothing.
    expect(await index.grantedAt(transcript, '/s/text.png', NOW, 'Read')).toBeNull();
    expect(await index.grantedAt(transcript, '/s/str.png', NOW, 'Read')).toBeNull();
  });

  it('respells only a leading /tmp/ or /private/tmp/, and only on macOS', () => {
    expect(readGrantSpellings('/tmp/x/a.png', 'darwin')).toEqual(['/tmp/x/a.png', '/private/tmp/x/a.png']);
    expect(readGrantSpellings('/private/tmp/x/a.png', 'darwin')).toEqual(['/private/tmp/x/a.png', '/tmp/x/a.png']);
    expect(readGrantSpellings('/tmpx/a.png', 'darwin')).toEqual(['/tmpx/a.png']);
    expect(readGrantSpellings('/private/tmpx/a.png', 'darwin')).toEqual(['/private/tmpx/a.png']);
    expect(readGrantSpellings('/a/tmp/a.png', 'darwin')).toEqual(['/a/tmp/a.png']);
    expect(readGrantSpellings('/tmp/x/a.png', 'linux')).toEqual(['/tmp/x/a.png']);
  });

  it('answers a Read under its /tmp alias with the newest grant still inside the window', async () => {
    const read = (filePath: string, at: number): string => {
      const id = `toolu_${++seq}`;
      const timestamp = new Date(at).toISOString();
      return `${[JSON.stringify({
        type: 'assistant', timestamp,
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: filePath } }] },
      }), JSON.stringify({
        type: 'user', timestamp,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'image' }] }] },
      })].join('\n')}\n`;
    };
    const old = NOW - SENT_FILE_MAX_AGE_MS - 60_000;
    fs.writeFileSync(transcript, [
      read('/private/tmp/s/a.png', old), read('/tmp/s/a.png', NOW),
      read('/tmp/s/b.png', NOW - 1000), read('/private/tmp/s/b.png', NOW),
    ].join(''));
    const mac = new SentFileIndex({ platform: 'darwin' });
    // The exact spelling's grant is expired; the alias's newer one answers.
    expect(await mac.grantedAt(transcript, '/private/tmp/s/a.png', NOW, 'Read')).toBe(NOW);
    expect(await mac.grantedAt(transcript, '/tmp/s/b.png', NOW, 'Read')).toBe(NOW);
    // Not on other platforms, and never for SendUserFile.
    const linux = new SentFileIndex({ platform: 'linux' });
    expect(await linux.grantedAt(transcript, '/private/tmp/s/a.png', NOW, 'Read')).toBeNull();
  });

  it('lists every path of a successful call, byte for byte, inside the 24-hour window', async () => {
    fs.writeFileSync(transcript, send(['/s/a.png', '/s/한글.mp4']));
    const index = new SentFileIndex();
    expect(await index.sentAt(transcript, '/s/a.png', NOW)).toBe(NOW);
    expect(await index.sentAt(transcript, '/s/한글.mp4', NOW + SENT_FILE_MAX_AGE_MS)).toBe(NOW);
    expect(await index.sentAt(transcript, '/s/a.png', NOW + SENT_FILE_MAX_AGE_MS + 1)).toBeNull();
    expect(await index.sentAt(transcript, '/s/./a.png', NOW)).toBeNull();
    expect(await index.sentAt(transcript, '/s/b.png', NOW)).toBeNull();
  });

  it('ignores error results, unanswered calls, malformed inputs and calls without a timestamp', async () => {
    fs.writeFileSync(transcript, [
      send(['/s/err.png'], { isError: true }),
      send(['/s/open.png'], { answered: false }),
      send('/s/not-an-array.png'),
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_nots', name: 'SendUserFile', input: { files: ['/s/nots.png'] } }] } })}\n`,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_nots', content: 'ok' }] } })}\n`,
      '{not json SendUserFile\n',
    ].join(''));
    const index = new SentFileIndex();
    for (const p of ['/s/err.png', '/s/open.png', '/s/not-an-array.png', '/s/nots.png']) {
      expect(await index.sentAt(transcript, p, NOW)).toBeNull();
    }
  });

  it('ignores a SendUserFile call written as text: in a user message, or inside another tool\'s result', async () => {
    const fake = JSON.stringify({ type: 'tool_use', id: 'toolu_fake', name: 'SendUserFile', input: { files: ['/s/fake.png'] } });
    const timestamp = new Date(NOW).toISOString();
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'text', text: fake }] } }),
      JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: fake } }),
      JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'cat' } }] } }),
      JSON.stringify({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: fake }] } }),
      JSON.stringify({ type: 'user', timestamp, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fake', content: 'ok' }] } }),
      '',
    ].join('\n'));
    expect(await new SentFileIndex().sentAt(transcript, '/s/fake.png', NOW)).toBeNull();
  });

  it('reads a call that straddles the 1 MiB read boundary', async () => {
    fs.writeFileSync(transcript, filler(1024 * 1024 - 60) + send(['/s/straddle.png']));
    expect(await new SentFileIndex().sentAt(transcript, '/s/straddle.png', NOW)).toBe(NOW);
  });

  it('skips a line over 8 MiB and reads the next one', async () => {
    fs.writeFileSync(transcript, filler(9 * 1024 * 1024) + send(['/s/after-big.png']));
    expect(await new SentFileIndex().sentAt(transcript, '/s/after-big.png', NOW)).toBe(NOW);
  });

  it('reads only the last maxScanBytes on a first scan', async () => {
    fs.writeFileSync(transcript, send(['/s/early.png']) + filler(4096) + send(['/s/late.png']));
    const index = new SentFileIndex({ maxScanBytes: 2048 });
    expect(await index.sentAt(transcript, '/s/late.png', NOW)).toBe(NOW);
    expect(await index.sentAt(transcript, '/s/early.png', NOW)).toBeNull();
  });

  it('scans only what was appended, reuses an unchanged file, and rescans a replaced one', async () => {
    fs.writeFileSync(transcript, send(['/s/one.png']));
    const index = new SentFileIndex();
    expect(await index.sentAt(transcript, '/s/one.png', NOW)).toBe(NOW);
    expect(await index.sentAt(transcript, '/s/one.png', NOW)).toBe(NOW);
    expect(index.scans).toBe(1);

    // An unterminated call is not read until its line ends.
    const tail = send(['/s/two.png']);
    fs.appendFileSync(transcript, tail.slice(0, 40));
    expect(await index.sentAt(transcript, '/s/two.png', NOW)).toBeNull();
    fs.appendFileSync(transcript, tail.slice(40));
    expect(await index.sentAt(transcript, '/s/two.png', NOW)).toBe(NOW);
    expect(index.scans).toBe(3);

    // A new session in the same file name (replaced, not appended): the old list is gone.
    const replacement = path.join(dir, 'next.jsonl');
    fs.writeFileSync(replacement, send(['/s/three.png']));
    fs.renameSync(replacement, transcript);
    expect(await index.sentAt(transcript, '/s/three.png', NOW)).toBe(NOW);
    expect(await index.sentAt(transcript, '/s/one.png', NOW)).toBeNull();
  });

  describe('a transcript rewritten in place (same inode)', () => {
    /** Overwrite the file's bytes without replacing it. */
    const rewriteInPlace = (content: string): void => {
      const before = fs.statSync(transcript).ino;
      const fd = fs.openSync(transcript, 'r+');
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, content, 0);
      } finally {
        fs.closeSync(fd);
      }
      expect(fs.statSync(transcript).ino).toBe(before);
    };

    it('drops a grant when the rewrite keeps the same length and mtime (the grant\'s own lines are re-read)', async () => {
      const original = send(['/s/aaaa.png']);
      fs.writeFileSync(transcript, original);
      // Whole seconds, so restoring it later is exact and the cache sees no change.
      fs.utimesSync(transcript, 1_790_000_000, 1_790_000_000);
      const index = new SentFileIndex();
      expect(await index.sentAt(transcript, '/s/aaaa.png', NOW)).toBe(NOW);
      const rewritten = original.replace('/s/aaaa.png', '/s/bbbb.png');
      expect(rewritten.length).toBe(original.length);
      // Size AND mtime are put back, so only the bytes say it changed.
      rewriteInPlace(rewritten);
      fs.utimesSync(transcript, 1_790_000_000, 1_790_000_000);
      expect(fs.statSync(transcript).mtimeMs).toBe(1_790_000_000_000);
      expect(await index.sentAt(transcript, '/s/aaaa.png', NOW)).toBeNull();
      expect(await index.sentAt(transcript, '/s/bbbb.png', NOW)).toBe(NOW);
    });

    it('indexes from scratch when the rewrite is longer (the scanned region no longer matches)', async () => {
      fs.writeFileSync(transcript, send(['/s/gone.png']));
      const index = new SentFileIndex();
      expect(await index.sentAt(transcript, '/s/gone.png', NOW)).toBe(NOW);
      rewriteInPlace(filler(200) + send(['/s/other.png']) + filler(300));
      // Asked first: the new call sits BEFORE the old scan offset, so only a
      // full rescan can see it.
      expect(await index.sentAt(transcript, '/s/other.png', NOW)).toBe(NOW);
      expect(await index.sentAt(transcript, '/s/gone.png', NOW)).toBeNull();
    });
  });

  it('answers null for a transcript that is missing or not a regular file', async () => {
    const index = new SentFileIndex();
    expect(await index.sentAt(path.join(dir, 'missing.jsonl'), '/s/a.png', NOW)).toBeNull();
    expect(await index.sentAt(dir, '/s/a.png', NOW)).toBeNull();
  });
});

describe('sentFileParts', () => {
  it('accepts a Windows path written with forward slashes, as written', () => {
    expect(sentFileParts('C:/Users/me/shot.png', path.win32)).toEqual({ dir: 'C:/Users/me', name: 'shot.png' });
    expect(sentFileParts('C:\\Users\\me\\shot.png', path.win32)).toEqual({ dir: 'C:\\Users\\me', name: 'shot.png' });
  });

  it('refuses dot segments, doubled and trailing separators', () => {
    for (const raw of ['/x/./y.png', '/x/link/../y.png', '/x//y.png', '/x/y/', 'C:/x/../y.png', 'C:\\x\\.\\y.png']) {
      expect(sentFileParts(raw, raw.startsWith('C:') ? path.win32 : path.posix)).toBeNull();
    }
    expect(sentFileParts('/x/y.png', path.posix)).toEqual({ dir: '/x', name: 'y.png' });
  });
});
