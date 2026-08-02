import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CODE_MARKER_PREFIX,
  CODE_MARKER_SUFFIX,
  extractCodeBlocks,
  INLINE_BODY_MAX_BYTES,
  INLINE_ENTRY_MAX_BYTES,
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
    // Args ride the label so `/model opus` reads back as the line that was
    // typed — a bare `/model` hid what the command was actually asked to do.
    expect(events[1].kind === 'meta' && events[1].label).toBe('/model opus');
    // isMeta with no marker is still not a human turn.
    expect(events[2].kind === 'meta' && events[2].subtype).toBe('caveat');
    // A command echo without isMeta is classified off the marker alone.
    expect(events[3].kind === 'meta' && events[3].label).toBe('/clear');
  });

  it('leaves the one genuine human turn as user_text', () => {
    expect(events[4].kind === 'user_text' && events[4].text).toBe('this one really is a human turn');
  });
});

describe('parseTranscriptLine — injected-user.jsonl (machinery is never "You")', () => {
  const events = parseFixture('injected-user.jsonl');

  it('maps every known injected shape to meta and leaves the real turns alone', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'meta', // task-notification
      'meta', // command-message
      'meta', // local-command-stdout
      'user_text', // real prose + trailing system-reminder
      'meta', // system-reminder only
      'user_text', // opens with <div>
      'user_text', // opens with JSON
      'meta', // task-notification, array-shaped content
      'user_text', // array-shaped prose + trailing system-reminder
      'user_text', // unknown <task-notification-ish> tag
    ]);
  });

  it('labels a task-notification off its summary and never leaks the result body', () => {
    expect(events[0].kind === 'meta' && events[0].subtype).toBe('subagent');
    expect(events[0].kind === 'meta' && events[0].label).toBe('Agent "synthetic worker" finished');
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('export const synthetic = true;');
    expect(serialized).not.toContain('synthetic-task-0001');
  });

  it('classifies command-message and local-command-stdout', () => {
    expect(events[1].kind === 'meta' && events[1].subtype).toBe('slash_command');
    // Args ride the label (same rule as command-name entries).
    expect(events[1].kind === 'meta' && events[1].label).toBe('synthetic-command is running --dry-run');
    expect(events[2].kind === 'meta' && events[2].subtype).toBe('command_output');
    expect(events[2].kind === 'meta' && events[2].label).toBe('Local command output');
    expect(JSON.stringify(events)).not.toContain('synthetic stdout line one');
  });

  it('keeps the human prose and drops a trailing system-reminder', () => {
    expect(events[3].kind === 'user_text' && events[3].text).toBe('please rename the widget');
    expect(events[8].kind === 'user_text' && events[8].text).toBe('ship it');
    expect(JSON.stringify(events)).not.toContain('do not mention this block');
  });

  it('degrades a reminder-only message to meta rather than a blank You card', () => {
    expect(events[4].kind === 'meta' && events[4].subtype).toBe('system_reminder');
    expect(events.some((e) => e.kind === 'user_text' && e.text === '')).toBe(false);
  });

  it('does NOT steal a human message that merely opens with a tag or JSON', () => {
    expect(events[5].kind === 'user_text' && events[5].text).toContain('why does this markup break');
    expect(events[6].kind === 'user_text' && events[6].text).toContain('json pasted as the first');
    // Allowlist match is exact — a tag that only looks similar stays a turn.
    expect(events[9].kind === 'user_text' && events[9].text).toContain('not a known tag');
  });

  it('keeps every row id and the surrounding ordering unchanged', () => {
    expect(events).toHaveLength(10);
    expect(events[0].id).toBe('eeee0000-0000-4000-8000-000000000001');
    expect(events[7].id).toBe('eeee0000-0000-4000-8000-000000000008');
    expect(events[0].ts).toBe(Date.parse('2026-07-27T10:00:00.000Z'));
  });

  it('keeps tool results when an injected block shares the entry', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'mixed-1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_mixed', content: 'ok' },
          { type: 'text', text: '<local-command-stdout>noise</local-command-stdout>' },
        ],
      },
    });
    const mixed = parseTranscriptLine(line, 0);
    expect(mixed.map((e) => e.kind)).toEqual(['tool_result', 'meta']);
    expect(mixed.some((e) => e.kind === 'user_text')).toBe(false);
  });

  it('leaves an UNCLOSED system-reminder alone rather than guessing its end', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'unclosed-1',
      message: { role: 'user', content: 'real words <system-reminder>truncated' },
    });
    const out = parseTranscriptLine(line, 0);
    expect(out[0].kind === 'user_text' && out[0].text).toBe('real words <system-reminder>truncated');
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

  it('marks a body cut at the per-block cap, and leaves an intact one unmarked', () => {
    // `lines` describes the whole block either way, so without the flag an
    // expanded chip presents a shortened body as if it were the complete one and
    // the user copies incomplete code with no warning.
    const huge = 'x'.repeat(300 * 1024);
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'trunc-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `here:\n\`\`\`ts\n${huge}\nconst tail = 1;\n\`\`\`\n` }],
      },
    });
    const parsed = parseTranscriptLineDetailed(line, 0);
    const event = parsed.events[0];
    if (event.kind !== 'assistant_text') throw new Error('expected assistant_text');
    expect(event.codeBlocks?.[0].truncated).toBe(true);
    expect(event.codeBlocks?.[0].lines).toBe(2);
    // The stored body really is only the prefix — the flag is not decorative.
    const body = parsed.bodies.get(event.id)?.get(1) ?? '';
    expect(body.length).toBe(256 * 1024);
    expect(body).not.toContain('const tail = 1;');

    // An ordinary block carries no flag at all (the field stays absent).
    const small = events[0];
    if (small.kind !== 'assistant_text') throw new Error('expected assistant_text');
    expect(small.codeBlocks?.[0].truncated).toBeUndefined();
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

  // The marker's whole safety argument is "NUL cannot occur in prose". Prose is
  // assistant-authored, i.e. untrusted, so the parser has to MAKE that true
  // instead of assuming it: a response carrying a literal NUL could otherwise
  // forge a marker (arbitrary prose rendering as a code chip) or split one the
  // parser wrote.
  it('strips NUL out of prose before it inserts any marker', () => {
    const forged = `harmless\u0000code:99\u0000 text`;
    const out = extractCodeBlocks(forged, 0);
    expect(out.refs).toHaveLength(0);
    expect(out.text).toBe('harmlesscode:99 text');
    expect(out.text.includes('\u0000')).toBe(false);
  });

  it('strips NUL that sits next to a real fence too', () => {
    const out = extractCodeBlocks(`a\u0000code:7\u0000\n\`\`\`ts\nx\n\`\`\`\nb`, 0);
    expect(out.refs.map((r) => r.n)).toEqual([1]);
    // Exactly one marker survives, and it is the one this function wrote.
    const markers = out.text.split('\u0000').length - 1;
    expect(markers).toBe(2);
    expect(out.text).toContain(`${CODE_MARKER_PREFIX}1${CODE_MARKER_SUFFIX}`);
    expect(out.text).not.toContain('code:7\u0000');
  });
});

