import { describe, it, expect } from 'vitest';
import { capSnapshot, DEFAULT_SNAPSHOT_WINDOW_BYTES } from '../snapshotWindow';

/**
 * The cut point is the whole risk surface here: the ring holds raw PTY bytes,
 * so a byte-exact offset can land inside a UTF-8 character or inside an escape
 * sequence. Each case below pins the offset deliberately (the naive cut is
 * `length - maxBytes`, so the buffer is sized around the byte we want to land
 * on) rather than asserting on a window we let the helper choose.
 */

const ESC = '\x1b';

describe('capSnapshot — passthrough', () => {
  it('returns everything when the buffer is smaller than the cap', () => {
    const buf = Buffer.from('hello world');
    const out = capSnapshot(buf, { maxBytes: 1024 });
    expect(out.bytes.toString()).toBe('hello world');
    expect(out.truncated).toBe(false);
    expect(out.omittedBytes).toBe(0);
  });

  it('returns everything when the buffer is exactly the cap', () => {
    const buf = Buffer.alloc(64, 0x61);
    const out = capSnapshot(buf, { maxBytes: 64 });
    expect(out.bytes.length).toBe(64);
    expect(out.truncated).toBe(false);
    expect(out.omittedBytes).toBe(0);
  });

  it('handles an empty buffer', () => {
    const out = capSnapshot(Buffer.alloc(0));
    expect(out.bytes.length).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('drops exactly one byte when the buffer is one over the cap', () => {
    const buf = Buffer.alloc(65, 0x61);
    const out = capSnapshot(buf, { maxBytes: 64 });
    expect(out.bytes.length).toBe(64);
    expect(out.truncated).toBe(true);
    expect(out.omittedBytes).toBe(1);
  });

  it("honours the 'all' opt-up escape hatch", () => {
    const buf = Buffer.alloc(DEFAULT_SNAPSHOT_WINDOW_BYTES * 4, 0x61);
    const out = capSnapshot(buf, { maxBytes: 'all' });
    expect(out.bytes.length).toBe(buf.length);
    expect(out.truncated).toBe(false);
    expect(out.omittedBytes).toBe(0);
  });

  it('falls back to the default window for a nonsensical cap', () => {
    const buf = Buffer.alloc(DEFAULT_SNAPSHOT_WINDOW_BYTES * 2, 0x61);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const out = capSnapshot(buf, { maxBytes: bad });
      expect(out.bytes.length).toBe(DEFAULT_SNAPSHOT_WINDOW_BYTES);
    }
  });
});

describe('capSnapshot — UTF-8 boundaries', () => {
  it('never begins inside a multi-byte character', () => {
    // '€' is E2 82 AC. Sized so the naive cut lands on the middle byte.
    const buf = Buffer.from('x'.repeat(5) + '€' + 'y'.repeat(14), 'utf8');
    expect(buf.length).toBe(22);
    const out = capSnapshot(buf, { maxBytes: 16 }); // naive cut = 6 = second byte of '€'
    expect(out.omittedBytes).toBe(8);
    expect(out.bytes.toString('utf8')).toBe('y'.repeat(14));
    expect(out.bytes.toString('utf8')).not.toContain('�');
  });

  it('keeps a character whole when the naive cut is its lead byte', () => {
    const buf = Buffer.from('x'.repeat(5) + '€' + 'y'.repeat(14), 'utf8');
    const out = capSnapshot(buf, { maxBytes: 17 }); // naive cut = 5 = lead byte of '€'
    expect(out.omittedBytes).toBe(5);
    expect(out.bytes.toString('utf8')).toBe('€' + 'y'.repeat(14));
  });

  it('handles a 4-byte character straddling the cut', () => {
    // '𝄞' is F0 9D 84 9E.
    const buf = Buffer.from('x'.repeat(5) + '𝄞' + 'y'.repeat(10), 'utf8');
    expect(buf.length).toBe(19);
    const out = capSnapshot(buf, { maxBytes: 12 }); // naive cut = 7 = third byte
    expect(out.omittedBytes).toBe(9);
    expect(out.bytes.toString('utf8')).toBe('y'.repeat(10));
  });
});

describe('capSnapshot — escape sequences', () => {
  it('never begins inside a CSI sequence', () => {
    // ESC [ 3 1 m at 5..9.
    const buf = Buffer.from('x'.repeat(5) + `${ESC}[31m` + 'y'.repeat(10), 'latin1');
    expect(buf.length).toBe(20);
    const out = capSnapshot(buf, { maxBytes: 13 }); // naive cut = 7, inside the CSI
    expect(out.omittedBytes).toBe(10); // just past the 'm'
    expect(out.bytes.toString('latin1')).toBe('y'.repeat(10));
  });

  it('never begins inside a BEL-terminated OSC sequence', () => {
    // ESC ] 0 ; t i t l e BEL at 5..14.
    const buf = Buffer.from('x'.repeat(5) + `${ESC}]0;title\x07` + 'y'.repeat(10), 'latin1');
    expect(buf.length).toBe(25);
    const out = capSnapshot(buf, { maxBytes: 17 }); // naive cut = 8, inside the OSC string
    expect(out.omittedBytes).toBe(15);
    expect(out.bytes.toString('latin1')).toBe('y'.repeat(10));
  });

  it('never begins inside an ST-terminated OSC sequence', () => {
    const osc = `${ESC}]8;;http://a${ESC}\\`; // 15 bytes, ends with ESC \
    const buf = Buffer.from('x'.repeat(5) + osc + 'y'.repeat(10), 'latin1');
    expect(buf.length).toBe(30);
    const out = capSnapshot(buf, { maxBytes: 20 }); // naive cut = 10, inside the URI
    expect(out.omittedBytes).toBe(20);
    expect(out.bytes.toString('latin1')).toBe('y'.repeat(10));
  });

  it('keeps a sequence whole when the naive cut is its ESC', () => {
    const buf = Buffer.from('x'.repeat(5) + `${ESC}[31m` + 'y'.repeat(10), 'latin1');
    const out = capSnapshot(buf, { maxBytes: 15 }); // naive cut = 5 = the ESC itself
    expect(out.omittedBytes).toBe(5);
    expect(out.bytes.toString('latin1')).toBe(`${ESC}[31m` + 'y'.repeat(10));
  });

  it('leaves the cut alone when the preceding sequence already closed', () => {
    const buf = Buffer.from('x'.repeat(5) + `${ESC}[31m` + 'y'.repeat(10), 'latin1');
    const out = capSnapshot(buf, { maxBytes: 9 }); // naive cut = 11, one past the 'm'
    expect(out.omittedBytes).toBe(11);
    expect(out.bytes.toString('latin1')).toBe('y'.repeat(9));
  });

  it('does not walk off the end on an unterminated escape', () => {
    // An OSC that never closes: the helper must not skip past the buffer, and
    // must still return a usable window.
    const buf = Buffer.from('x'.repeat(5) + `${ESC}]0;` + 'y'.repeat(20), 'latin1');
    const out = capSnapshot(buf, { maxBytes: 10 });
    expect(out.bytes.length).toBeLessThanOrEqual(10);
    expect(out.omittedBytes + out.bytes.length).toBe(buf.length);
  });
});

describe('capSnapshot — line boundary preference', () => {
  it('starts just after a newline when one is close by', () => {
    const buf = Buffer.from('line\n'.repeat(5), 'latin1'); // 25 bytes
    const out = capSnapshot(buf, { maxBytes: 12 }); // naive cut = 13, mid-line
    expect(out.omittedBytes).toBe(15); // just past the newline at 14
    expect(out.bytes.toString('latin1')).toBe('line\nline\n');
  });

  it('does not cross an escape introducer to find a newline', () => {
    // The newline sits BEYOND a CSI that opens after the safe offset. Chasing
    // it would mean starting inside that sequence, which is the one thing the
    // escape guard just ruled out.
    const buf = Buffer.from('x'.repeat(10) + 'ab' + `${ESC}[2J` + '\n' + 'z'.repeat(6), 'latin1');
    expect(buf.length).toBe(23);
    const out = capSnapshot(buf, { maxBytes: 12 }); // naive cut = 11, plain text
    expect(out.omittedBytes).toBe(11);
    expect(out.bytes.toString('latin1')).toBe(`b${ESC}[2J\n` + 'z'.repeat(6));
  });

  it('never exceeds the requested cap while chasing a newline', () => {
    const buf = Buffer.from('a'.repeat(50) + '\n' + 'b'.repeat(50), 'latin1');
    const out = capSnapshot(buf, { maxBytes: 60 });
    expect(out.bytes.length).toBeLessThanOrEqual(60);
  });
});

describe('capSnapshot — cost', () => {
  it('caps a 64 MB buffer in well under a second', () => {
    // 64 MB is the configured ceiling for a session ring (bufferMaxMb).
    const buf = Buffer.alloc(64 * 1024 * 1024, 0x61);
    const started = Date.now();
    const out = capSnapshot(buf);
    const elapsed = Date.now() - started;
    expect(out.bytes.length).toBe(DEFAULT_SNAPSHOT_WINDOW_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.omittedBytes).toBe(buf.length - DEFAULT_SNAPSHOT_WINDOW_BYTES);
    expect(elapsed).toBeLessThan(200);
  });

  it('reports omittedBytes that exactly account for the buffer', () => {
    const buf = Buffer.from('hello\nworld\n'.repeat(1000), 'latin1');
    const out = capSnapshot(buf, { maxBytes: 1024 });
    expect(out.omittedBytes + out.bytes.length).toBe(buf.length);
  });
});
