import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SentFileIndex, SENT_FILE_MAX_AGE_MS } from '../sentFiles';

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sent-index-'));
  transcript = path.join(dir, 'session.jsonl');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SentFileIndex', () => {
  it('lists every path of a successful call, byte for byte, inside the 24-hour window', async () => {
    fs.writeFileSync(transcript, send(['/s/a.png', '/s/한글.mp4']));
    const index = new SentFileIndex();
    expect(await index.isSent(transcript, '/s/a.png', NOW)).toBe(true);
    expect(await index.isSent(transcript, '/s/한글.mp4', NOW + SENT_FILE_MAX_AGE_MS)).toBe(true);
    expect(await index.isSent(transcript, '/s/a.png', NOW + SENT_FILE_MAX_AGE_MS + 1)).toBe(false);
    expect(await index.isSent(transcript, '/s/./a.png', NOW)).toBe(false);
    expect(await index.isSent(transcript, '/s/b.png', NOW)).toBe(false);
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
      expect(await index.isSent(transcript, p, NOW)).toBe(false);
    }
  });

  it('scans only what was appended, reuses an unchanged file, and rescans a replaced one', async () => {
    fs.writeFileSync(transcript, send(['/s/one.png']));
    const index = new SentFileIndex();
    expect(await index.isSent(transcript, '/s/one.png', NOW)).toBe(true);
    expect(await index.isSent(transcript, '/s/one.png', NOW)).toBe(true);
    expect(index.scans).toBe(1);

    // An unterminated call is not read until its line ends.
    const tail = send(['/s/two.png']);
    fs.appendFileSync(transcript, tail.slice(0, 40));
    expect(await index.isSent(transcript, '/s/two.png', NOW)).toBe(false);
    fs.appendFileSync(transcript, tail.slice(40));
    expect(await index.isSent(transcript, '/s/two.png', NOW)).toBe(true);
    expect(index.scans).toBe(3);

    // A new session in the same file name (replaced, not appended): the old list is gone.
    const replacement = path.join(dir, 'next.jsonl');
    fs.writeFileSync(replacement, send(['/s/three.png']));
    fs.renameSync(replacement, transcript);
    expect(await index.isSent(transcript, '/s/three.png', NOW)).toBe(true);
    expect(await index.isSent(transcript, '/s/one.png', NOW)).toBe(false);
  });

  it('answers false for a transcript that is missing or not a regular file', async () => {
    const index = new SentFileIndex();
    expect(await index.isSent(path.join(dir, 'missing.jsonl'), '/s/a.png', NOW)).toBe(false);
    expect(await index.isSent(dir, '/s/a.png', NOW)).toBe(false);
  });
});
