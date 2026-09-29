import { describe, it, expect } from 'vitest';
import { stripReplayQuerySequences } from '../replayQuerySanitizer';

const strip = (s: string): string =>
  stripReplayQuerySequences(Buffer.from(s, 'latin1')).toString('latin1');

describe('stripReplayQuerySequences', () => {
  // The incident class: 3,653 stored DECXCPR queries re-fired on reattach.
  it('strips DECXCPR runs (the 2026-07-04 CPR storm offender)', () => {
    const run = '\x1b[?6n'.repeat(40);
    expect(strip(`\x1b[40;3H\x1b[?25h${run}`)).toBe('\x1b[40;3H\x1b[?25h');
  });

  it('strips DSR family — plain CPR and status', () => {
    expect(strip('a\x1b[6nb\x1b[5nc')).toBe('abc');
  });

  it('strips DA1/DA2/DA3', () => {
    expect(strip('\x1b[c\x1b[0c\x1b[>c\x1b[>0c\x1b[=c')).toBe('');
  });

  it('strips XTVERSION but preserves DECSCUSR (cursor style)', () => {
    expect(strip('\x1b[>0q')).toBe('');
    expect(strip('\x1b[2 q')).toBe('\x1b[2 q');
  });

  it('strips DECRQM probes', () => {
    expect(strip('\x1b[?2026$p\x1b[?2004$p\x1b[4$p')).toBe('');
  });

  it('strips OSC color queries, preserves color SETs and titles', () => {
    expect(strip('\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]4;5;?\x07')).toBe('');
    expect(strip('\x1b]11;#000000\x07')).toBe('\x1b]11;#000000\x07');
    // A window title ending in "?" is not a query.
    expect(strip('\x1b]0;done?\x07')).toBe('\x1b]0;done?\x07');
    // Semantic-prompt (133) and cwd (7) OSCs pass through.
    expect(strip('\x1b]133;A\x07\x1b]7;file://host/x\x07')).toBe(
      '\x1b]133;A\x07\x1b]7;file://host/x\x07',
    );
  });

  it('strips DCS queries (DECRQSS, XTGETTCAP) and ENQ', () => {
    expect(strip('\x1bP$qm\x1b\\\x1bP+q544e\x1b\\\x05')).toBe('');
  });

  // #1641: the inline-image addon answers these, so a replayed query would
  // type its answer into whatever shell owns the pty now.
  it('strips XTWINOPS size queries and XTSMGRAPHICS, keeps their display look-alikes', () => {
    expect(strip('\x1b[14t\x1b[14;2t\x1b[16t\x1b[18t')).toBe('');
    expect(strip('\x1b[?2;1;0S\x1b[?1;4S')).toBe('');
    // SET / reset are stripped too: the addon answers them with a report.
    expect(strip('\x1b[?1;3;1024S\x1b[?1;2S')).toBe('');
    // Title push/pop, DECSLPP and plain scroll-up are display state.
    expect(strip('\x1b[22;0t\x1b[23;0t\x1b[24t\x1b[3S')).toBe('\x1b[22;0t\x1b[23;0t\x1b[24t\x1b[3S');
  });

  it('keeps sixel and iTerm2 image payloads so a raw replay redraws them', () => {
    const sixel = '\x1bPq#0;2;100;0;0#0~~~~\x1b\\';
    const iip = '\x1b]1337;File=inline=1;size=4:AAAA\x07';
    expect(strip(sixel + iip)).toBe(sixel + iip);
  });

  it('preserves display sequences and multi-byte text byte-exactly', () => {
    const display =
      '\x1b[1m\x1b[38;5;196m한글 텍스트\x1b[0m\x1b[40;3H\x1b[K' +
      '\x1b[71C\x1b[?1049h\x1b[2J\x1b[H\x1b[?25h\x1b[?1000h\x1b[?2004h';
    const buf = Buffer.from(display, 'utf8');
    const out = stripReplayQuerySequences(buf);
    expect(out.equals(buf)).toBe(true);
  });

  it('returns the same buffer reference when nothing matched', () => {
    const buf = Buffer.from('plain prompt $ ', 'utf8');
    expect(stripReplayQuerySequences(buf)).toBe(buf);
  });

  it('cleans a realistic claude-boot replay tail without touching the repaint', () => {
    // Condensed from the real ring buffer: boot probes (DA1, XTVERSION),
    // alt-screen entry, final repaint, then the query flood.
    const replay =
      '\x1b[?2031h\x1b[>0q\x1b[c\x1b[?1049h\x1b[2J\x1b[H' +
      '\x1b[39B\x1b[K\x1b[42;1H\x1b[40;3H\x1b[?25h' +
      '\x1b[?6n'.repeat(370);
    expect(strip(replay)).toBe(
      '\x1b[?2031h\x1b[?1049h\x1b[2J\x1b[H' +
        '\x1b[39B\x1b[K\x1b[42;1H\x1b[40;3H\x1b[?25h',
    );
  });
});
