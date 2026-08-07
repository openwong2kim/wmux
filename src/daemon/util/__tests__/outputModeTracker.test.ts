import { describe, it, expect } from 'vitest';
import { OutputModeTracker } from '../outputModeTracker';

/**
 * `feed()` takes the ring's running byte offset. Tests that only care about
 * mode state should not have to bookkeep it, so this keeps one per tracker.
 */
const offsets = new WeakMap<OutputModeTracker, number>();
function feed(t: OutputModeTracker, chunk: string): void {
  const next = (offsets.get(t) ?? 0) + Buffer.byteLength(chunk, 'utf8');
  offsets.set(t, next);
  t.feed(chunk, next);
}

/** Feed a stream one char at a time — every possible chunk boundary at once. */
function feedByChar(tracker: OutputModeTracker, text: string): void {
  for (const ch of text) feed(tracker, ch);
}

/**
 * A window that starts after everything fed so far, i.e. "the mode switches
 * have scrolled out of the snapshot". The alt-screen gate is an offset
 * comparison, so tests about the OTHER modes pass this to opt out of it.
 */
const WINDOW_AFTER_EVERYTHING = Number.MAX_SAFE_INTEGER;

describe('OutputModeTracker', () => {
  it('starts at the power-on defaults and asks for no preamble', () => {
    const t = new OutputModeTracker();
    expect(t.altScreen).toBe(false);
    expect(t.isSet(7)).toBe(true); // autowrap on
    expect(t.isSet(25)).toBe(true); // cursor visible
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  it('plain output never moves a mode', () => {
    const t = new OutputModeTracker();
    feed(t, '$ ls -la\r\n\x1b[0m\x1b[32mfile.txt\x1b[0m\r\n');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  it('tracks the alt-screen switch and its matching reset', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h');
    expect(t.altScreen).toBe(true);
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
    feed(t, '\x1b[?1049l');
    expect(t.altScreen).toBe(false);
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  // ★ regression for the blocker: the tracker's state describes the WHOLE
  // stream, the snapshot only its tail. Re-asserting an entry the window still
  // carries paints the scrollback ahead of it into the alternate buffer, the
  // window's own entry then no-ops, and leaving the app strands the user on an
  // empty normal buffer with the scrollback gone.
  it('★ skips the alt preamble while the window still contains the entry', () => {
    const t = new OutputModeTracker();
    feed(t, 'line1\r\nline2\r\n'); // 14 bytes
    feed(t, '\x1b[?1049h'); // entry at byte 14, ends at 22
    feed(t, '\x1b[HVIM FRAME');

    // A window that opens at or before byte 14 carries the entry itself.
    expect(t.preamble(14)).toBe('');
    expect(t.preamble(0)).toBe('');
    // One byte later and the entry is outside — it has to be re-asserted.
    expect(t.preamble(15)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
  });

  it('★ dates the alt entry from the LATEST one, not the first', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h'); // bytes 0..8
    feed(t, 'x'.repeat(500)); // bytes 8..508
    feed(t, '\x1b[?1049l\x1b[?1049h'); // exit at 508, re-entry at 516
    expect(t.preamble(600)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
    // A window reaching back to the re-entry carries it, so nothing is added —
    // even though the FIRST entry is long gone.
    expect(t.preamble(516)).toBe('');
    expect(t.preamble(517)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
  });

  it('★ measures the alt entry offset in BYTES, not chars', () => {
    const head = 'héllo→'; // 6 chars, 9 bytes
    expect(head.length).toBe(6);
    expect(Buffer.byteLength(head, 'utf8')).toBe(9);
    const t = new OutputModeTracker();
    feed(t, head);
    feed(t, '\x1b[?1049h');
    expect(t.preamble(9)).toBe(''); // entry starts exactly at byte 9
    expect(t.preamble(10)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
    // A char-length offset (6) would have put the entry outside a window that
    // in fact contains it.
    expect(t.preamble(6)).toBe('');
  });

  it('emits the alt-screen mode that was actually used, not a normalised 1049', () => {
    for (const mode of [47, 1047, 1049]) {
      const t = new OutputModeTracker();
      feed(t, `\x1b[?${mode}h`);
      expect(t.altScreen).toBe(true);
      expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe(`\x1b[?${mode}h\x1b[2J\x1b[H`);
    }
  });

  it('last writer wins per mode', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h\x1b[?1049l\x1b[?1049h\x1b[?1049l\x1b[?1049h');
    expect(t.altScreen).toBe(true);
    feed(t, '\x1b[?1049l');
    expect(t.altScreen).toBe(false);
  });

  it('applies every parameter of a multi-mode set/reset', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1000;1002;1006;2004h');
    expect(t.isSet(1000)).toBe(true);
    expect(t.isSet(1002)).toBe(true);
    expect(t.isSet(1006)).toBe(true);
    expect(t.isSet(2004)).toBe(true);
    feed(t, '\x1b[?1002;1006l');
    expect(t.isSet(1000)).toBe(true);
    expect(t.isSet(1002)).toBe(false);
    expect(t.isSet(1006)).toBe(false);
  });

  it('survives a sequence split across chunk boundaries', () => {
    const split = new OutputModeTracker();
    feed(split, 'output\x1b[?10');
    feed(split, '49h more output');
    expect(split.altScreen).toBe(true);

    // The pathological case: one char per feed, for a whole realistic startup.
    const byChar = new OutputModeTracker();
    feedByChar(byChar, 'banner\r\n\x1b[?1049h\x1b[?25l\x1b[?1002;1006h\x1b[2J');
    expect(byChar.altScreen).toBe(true);
    expect(byChar.isSet(25)).toBe(false);
    expect(byChar.isSet(1002)).toBe(true);
    expect(byChar.isSet(1006)).toBe(true);
  });

  it('re-scanning the carry does not change the state it already applied', () => {
    // `\x1b[?1049l` lands inside the carry the next feed re-scans. Applying it
    // twice must be indistinguishable from applying it once — and, critically,
    // must not make the tracker think the alt entry happened in THIS chunk.
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h');
    feed(t, 'painting');
    expect(t.altScreen).toBe(true);
    expect(t.preamble(1)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
    // The entry is still reported at offset 0, not re-dated to the later feeds.
    expect(t.preamble(0)).toBe('');
    feed(t, 'more');
    expect(t.preamble(0)).toBe('');
    expect(t.altScreen).toBe(true);
  });

  it('matches a mode sequence longer than the carry window', () => {
    // 11 parameters — the realistic worst case a TUI sends in one go, and the
    // shape that a 64-char carry could not hold.
    const long = '\x1b[?1000;1001;1002;1003;1004;1005;1006;1007;1015;1016;2004h';
    expect(long.length).toBeGreaterThan(50);
    const t = new OutputModeTracker();
    // Split three chars in, so the ESC is only reachable through the carry.
    feed(t, long.slice(0, 3));
    feed(t, long.slice(3));
    expect(t.isSet(1002)).toBe(true);
    expect(t.isSet(1006)).toBe(true);
    expect(t.isSet(2004)).toBe(true);
  });

  it('keeps mouse protocol and encoding independent in the preamble', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1003h\x1b[?1006h');
    const preamble = t.preamble(WINDOW_AFTER_EVERYTHING);
    expect(preamble).toContain('\x1b[?1003h');
    expect(preamble).toContain('\x1b[?1006h');
    expect(preamble).not.toContain('\x1b[?1000h');
    // Switching encodings replaces, it does not accumulate.
    feed(t, '\x1b[?1006l\x1b[?1015h');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toContain('\x1b[?1015h');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).not.toContain('\x1b[?1006h');
  });

  it('emits the RESET form for modes whose default is on', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?25l\x1b[?7l');
    const preamble = t.preamble(WINDOW_AFTER_EVERYTHING);
    expect(preamble).toContain('\x1b[?25l');
    expect(preamble).toContain('\x1b[?7l');
    // Turning them back on returns to silence, not to an explicit `h`.
    feed(t, '\x1b[?25h\x1b[?7h');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  it('reports the documented DEFAULT for a mode nothing has touched', () => {
    const t = new OutputModeTracker();
    // Default-on modes must not read back as false just because no sequence
    // has mentioned them — a caller gating on isSet(7) would conclude autowrap
    // is off on a terminal that has it on.
    expect(t.isSet(7)).toBe(true);
    expect(t.isSet(25)).toBe(true);
    expect(t.isSet(2004)).toBe(false);
    // Untracked modes fall through to false, as before.
    expect(t.isSet(9999)).toBe(false);
  });

  it('RIS (ESC c) puts everything back to defaults', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h\x1b[?2004h\x1b[?25l');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).not.toBe('');
    feed(t, '\x1bc');
    expect(t.altScreen).toBe(false);
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  it('DECSTR (CSI ! p) soft-resets the modes a real terminal resets', () => {
    // terminfo `rs2` is literally `\E[!p`, so `reset` / `tput init` takes this
    // path. Without it the tracker keeps asserting modes the remote dropped —
    // application cursor keys on a shell that expects arrows, a hidden cursor.
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?2004h\x1b[?1002;1006h');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).not.toBe('');
    feed(t, '\x1b[!p');
    expect(t.isSet(1)).toBe(false);
    expect(t.isSet(7)).toBe(true);
    expect(t.isSet(25)).toBe(true);
    expect(t.isSet(2004)).toBe(false);
    expect(t.isSet(1002)).toBe(false);
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  it('DECSTR does NOT pretend the alternate screen was left', () => {
    // A soft reset does not swap the buffer back, and claiming it did would
    // drop the client onto the normal buffer while the stream keeps painting
    // absolute frames.
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h\x1b[?25l');
    feed(t, '\x1b[!p');
    expect(t.altScreen).toBe(true);
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('\x1b[?1049h\x1b[2J\x1b[H');
  });

  it('does not mistake DA1 (ESC[c) for RIS (ESC c)', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h\x1b[?2004h');
    // An app querying device attributes must not wipe the tracked state.
    feed(t, '\x1b[c\x1b[>c\x1b[=c');
    expect(t.altScreen).toBe(true);
    expect(t.isSet(2004)).toBe(true);
  });

  it('applies a reset that lands between two set-mode sequences in stream order', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?1049h\x1bc\x1b[?2004h');
    expect(t.altScreen).toBe(false);
    expect(t.isSet(2004)).toBe(true);
  });

  it('ignores private modes it does not track and non-private mode changes', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?12h\x1b[?1004h\x1b[4h\x1b[20h');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING)).toBe('');
  });

  it('leads the preamble with the alt-screen switch before anything else', () => {
    const t = new OutputModeTracker();
    feed(t, '\x1b[?2004h\x1b[?25l\x1b[?1049h');
    expect(t.preamble(WINDOW_AFTER_EVERYTHING).startsWith('\x1b[?1049h\x1b[2J\x1b[H')).toBe(true);
  });
});
