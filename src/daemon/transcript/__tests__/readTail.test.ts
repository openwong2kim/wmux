import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  TAIL_BYTES,
  isLineBoundary,
  readTranscriptDelta,
  readTranscriptLineAt,
  readTranscriptPage,
  transcriptBasename,
  transcriptSessionId,
} from '../readTail';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('transcriptBasename / transcriptSessionId — Windows paths on any host', () => {
  const cases: { input: string; basename: string; sessionId: string }[] = [
    {
      input: '/Users/dev/.claude/projects/-Users-dev-repo/920b9112-1111-4222-8333-444455556666.jsonl',
      basename: '920b9112-1111-4222-8333-444455556666.jsonl',
      sessionId: '920b9112-1111-4222-8333-444455556666',
    },
    {
      // The literal Windows form the plan calls out. path.basename on POSIX
      // would return this whole string unchanged.
      input: 'C:\\Users\\dev\\.claude\\projects\\C--Users-dev-repo\\920b9112-1111-4222-8333-444455556666.jsonl',
      basename: '920b9112-1111-4222-8333-444455556666.jsonl',
      sessionId: '920b9112-1111-4222-8333-444455556666',
    },
    {
      // Extended-length / UNC form.
      input: '\\\\?\\C:\\Users\\dev\\.claude\\projects\\repo\\abc.jsonl',
      basename: 'abc.jsonl',
      sessionId: 'abc',
    },
    {
      input: '\\\\server\\share\\projects\\repo\\abc.jsonl',
      basename: 'abc.jsonl',
      sessionId: 'abc',
    },
    // Trailing separators are tolerated on both grammars.
    { input: 'C:\\dir\\abc.jsonl\\', basename: 'abc.jsonl', sessionId: 'abc' },
    { input: '/dir/abc.jsonl/', basename: 'abc.jsonl', sessionId: 'abc' },
    { input: 'abc.JSONL', basename: 'abc.JSONL', sessionId: 'abc' },
    { input: '', basename: '', sessionId: '' },
  ];

  for (const c of cases) {
    it(`derives ${JSON.stringify(c.basename)} from ${JSON.stringify(c.input)}`, () => {
      expect(transcriptBasename(c.input)).toBe(c.basename);
      expect(transcriptSessionId(c.input)).toBe(c.sessionId);
    });
  }
});

describe('readTranscriptPage / readTranscriptDelta — refusals', () => {
  it('returns null for a missing path', () => {
    const missing = path.join(os.tmpdir(), 'wmux-no-such-transcript-4f0a.jsonl');
    expect(readTranscriptPage(missing)).toBeNull();
    expect(readTranscriptDelta(missing, 0)).toBeNull();
    expect(readTranscriptLineAt(missing, 0)).toBeNull();
  });

  it('returns null for a DIRECTORY rather than opening it', () => {
    expect(readTranscriptPage(FIXTURES)).toBeNull();
    expect(readTranscriptDelta(FIXTURES, 0)).toBeNull();
  });

  it('returns null for an empty / non-string path', () => {
    expect(readTranscriptPage('')).toBeNull();
    expect(readTranscriptDelta('', 0)).toBeNull();
  });
});

describe('readTranscriptPage — whole small file', () => {
  const file = path.join(FIXTURES, 'claude-basic.jsonl');

  it('reads the file with no truncated head and no more pages', () => {
    const page = readTranscriptPage(file);
    expect(page).not.toBeNull();
    expect(page!.truncatedHead).toBe(false);
    expect(page!.hasMore).toBe(false);
    expect(page!.cursor.headOffset).toBe(0);
    expect(page!.cursor.tailOffset).toBe(fs.statSync(file).size);
    expect(page!.events.map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'meta',
    ]);
  });

  it('stamps every code-block srcOffset at a real line boundary', () => {
    const codeFile = path.join(FIXTURES, 'code-and-diff.jsonl');
    const page = readTranscriptPage(codeFile)!;
    const raw = fs.readFileSync(codeFile, 'utf8');
    for (const event of page.events) {
      if (event.kind !== 'assistant_text' || !event.codeBlocks) continue;
      for (const block of event.codeBlocks) {
        expect(typeof block.srcOffset).toBe('number');
        // The offset must land on the '{' that opens that entry.
        expect(raw[block.srcOffset!]).toBe('{');
      }
    }
  });

  it('an empty page is reported for before:0, not an error', () => {
    const page = readTranscriptPage(file, { before: 0 })!;
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.truncatedHead).toBe(false);
  });

  it('caps maxBytes at TAIL_BYTES even when asked for more', () => {
    const page = readTranscriptPage(file, { maxBytes: TAIL_BYTES * 10 })!;
    expect(page.truncatedHead).toBe(false);
    expect(page.events.length).toBeGreaterThan(0);
  });
});

