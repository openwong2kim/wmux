import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CODE_MARKER_PREFIX,
  CODE_MARKER_SUFFIX,
  extractCodeBlocks,
  parseTranscriptLine,
  parseTranscriptLineDetailed,
} from '../parseEntry';
import type { TurnEvent } from '../../../shared/transcript/turnEvents';

const FIXTURES = path.join(__dirname, 'fixtures');

/**
 * Parse a whole fixture the way `readTail` will: line by line, with each line's
 * byte offset as the offsetHint. Fixtures are ASCII-only apart from the
 * deliberate BOM in `malformed.jsonl`, so byte length == the offset we want.
 */
function parseFixture(name: string): TurnEvent[] {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const out: TurnEvent[] = [];
  let offset = 0;
  for (const line of raw.split('\n')) {
    out.push(...parseTranscriptLine(line, offset));
    offset += Buffer.byteLength(line, 'utf8') + 1;
  }
  return out;
}

describe('parseTranscriptLine — claude-basic.jsonl (full envelope)', () => {
  const events = parseFixture('claude-basic.jsonl');

  it('keeps only conversation entries plus the pr-link chip', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'user_text',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'meta',
    ]);
  });

  it('drops system/stop_hook_summary and every non-message entry type', () => {
    // last-prompt, mode, permission-mode, system, ai-title,
    // file-history-snapshot, queue-operation, attachment — 8 entries, 0 events.
    expect(events.filter((e) => e.kind === 'meta')).toHaveLength(1);
  });

  it('uses the entry uuid as the row id and parses the timestamp', () => {
    expect(events[0].id).toBe('aaaa0000-0000-4000-8000-000000000001');
    expect(events[0].ts).toBe(Date.parse('2026-07-27T09:00:01.000Z'));
  });

  it('marks a thinking block and collapses it into assistant_text', () => {
    const thinking = events[1];
    expect(thinking.kind).toBe('assistant_text');
    expect(thinking.kind === 'assistant_text' && thinking.thinking).toBe(true);
  });

  it('summarizes tool_use with the fleet activity grammar', () => {
    const toolUse = events[2];
    expect(toolUse.kind === 'tool_use' && toolUse.name).toBe('Bash');
    expect(toolUse.kind === 'tool_use' && toolUse.toolUseId).toBe('toolu_synthetic_01');
    expect(toolUse.kind === 'tool_use' && toolUse.argSummary).toBe('$ wc -l NOTES.txt');
    expect(toolUse.kind === 'tool_use' && toolUse.argSummary).not.toMatch(/\n/);
  });

  it('records a tool_result as a result, never as a human turn', () => {
    const result = events[3];
    expect(result.kind).toBe('tool_result');
    expect(result.kind === 'tool_result' && result.ok).toBe(true);
    expect(result.kind === 'tool_result' && result.bytes).toBe('12 NOTES.txt'.length);
    expect(result.kind === 'tool_result' && result.diffLike).toBeUndefined();
  });

  it('surfaces pr-link as a meta chip carrying the url', () => {
    const meta = events[5];
    expect(meta.kind === 'meta' && meta.subtype).toBe('unknown');
    expect(meta.kind === 'meta' && meta.label).toBe('https://example.invalid/org/repo/pull/1');
  });
});

describe('parseTranscriptLine — meta-user.jsonl (never a human turn)', () => {
  const events = parseFixture('meta-user.jsonl');

  it('maps caveats and slash commands to meta, keeping only the real turn', () => {
    expect(events.map((e) => e.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'user_text']);
  });

  it('classifies the caveat and the slash-command name', () => {
    expect(events[0].kind === 'meta' && events[0].subtype).toBe('caveat');
    expect(events[1].kind === 'meta' && events[1].subtype).toBe('slash_command');
    expect(events[1].kind === 'meta' && events[1].label).toBe('/model');
    // isMeta with no marker is still not a human turn.
    expect(events[2].kind === 'meta' && events[2].subtype).toBe('caveat');
    // A command echo without isMeta is classified off the marker alone.
    expect(events[3].kind === 'meta' && events[3].label).toBe('/clear');
  });

  it('leaves the one genuine human turn as user_text', () => {
    expect(events[4].kind === 'user_text' && events[4].text).toBe('this one really is a human turn');
  });
});

describe('parseTranscriptLine — tool-error.jsonl', () => {
  const events = parseFixture('tool-error.jsonl');

  it('maps is_error:true to ok:false and a plain result to ok:true', () => {
    expect(events.map((e) => e.kind)).toEqual(['tool_use', 'tool_result', 'tool_result']);
    expect(events[1].kind === 'tool_result' && events[1].ok).toBe(false);
    expect(events[2].kind === 'tool_result' && events[2].ok).toBe(true);
  });

  it('flattens an array-shaped tool_result content for the byte count', () => {
    expect(events[2].kind === 'tool_result' && events[2].bytes).toBe(2);
  });
});

describe('parseTranscriptLine — sidechain.jsonl', () => {
  const events = parseFixture('sidechain.jsonl');

  it('collapses each sidechain entry to one subagent chip', () => {
    expect(events.map((e) => e.kind)).toEqual(['meta', 'meta', 'assistant_text']);
    expect(events[0].kind === 'meta' && events[0].subtype).toBe('subagent');
    expect(events[1].kind === 'meta' && events[1].subtype).toBe('subagent');
  });

  it('does not inline the subagent prose into the main thread', () => {
    const texts = events
      .filter((e): e is Extract<TurnEvent, { kind: 'assistant_text' }> => e.kind === 'assistant_text')
      .map((e) => e.text);
    expect(texts).toEqual(['main thread continues']);
  });
});

