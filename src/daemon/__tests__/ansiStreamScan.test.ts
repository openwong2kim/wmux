import { describe, it, expect } from 'vitest';
import {
  PartialSequenceTracker,
  MarginTracker,
  SgrMouseEncodingTracker,
  incompleteUtf8SuffixLength,
  MAX_PENDING_TAIL_CHARS,
} from '../util/ansiStreamScan';

/** Feed a whole string through a fresh tracker in one shot. */
function trackAll(s: string): PartialSequenceTracker {
  const t = new PartialSequenceTracker();
  t.feed(s);
  return t;
}

describe('PartialSequenceTracker', () => {
  it('reports no pending tail after only completed sequences', () => {
    // CSI SGR, OSC-BEL, OSC-ST, ESC c (RIS) — all self-terminating.
    const t = trackAll('\x1b[31mhello\x1b[0m\x1b]0;title\x07\x1bP1;2|q\x1b\\\x1bc');
    expect(t.isPending).toBe(false);
    expect(t.pendingTail).toBe('');
  });

  it('captures the exact tail when the stream ends mid-CSI', () => {
    const t = trackAll('done \x1b[31');
    expect(t.isPending).toBe(true);
    expect(t.pendingTail).toBe('\x1b[31');
  });

  it('captures a mid-OSC tail from the sequence start (no BEL yet)', () => {
    const t = trackAll('text\x1b]0;partial-title');
    expect(t.isPending).toBe(true);
    expect(t.pendingTail).toBe('\x1b]0;partial-title');
  });

  it('captures a mid-DCS tail from the sequence start (no ST yet)', () => {
    const t = trackAll('\x1bP1;2|data-so-far');
    expect(t.isPending).toBe(true);
    expect(t.pendingTail).toBe('\x1bP1;2|data-so-far');
  });

  it('resolves a CSI split across three feeds', () => {
    const t = new PartialSequenceTracker();
    t.feed('\x1b');
    expect(t.isPending).toBe(true);
    t.feed('[3');
    expect(t.isPending).toBe(true);
    t.feed('1m');
    expect(t.isPending).toBe(false);
    expect(t.pendingTail).toBe('');
  });

  it('terminates an OSC when ESC is followed by backslash (ST)', () => {
    const t = trackAll('\x1b]0;title\x1b\\');
    expect(t.isPending).toBe(false);
    expect(t.pendingTail).toBe('');
  });

  it('re-interprets ESC + non-backslash inside a string as a new sequence (stays pending)', () => {
    // The OSC is aborted by ESC, and ESC [ opens a fresh (unfinished) CSI.
    const t = trackAll('\x1b]0;abc\x1b[');
    expect(t.isPending).toBe(true);
  });

  it('drops the tail (null) once an unterminated OSC exceeds the cap, then recovers on BEL', () => {
    const huge = '\x1b]' + 'A'.repeat(MAX_PENDING_TAIL_CHARS + 100);
    const t = trackAll(huge);
    expect(t.isPending).toBe(true);
    expect(t.pendingTail).toBeNull();

    // A terminator returns the machine to ground; the tail is empty again.
    t.feed('\x07');
    expect(t.isPending).toBe(false);
    expect(t.pendingTail).toBe('');
  });

  it('lets CAN abort a CSI sequence', () => {
    const t = trackAll('\x1b[31\x18');
    expect(t.isPending).toBe(false);
    expect(t.pendingTail).toBe('');
  });

  it('lets SUB abort a string sequence', () => {
    const t = trackAll('\x1b]0;partial\x1a');
    expect(t.isPending).toBe(false);
    expect(t.pendingTail).toBe('');
  });
});