describe('readTranscriptDelta — small file', () => {
  const file = path.join(FIXTURES, 'claude-basic.jsonl');
  const size = fs.statSync(file).size;

  it('reports no events and no reset when already at EOF', () => {
    const delta = readTranscriptDelta(file, size)!;
    expect(delta.reset).toBe(false);
    expect(delta.events).toEqual([]);
    expect(delta.cursor.tailOffset).toBe(size);
  });

  it('resets when the offset is past the end of the file', () => {
    const delta = readTranscriptDelta(file, size + 1)!;
    expect(delta.reset).toBe(true);
    // A reset carries a full tail snapshot, not a delta.
    expect(delta.events.length).toBeGreaterThan(0);
  });

  it('reads only the entries after the given offset', () => {
    const first = readTranscriptPage(file, { maxBytes: TAIL_BYTES })!;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const afterFirstThree = Buffer.byteLength(lines.slice(0, 3).join('\n'), 'utf8') + 1;
    const delta = readTranscriptDelta(file, afterFirstThree)!;
    expect(delta.reset).toBe(false);
    expect(delta.cursor.headOffset).toBe(afterFirstThree);
    expect(delta.cursor.tailOffset).toBe(first.cursor.tailOffset);
    // The first three fixture lines are non-conversation headers, so the delta
    // still holds every event.
    expect(delta.events.map((e) => e.kind)).toEqual(first.events.map((e) => e.kind));
  });

  it('treats a negative or NaN offset as 0', () => {
    const whole = readTranscriptPage(file)!;
    for (const bad of [-1, Number.NaN, -Infinity]) {
      const delta = readTranscriptDelta(file, bad)!;
      expect(delta.reset).toBe(false);
      expect(delta.events).toHaveLength(whole.events.length);
    }
  });
});

describe('readTranscriptLineAt', () => {
  const file = path.join(FIXTURES, 'claude-basic.jsonl');

  it('returns exactly the line starting at the offset', () => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const offset = Buffer.byteLength(lines[0], 'utf8') + 1;
    expect(readTranscriptLineAt(file, offset)).toBe(lines[1]);
  });

  it('returns null at or past EOF', () => {
    expect(readTranscriptLineAt(file, fs.statSync(file).size)).toBeNull();
  });
});

describe('isLineBoundary — cursor integrity', () => {
  const file = path.join(FIXTURES, 'claude-basic.jsonl');

  it('offset 0 and every real line start are boundaries', () => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(isLineBoundary(file, 0)).toBe(true);
    let offset = 0;
    for (const line of lines.slice(0, -1)) {
      offset += Buffer.byteLength(line, 'utf8') + 1;
      expect(isLineBoundary(file, offset)).toBe(true);
    }
  });

  it('a mid-line offset is not a boundary', () => {
    expect(isLineBoundary(file, 10)).toBe(false);
  });

  it('an offset past EOF and a missing file are not boundaries', () => {
    expect(isLineBoundary(file, fs.statSync(file).size + 10)).toBe(false);
    expect(isLineBoundary(path.join(os.tmpdir(), 'wmux-absent-9f.jsonl'), 5)).toBe(false);
  });
});

describe('readTranscriptPage — UTF-8 offsets', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tail-utf8-'));
    file = path.join(dir, 'utf8.jsonl');
    // Multi-byte prose: a character-length offset would skew every later line.
    const entries = [
      { type: 'user', uuid: 'u-1', message: { role: 'user', content: '한국어 프롬프트 — 여러 바이트' } },
      { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: '답변 ```ts\nconst x = 1;\n```' }] } },
    ];
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('computes byte offsets, so a later line still starts on its brace', () => {
    const page = readTranscriptPage(file)!;
    const raw = fs.readFileSync(file);
    const block = page.events
      .flatMap((e) => (e.kind === 'assistant_text' ? e.codeBlocks ?? [] : []))
      .at(0);
    expect(block).toBeDefined();
    expect(raw[block!.srcOffset!]).toBe('{'.charCodeAt(0));
    expect(page.cursor.tailOffset).toBe(raw.length);
  });
});