describe('parseTranscriptLine — code-and-diff.jsonl', () => {
  const events = parseFixture('code-and-diff.jsonl');

  it('strips fenced bodies out of the prose and leaves refs only', () => {
    const first = events[0];
    if (first.kind !== 'assistant_text') throw new Error('expected assistant_text');
    expect(first.text).not.toContain('export const a = 1;');
    expect(first.text).toContain(`${CODE_MARKER_PREFIX}1${CODE_MARKER_SUFFIX}`);
    expect(first.text).toContain(`${CODE_MARKER_PREFIX}2${CODE_MARKER_SUFFIX}`);
    expect(first.codeBlocks).toEqual([
      { n: 1, lines: 3, lang: 'ts', path: 'src/synthetic/a.ts', srcOffset: 0 },
      { n: 2, lines: 1, lang: 'bash', srcOffset: 0 },
    ]);
  });

  it('never puts a code body on the wire (A3)', () => {
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('export const a = 1;');
    expect(serialized).not.toContain('npm test');
    expect(serialized).not.toContain('export const win = true;');
  });

  it('keeps the bodies daemon-side, addressable by event id and block n', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'code-and-diff.jsonl'), 'utf8');
    const line = raw.split('\n')[0];
    const parsed = parseTranscriptLineDetailed(line, 0);
    const bodies = parsed.bodies.get('1a1a0000-0000-4000-8000-000000000001');
    expect(bodies?.get(1)).toBe('export const a = 1;\nexport const b = 2;\nexport const c = 3;');
    expect(bodies?.get(2)).toBe('npm test');
  });

  it('extracts a Windows fence path with backslashes intact', () => {
    const second = events[1];
    if (second.kind !== 'assistant_text') throw new Error('expected assistant_text');
    expect(second.codeBlocks?.[0].path).toBe('C:\\Users\\dev\\repo\\src\\win.ts');
  });

  it('treats an unclosed fence as running to the end of the text', () => {
    const third = events[2];
    if (third.kind !== 'assistant_text') throw new Error('expected assistant_text');
    expect(third.codeBlocks).toEqual([{ n: 1, lines: 2, lang: 'python', srcOffset: expect.any(Number) }]);
    expect(third.text).not.toContain('unclosed fence');
  });

  it('flags diff-shaped tool output and only when it OPENS as a diff', () => {
    const diff = events[3];
    const log = events[4];
    expect(diff.kind === 'tool_result' && diff.diffLike).toBe(true);
    expect(log.kind === 'tool_result' && log.diffLike).toBeUndefined();
  });
});

describe('parseTranscriptLine — malformed.jsonl', () => {
  it('never throws and yields events only for the parseable entries', () => {
    const raw = fs.readFileSync(path.join(FIXTURES, 'malformed.jsonl'), 'utf8');
    let offset = 0;
    const events: TurnEvent[] = [];
    for (const line of raw.split('\n')) {
      expect(() => parseTranscriptLine(line, offset)).not.toThrow();
      events.push(...parseTranscriptLine(line, offset));
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    // The BOM-prefixed entry and the junk-timestamp entry are the only
    // survivors: an assistant entry with no `message` carries no content, and
    // the array / null / number / bare-string / non-JSON / empty lines are all
    // rejected outright.
    expect(events.map((e) => e.kind)).toEqual(['user_text', 'user_text']);
  });

  it('drops a junk timestamp rather than emitting NaN', () => {
    const junk = parseTranscriptLine(
      '{"type":"user","uuid":"u1","timestamp":"not-a-date","message":{"role":"user","content":"hi"}}',
      0,
    );
    expect(junk[0].ts).toBeUndefined();
  });

  it('falls back to offset:index for an entry with no uuid', () => {
    const events = parseTranscriptLine('{"type":"user","message":{"role":"user","content":"hi"}}', 4096);
    expect(events[0].id).toBe('4096:0');
  });
});

describe('parseTranscriptLine — unknown-blocks.jsonl (R1 skip-unknown)', () => {
  const events = parseFixture('unknown-blocks.jsonl');

  it('skips unknown content blocks and unknown top-level types', () => {
    expect(events.map((e) => e.kind)).toEqual(['assistant_text', 'user_text']);
    expect(events[0].kind === 'assistant_text' && events[0].text).toBe('visible prose');
  });

  it('flags an image block on a user turn', () => {
    expect(events[1].kind === 'user_text' && events[1].hasImage).toBe(true);
    expect(events[1].kind === 'user_text' && events[1].text).toBe('look at this');
  });

  it('yields nothing for an entry whose only block is unknown', () => {
    expect(events).toHaveLength(2);
  });
});

describe('extractCodeBlocks', () => {
  it('is a no-op on prose with no fences', () => {
    const out = extractCodeBlocks('just words', 10);
    expect(out).toEqual({ text: 'just words', refs: [], bodies: new Map() });
  });

  it('handles tilde fences and longer backtick runs', () => {
    const out = extractCodeBlocks('a\n~~~\nbody\n~~~\nb\n````\nmore\n````\nc', 0);
    expect(out.refs.map((r) => r.lines)).toEqual([1, 1]);
    expect(out.text).toBe(`a\n${CODE_MARKER_PREFIX}1${CODE_MARKER_SUFFIX}\nb\n${CODE_MARKER_PREFIX}2${CODE_MARKER_SUFFIX}\nc`);
  });

  it('stamps srcOffset so the body can be re-fetched from that line', () => {
    const out = extractCodeBlocks('```\nx\n```', 8192);
    expect(out.refs[0].srcOffset).toBe(8192);
  });

  it('does not mistake an inline triple-backtick run for a fence body', () => {
    const out = extractCodeBlocks('use ```code``` inline', 0);
    expect(out.refs).toHaveLength(0);
  });
});