describe('MarginTracker', () => {
  it('activates on DECSTBM with params and clears on a bare reset', () => {
    const t = new MarginTracker();
    t.feed('\x1b[5;20r');
    expect(t.active).toBe(true);
    t.feed('\x1b[r');
    expect(t.active).toBe(false);
  });

  it('treats CSI ; r (no digits) as a full-screen reset', () => {
    const t = new MarginTracker();
    t.feed('\x1b[5;20r');
    expect(t.active).toBe(true);
    t.feed('\x1b[;r');
    expect(t.active).toBe(false);
  });

  it('is reset by RIS (ESC c)', () => {
    const t = new MarginTracker();
    t.feed('\x1b[2;10r');
    expect(t.active).toBe(true);
    t.feed('\x1bc');
    expect(t.active).toBe(false);
  });

  it('is reset by DECSTR (CSI ! p)', () => {
    const t = new MarginTracker();
    t.feed('\x1b[2;10r');
    expect(t.active).toBe(true);
    t.feed('\x1b[!p');
    expect(t.active).toBe(false);
  });

  it('detects a DECSTBM split across a chunk boundary', () => {
    const t = new MarginTracker();
    t.feed('\x1b[5;2');
    expect(t.active).toBe(false); // sequence not complete yet
    t.feed('0r');
    expect(t.active).toBe(true);
  });
});

describe('SgrMouseEncodingTracker', () => {
  it('toggles ?1006 (SGR) with h / l', () => {
    const t = new SgrMouseEncodingTracker();
    t.feed('\x1b[?1006h');
    expect(t.sgr).toBe(true);
    t.feed('\x1b[?1006l');
    expect(t.sgr).toBe(false);
  });

  it('tracks ?1006 and ?1016 independently', () => {
    const t = new SgrMouseEncodingTracker();
    t.feed('\x1b[?1006h');
    expect(t.sgr).toBe(true);
    expect(t.sgrPixels).toBe(false);
    t.feed('\x1b[?1016h');
    expect(t.sgrPixels).toBe(true);
    // Turning SGR off must not touch the pixels flag.
    t.feed('\x1b[?1006l');
    expect(t.sgr).toBe(false);
    expect(t.sgrPixels).toBe(true);
  });

  it('is reset by RIS', () => {
    const t = new SgrMouseEncodingTracker();
    t.feed('\x1b[?1006h\x1b[?1016h');
    expect(t.sgr).toBe(true);
    expect(t.sgrPixels).toBe(true);
    t.feed('\x1bc');
    expect(t.sgr).toBe(false);
    expect(t.sgrPixels).toBe(false);
  });

  it('detects an encoding set split across a chunk boundary', () => {
    const t = new SgrMouseEncodingTracker();
    t.feed('\x1b[?100');
    expect(t.sgr).toBe(false);
    t.feed('6h');
    expect(t.sgr).toBe(true);
  });
});

describe('incompleteUtf8SuffixLength', () => {
  it('returns 0 for pure ASCII', () => {
    expect(incompleteUtf8SuffixLength(Buffer.from('hello'))).toBe(0);
  });

  it('returns 0 for a complete 3-byte character', () => {
    expect(incompleteUtf8SuffixLength(Buffer.from('한'))).toBe(0);
  });

  it('returns the partial length for a truncated 3-byte character', () => {
    const han = Buffer.from('한'); // 3 bytes
    expect(incompleteUtf8SuffixLength(han.subarray(0, 1))).toBe(1);
    expect(incompleteUtf8SuffixLength(han.subarray(0, 2))).toBe(2);
  });

  it('returns the partial length for a truncated 4-byte emoji', () => {
    const rocket = Buffer.from('🚀'); // 4 bytes: F0 9F 9A 80
    expect(rocket.length).toBe(4);
    expect(incompleteUtf8SuffixLength(rocket.subarray(0, 2))).toBe(2);
    expect(incompleteUtf8SuffixLength(rocket.subarray(0, 3))).toBe(3);
    expect(incompleteUtf8SuffixLength(rocket)).toBe(0); // complete
  });

  it('returns 0 for an invalid lead byte', () => {
    expect(incompleteUtf8SuffixLength(Buffer.from([0xff]))).toBe(0);
    // A lone continuation byte with no lead is also not a recoverable prefix.
    expect(incompleteUtf8SuffixLength(Buffer.from([0x80]))).toBe(0);
  });

  it('ignores completed multibyte chars that precede ASCII', () => {
    // '한' (complete) followed by 'A' — nothing at the tail is incomplete.
    expect(incompleteUtf8SuffixLength(Buffer.from('한A'))).toBe(0);
  });
});
