import { describe, it, expect, beforeEach } from 'vitest';
import { OscParser, OscEvent } from '../OscParser';

describe('OscParser', () => {
  let parser: OscParser;
  let events: OscEvent[];

  beforeEach(() => {
    parser = new OscParser();
    events = [];
    parser.onOsc((e) => events.push(e));
  });

  // ───────────────────────────────────────────────
  // Basic OSC parsing
  // ───────────────────────────────────────────────

  describe('basic OSC parsing', () => {
    it('parses OSC 7 CWD with BEL terminator', () => {
      parser.process('\x1b]7;file:///home/user/project\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7, data: 'file:///home/user/project' });
    });

    it('parses OSC 7 CWD with ESC\\ terminator', () => {
      parser.process('\x1b]7;file:///home/user/project\x1b\\');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7, data: 'file:///home/user/project' });
    });

    it('strips OSC sequence from returned data', () => {
      const result = parser.process('before\x1b]7;/tmp\x07after');
      expect(result).toBe('beforeafter');
      expect(events).toHaveLength(1);
    });

    it('returns plain text unchanged when no OSC present', () => {
      const result = parser.process('hello world');
      expect(result).toBe('hello world');
      expect(events).toHaveLength(0);
    });

    it('ignores OSC without semicolon', () => {
      parser.process('\x1b]nosemicolon\x07');
      expect(events).toHaveLength(0);
    });

    it('ignores OSC with non-numeric code', () => {
      parser.process('\x1b]abc;data\x07');
      expect(events).toHaveLength(0);
    });

    it('handles multiple callbacks', () => {
      const secondEvents: OscEvent[] = [];
      parser.onOsc((e) => secondEvents.push(e));

      parser.process('\x1b]7;/tmp\x07');
      expect(events).toHaveLength(1);
      expect(secondEvents).toHaveLength(1);
    });

    it('handles OSC split across multiple process() calls', () => {
      parser.process('\x1b]7;/ho');
      expect(events).toHaveLength(0);
      parser.process('me/user\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7, data: '/home/user' });
    });

    it('handles multiple OSC sequences in a single chunk', () => {
      parser.process('\x1b]7;/tmp\x07\x1b]9;hello\x07');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ code: 7, data: '/tmp' });
      expect(events[1]).toEqual({ code: 9, data: 'hello' });
    });

    it('handles empty data field', () => {
      parser.process('\x1b]7;\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7, data: '' });
    });

    it('handles data with semicolons', () => {
      parser.process('\x1b]777;notify;title;body text\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 777, data: 'notify;title;body text' });
    });

    it('drops buffer on overflow (> 64KB)', () => {
      const hugeData = 'x'.repeat(65 * 1024);
      parser.process(`\x1b]7;${hugeData}`);
      // Buffer overflow should reset state, no event emitted
      // Even if we try to close it, the state was reset
      parser.process('\x07');
      expect(events).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────
  // OSC 7727 (git branch) specific tests
  // ───────────────────────────────────────────────

  describe('OSC 7727 — git branch', () => {
    it('parses standalone OSC 7727 with simple branch name (BEL)', () => {
      parser.process('\x1b]7727;main\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: 'main' });
    });

    it('parses standalone OSC 7727 with simple branch name (ESC\\)', () => {
      parser.process('\x1b]7727;main\x1b\\');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: 'main' });
    });

    it('parses OSC 7 + 7727 consecutive sequences', () => {
      parser.process(
        '\x1b]7;file:///home/user/repo\x07\x1b]7727;develop\x07',
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ code: 7, data: 'file:///home/user/repo' });
      expect(events[1]).toEqual({ code: 7727, data: 'develop' });
    });

    it('handles empty branch name', () => {
      parser.process('\x1b]7727;\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: '' });
    });

    it('handles long branch name with slashes', () => {
      const branch = 'feature/very-long-branch-name-here';
      parser.process(`\x1b]7727;${branch}\x07`);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: branch });
    });

    it('handles branch name with nested slashes', () => {
      const branch = 'feature/JIRA-1234/implement-osc-7727-parsing';
      parser.process(`\x1b]7727;${branch}\x07`);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: branch });
    });

    it('handles OSC 7727 split across chunks', () => {
      parser.process('\x1b]7727;feat');
      expect(events).toHaveLength(0);
      parser.process('ure/split-test\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: 'feature/split-test' });
    });

    it('parses interleaved normal text + OSC 7 + OSC 7727', () => {
      const input =
        'prompt$ \x1b]7;file:///home/user\x07git status\x1b]7727;main\x07\r\n';
      const cleaned = parser.process(input);

      expect(cleaned).toBe('prompt$ git status\r\n');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ code: 7, data: 'file:///home/user' });
      expect(events[1]).toEqual({ code: 7727, data: 'main' });
    });

    it('handles BEL and ESC\\ terminators for same code within one stream', () => {
      parser.process('\x1b]7727;main\x07');
      parser.process('\x1b]7727;develop\x1b\\');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ code: 7727, data: 'main' });
      expect(events[1]).toEqual({ code: 7727, data: 'develop' });
    });
  });

  // ───────────────────────────────────────────────
  // Shell hook OSC sequence generation validation
  // ───────────────────────────────────────────────

  describe('shell hook sequence format validation', () => {
    // These tests verify that OSC sequences in the format a shell hook
    // would generate are correctly parsed by OscParser.

    it('parses bash-style OSC 7 CWD report', () => {
      // Bash hooks typically emit: \033]7;file://hostname/path\007
      const hostname = 'myhost';
      const cwd = '/home/user/projects/myapp';
      const seq = `\x1b]7;file://${hostname}${cwd}\x07`;

      parser.process(seq);
      expect(events).toHaveLength(1);
      expect(events[0].code).toBe(7);
      expect(events[0].data).toBe(`file://${hostname}${cwd}`);
    });

    it('parses bash-style OSC 7727 git branch report', () => {
      // Expected hook output: \033]7727;branchname\007
      const seq = '\x1b]7727;feature/add-login\x07';
      parser.process(seq);
      expect(events).toHaveLength(1);
      expect(events[0].code).toBe(7727);
      expect(events[0].data).toBe('feature/add-login');
    });

    it('parses combined CWD + git branch hook output', () => {
      // A shell PROMPT_COMMAND / precmd might emit both in sequence
      const cwdSeq = '\x1b]7;file://localhost/home/user/repo\x07';
      const branchSeq = '\x1b]7727;main\x07';
      const prompt = '$ ';

      const cleaned = parser.process(cwdSeq + branchSeq + prompt);
      expect(cleaned).toBe('$ ');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        code: 7,
        data: 'file://localhost/home/user/repo',
      });
      expect(events[1]).toEqual({ code: 7727, data: 'main' });
    });

    it('handles detached HEAD (empty branch)', () => {
      // When in detached HEAD, the hook might send empty data
      parser.process('\x1b]7727;\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: '' });
    });

    it('handles Windows-style CWD path in OSC 7', () => {
      parser.process('\x1b]7;file:///C:/Users/dev/project\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        code: 7,
        data: 'file:///C:/Users/dev/project',
      });
    });
  });

  // ───────────────────────────────────────────────
  // Slice-based extraction (perf refactor) regression coverage
  // ───────────────────────────────────────────────

  describe('slice-based extraction behaviour', () => {
    it('returns large non-OSC payloads byte-for-byte unchanged', () => {
      // 64 KB of varied content with no OSC sequences — must round-trip
      const lines: string[] = [];
      for (let i = 0; i < 1024; i++) {
        lines.push(`line ${i} of streaming output \x1b[1m highlighted \x1b[0m end\n`);
      }
      const input = lines.join('');
      const out = parser.process(input);
      expect(out).toBe(input);
      expect(events).toHaveLength(0);
    });

    it('extracts an OSC embedded in the middle of a large non-OSC payload', () => {
      const prefix = 'A'.repeat(10_000);
      const suffix = 'B'.repeat(10_000);
      const input = `${prefix}\x1b]7;/var/log\x07${suffix}`;
      const out = parser.process(input);
      expect(out).toBe(prefix + suffix);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7, data: '/var/log' });
    });

    it('handles many tiny chunks of an OSC payload reassembled across calls', () => {
      // Send the OSC start (ESC ]) together, then drip-feed the payload one
      // char at a time, then terminate.
      parser.process('\x1b]');
      const payload = '7727;feature/very/deep/branch/name';
      for (const ch of payload) parser.process(ch);
      expect(events).toHaveLength(0);
      parser.process('\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: 'feature/very/deep/branch/name' });
    });

    it('preserves order: non-OSC, OSC, non-OSC, OSC, non-OSC', () => {
      const out = parser.process(
        'one\x1b]7;/a\x07two\x1b]7727;branch\x07three',
      );
      expect(out).toBe('onetwothree');
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ code: 7, data: '/a' });
      expect(events[1]).toEqual({ code: 7727, data: 'branch' });
    });

    it('OSC ESC \\ terminator returns clean tail segment', () => {
      const out = parser.process('head\x1b]7;/p\x1b\\tail');
      expect(out).toBe('headtail');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7, data: '/p' });
    });

    it('preserves a lone ESC byte that is not followed by ] or non-terminator', () => {
      // A bare ESC followed by 'X' should pass through unchanged
      const out = parser.process('a\x1bXb');
      expect(out).toBe('a\x1bXb');
      expect(events).toHaveLength(0);
    });

    it('overflow inside OSC discards the OSC payload but resumes parsing afterwards', () => {
      // Start a huge OSC payload that exceeds MAX_BUFFER (64KB), then a clean OSC follows
      const huge = 'x'.repeat(70 * 1024);
      parser.process(`\x1b]7;${huge}`);
      // Try to terminate the overflowed OSC — should be silently ignored
      parser.process('\x07');
      expect(events).toHaveLength(0);
      // Subsequent valid OSC must still be detected
      parser.process('\x1b]7727;main\x07');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ code: 7727, data: 'main' });
    });
  });

  // ───────────────────────────────────────────────
  // A read that ends on ESC (#2944)
  // ───────────────────────────────────────────────

  describe('a read that ends on ESC', () => {
    it.each([
      ['BEL', '\x1b]133;D;0\x07', { code: 133, data: 'D;0' }],
      ['ESC \\', '\x1b]133;A\x1b\\', { code: 133, data: 'A' }],
    ])('fires one callback at every split point of an OSC ended by %s', (_name, osc, event) => {
      const stream = `out${osc}put`;
      for (let at = 0; at <= stream.length; at++) {
        const p = new OscParser();
        const seen: OscEvent[] = [];
        p.onOsc((e) => seen.push(e));
        const out = p.process(stream.slice(0, at)) + p.process(stream.slice(at));
        expect(seen, `split at ${at}`).toEqual([event]);
        expect(out, `split at ${at}`).toBe('output');
      }
    });

    it('reads the repro from #2944: ESC alone, then the rest of the OSC', () => {
      parser.process('\x1b');
      parser.process(']133;D;0\x07\x1b]133;A\x07');
      expect(events).toEqual([{ code: 133, data: 'D;0' }, { code: 133, data: 'A' }]);
    });

    it('passes a trailing ESC not followed by ] through with the next read, byte for byte', () => {
      expect(parser.process('abc\x1b')).toBe('abc');
      expect(parser.process('[31mred')).toBe('\x1b[31mred');
      expect(parser.process('\x1b')).toBe('');
      expect(parser.process('\x1b')).toBe('\x1b');
      expect(parser.process('X')).toBe('\x1bX');
      expect(events).toHaveLength(0);
    });

    it('keeps an ESC inside an OSC as payload when the next read does not start with \\', () => {
      parser.process('\x1b]2;ti\x1b');
      expect(events).toHaveLength(0);
      parser.process('tle\x07');
      expect(events).toEqual([{ code: 2, data: 'ti\x1btle' }]);
    });
  });
});