describe('parseTranscriptLine — NUL in transcript prose (marker spoofing)', () => {
  it('never emits a NUL the parser did not write, for user or assistant text', () => {
    const assistant = parseTranscriptLine(JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x\u0000code:1\u0000y' }] },
    }), 0);
    expect(assistant).toHaveLength(1);
    if (assistant[0].kind === 'assistant_text') {
      expect(assistant[0].codeBlocks).toBeUndefined();
      expect(assistant[0].text.includes('\u0000')).toBe(false);
    }

    const user = parseTranscriptLine(JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: 'p\u0000code:1\u0000q' },
    }), 0);
    if (user[0].kind === 'user_text') {
      expect(user[0].text.includes('\u0000')).toBe(false);
    }
  });
});

// ── Tool bodies ────────────────────────────────────────────────────────────
//
// Chat View could say a tool ran but never what it ran or what came back:
// ToolUseEvent carried an 80-char `argSummary` and ToolResultEvent carried
// `ok` + `bytes`. The transcript has both in full — the parser was extracting
// and then dropping them. These pin the shape that carries them, and the two
// invariants that keep the wire bounded.
describe('parseTranscriptLine — tool bodies', () => {
  const line = (obj: unknown): string => JSON.stringify(obj);

  const useEntry = (input: unknown, id = 'tu-1') =>
    line({
      type: 'assistant',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
    });

  const resultEntry = (content: unknown, isError = false, id = 'tu-1') =>
    line({
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    });

  it('carries a small tool input inline, as rendered JSON', () => {
    const [ev] = parseTranscriptLine(useEntry({ command: 'ls -la' }), 0);
    expect(ev.kind).toBe('tool_use');
    if (ev.kind !== 'tool_use') throw new Error('expected tool_use');
    expect(ev.input?.inline).toContain('ls -la');
    expect(ev.input?.n).toBe(1);
    expect(ev.input?.srcOffset).toBe(0);
  });

  it('carries a small tool output inline', () => {
    const [ev] = parseTranscriptLine(resultEntry('total 0\ndrwxr-xr-x'), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.output?.inline).toBe('total 0\ndrwxr-xr-x');
    expect(ev.output?.bytes).toBe(18);
  });

  it('leaves an over-cap body as a head plus the true byte count', () => {
    const big = 'x'.repeat(10_000);
    const [ev] = parseTranscriptLine(resultEntry(big), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.output?.bytes).toBe(10_000);
    // The head is bounded; the count is honest about what is still waiting.
    expect(Buffer.byteLength(ev.output?.inline ?? '', 'utf8')).toBeLessThanOrEqual(INLINE_BODY_MAX_BYTES);
    expect((ev.output?.inline ?? '').length).toBeLessThan(10_000);
  });

  it('never splits a multi-byte character at the cap', () => {
    // Every char is 3 bytes, so a byte cap that ignored encoding would land
    // mid-character and yield U+FFFD — visible as mojibake on CJK output.
    const cjk = '가'.repeat(5000);
    const [ev] = parseTranscriptLine(resultEntry(cjk), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.output?.inline ?? '').not.toContain('\uFFFD');
    expect(Buffer.byteLength(ev.output?.inline ?? '', 'utf8')).toBeLessThanOrEqual(INLINE_BODY_MAX_BYTES);
  });

  it('unwraps the <tool_use_error> envelope — is_error already says it failed', () => {
    const [ev] = parseTranscriptLine(resultEntry('<tool_use_error>boom</tool_use_error>', true), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.ok).toBe(false);
    expect(ev.output?.inline).toBe('boom');
  });

  it('omits the body entirely when there was nothing to carry', () => {
    const [ev] = parseTranscriptLine(resultEntry(''), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.output).toBeUndefined();
  });

  it('does not carry a body for a diff-shaped result — the diff chip owns it', () => {
    const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    const [ev] = parseTranscriptLine(resultEntry(diff), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.diffLike).toBe(true);
    expect(ev.output).toBeUndefined();
  });

  it('registers the FULL body in the side table even when the inline copy is cut', () => {
    const big = 'y'.repeat(10_000);
    const { events, bodies } = parseTranscriptLineDetailed(resultEntry(big), 0);
    const ev = events[0];
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    const stored = bodies.get(ev.id)?.get(ev.output?.n ?? -1);
    expect(stored).toHaveLength(10_000);
  });

  // The invariant that keeps a body from being broadcast by accident: the
  // narrow parse is what fans out to clients, and it must never hand back the
  // side table. Bodies riding inline are capped; the FULL body is not.
  it('keeps bodies out of the narrow parse (REGRESSION guard)', () => {
    const { bodies } = parseTranscriptLineDetailed(resultEntry('z'.repeat(10_000)), 0);
    expect(bodies.size).toBeGreaterThan(0);
    // parseTranscriptLine returns events only — there is no bodies channel on it.
    const events = parseTranscriptLine(resultEntry('z'.repeat(10_000)), 0);
    expect(Array.isArray(events)).toBe(true);
    const ev = events[0];
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(Buffer.byteLength(ev.output?.inline ?? '', 'utf8')).toBeLessThanOrEqual(INLINE_BODY_MAX_BYTES);
  });

  it('carries a string tool input as-is rather than re-JSONing it', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'a-2',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't', name: 'Bash', input: 'raw string input' }],
      },
    });
    const [ev] = parseTranscriptLine(raw, 0);
    if (ev.kind !== 'tool_use') throw new Error('expected tool_use');
    expect(ev.input?.inline).toBe('raw string input');
  });

  it('omits the input body when the call carried none', () => {
    const [ev] = parseTranscriptLine(useEntry(undefined), 0);
    if (ev.kind !== 'tool_use') throw new Error('expected tool_use');
    expect(ev.input).toBeUndefined();
    // The summary line still identifies the tool.
    expect(ev.name).toBe('Bash');
  });

  it('flags a head with `truncated` so the renderer never derives it', () => {
    // The renderer runs with nodeIntegration:false — no Buffer — so deriving
    // "is this only a head?" from a byte comparison there would THROW.
    const [ev] = parseTranscriptLine(resultEntry('x'.repeat(10_000)), 0);
    if (ev.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(ev.output?.truncated).toBe(true);
    const [small] = parseTranscriptLine(resultEntry('short'), 0);
    if (small.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(small.output?.truncated).toBeUndefined();
  });

  // Both outside-voice reviewers landed on this independently: a per-BODY cap
  // does not bound a FRAME. One assistant line carries every parallel tool_use
  // of that turn, so a wide fan-out at 4 KB each blows past the projector's
  // 128 KB page budget — and because a JSONL line cannot be split, the whole
  // entry is then skipped and the turn vanishes with nothing said.
  it('bounds the TOTAL inline bytes one entry may carry', () => {
    const body = 'z'.repeat(4096);
    const calls = Array.from({ length: 64 }, (_, i) => ({
      type: 'tool_use',
      id: `t${i}`,
      name: 'Bash',
      input: { command: body },
    }));
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'wide',
      message: { role: 'assistant', content: calls },
    });
    const events = parseTranscriptLine(raw, 0);
    expect(events).toHaveLength(64);
    const totalInline = events.reduce(
      (sum, e) => sum + (e.kind === 'tool_use' ? Buffer.byteLength(e.input?.inline ?? '', 'utf8') : 0),
      0,
    );
    expect(totalInline).toBeLessThanOrEqual(INLINE_ENTRY_MAX_BYTES);
    // Nothing is LOST — the later calls degrade to fetch, they do not vanish.
    for (const e of events) {
      if (e.kind !== 'tool_use') continue;
      expect(e.input?.bytes).toBeGreaterThan(0);
      expect(e.input?.srcOffset).toBe(0);
    }
    // And the whole entry still fits the page budget it would otherwise bust.
    expect(Buffer.byteLength(JSON.stringify(events), 'utf8')).toBeLessThan(128 * 1024);
  });

  // Codex's PR review: the budget was charged in RAW bytes while the projector
  // enforces its page budget against JSON.stringify(events). A NUL is one byte
  // raw and six characters escaped, so control-heavy output could spend exactly
  // the budget and still serialize past 128 KB — the entry then gets skipped
  // whole, which is the failure the budget exists to prevent.
  // Codex's PR review: the budget was charged in RAW bytes while the projector
  // enforces its page budget against JSON.stringify(events). A NUL is one byte
  // raw and six characters escaped, so control-heavy output spends the budget
  // and STILL serializes past 128 KB — the entry is then skipped whole, which
  // is the failure the budget exists to prevent.
  //
  // The blow-up is on the tool_RESULT path: a result body is raw program
  // output, so its control characters survive to the wire. A tool_use input is
  // JSON-stringified before it is stored, so it arrives pre-escaped.
  it('charges the entry budget by SERIALIZED size, not raw bytes', () => {
    // Codex's exact case: eight 4 KB bodies of NULs. Raw that is exactly the
    // 32 KB budget; escaped it is ~197 KB.
    const nulBody = ' '.repeat(4096);
    const results = Array.from({ length: 8 }, (_, i) => ({
      type: 'tool_result',
      tool_use_id: `n${i}`,
      content: nulBody,
    }));
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'nuls',
      message: { role: 'user', content: results },
    });
    const events = parseTranscriptLine(raw, 0);
    expect(events).toHaveLength(8);
    // The whole entry must still fit the page budget once serialized — that is
    // the number the projector actually checks.
    expect(Buffer.byteLength(JSON.stringify(events), 'utf8')).toBeLessThan(128 * 1024);
    // And nothing is lost: every result is still fetchable.
    for (const e of events) {
      if (e.kind !== 'tool_result') continue;
      expect(e.output?.bytes).toBe(4096);
      expect(e.output?.srcOffset).toBe(0);
    }
  });

  it('still hands back a fetch handle when the allowance left no room to inline', () => {
    const body = 'v'.repeat(4096);
    const calls = Array.from({ length: 64 }, (_, i) => ({
      type: 'tool_use',
      id: `t${i}`,
      name: 'Bash',
      input: { command: body },
    }));
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'wide3',
      message: { role: 'assistant', content: calls },
    });
    const events = parseTranscriptLine(raw, 0);
    const starved = events.filter(
      (e) => e.kind === 'tool_use' && !e.input?.inline,
    );
    // Whatever ran out of allowance must still be reachable: a handle with an
    // offset, flagged truncated so the renderer offers the fetch.
    for (const e of starved) {
      if (e.kind !== 'tool_use') continue;
      expect(e.input?.truncated).toBe(true);
      expect(e.input?.srcOffset).toBe(0);
      expect(e.input?.n).toBe(1);
    }
  });

  it('keeps the FULL body fetchable for a call that lost its inline allowance', () => {
    const body = 'w'.repeat(4096);
    const calls = Array.from({ length: 64 }, (_, i) => ({
      type: 'tool_use',
      id: `t${i}`,
      name: 'Bash',
      input: { command: body },
    }));
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'wide2',
      message: { role: 'assistant', content: calls },
    });
    const { events, bodies } = parseTranscriptLineDetailed(raw, 0);
    const last = events[events.length - 1];
    if (last.kind !== 'tool_use') throw new Error('expected tool_use');
    expect(last.input?.truncated).toBe(true);
    expect(bodies.get(last.id)?.get(1)).toContain(body);
  });
});
