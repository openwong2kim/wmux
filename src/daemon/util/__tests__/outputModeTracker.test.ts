import { describe, it, expect } from 'vitest';
import { OutputModeTracker } from '../outputModeTracker';

/** Feed a stream one char at a time — every possible chunk boundary at once. */
function feedByChar(tracker: OutputModeTracker, text: string): void {
  for (const ch of text) tracker.feed(ch);
}

describe('OutputModeTracker', () => {
  it('starts at the power-on defaults and asks for no preamble', () => {
    const t = new OutputModeTracker();
    expect(t.altScreen).toBe(false);
    expect(t.isSet(7)).toBe(true); // autowrap on
    expect(t.isSet(25)).toBe(true); // cursor visible
    expect(t.preamble()).toBe('');
  });

  it('plain output never moves a mode', () => {
    const t = new OutputModeTracker();
    t.feed('$ ls -la\r\n\x1b[0m\x1b[32mfile.txt\x1b[0m\r\n');
    expect(t.preamble()).toBe('');
  });

  it('tracks the alt-screen switch and its matching reset', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?1049h');
    expect(t.altScreen).toBe(true);
    expect(t.preamble()).toBe('\x1b[?1049h\x1b[2J\x1b[H');
    t.feed('\x1b[?1049l');
    expect(t.altScreen).toBe(false);
    expect(t.preamble()).toBe('');
  });

  it('treats ?47 and ?1047 as alt screen too, and normalises to ?1049 on replay', () => {
    for (const mode of [47, 1047]) {
      const t = new OutputModeTracker();
      t.feed(`\x1b[?${mode}h`);
      expect(t.altScreen).toBe(true);
      expect(t.preamble()).toBe('\x1b[?1049h\x1b[2J\x1b[H');
    }
  });

  it('last writer wins per mode', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?1049h\x1b[?1049l\x1b[?1049h\x1b[?1049l\x1b[?1049h');
    expect(t.altScreen).toBe(true);
    t.feed('\x1b[?1049l');
    expect(t.altScreen).toBe(false);
  });

  it('applies every parameter of a multi-mode set/reset', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?1000;1002;1006;2004h');
    expect(t.isSet(1000)).toBe(true);
    expect(t.isSet(1002)).toBe(true);
    expect(t.isSet(1006)).toBe(true);
    expect(t.isSet(2004)).toBe(true);
    t.feed('\x1b[?1002;1006l');
    expect(t.isSet(1000)).toBe(true);
    expect(t.isSet(1002)).toBe(false);
    expect(t.isSet(1006)).toBe(false);
  });

  it('survives a sequence split across chunk boundaries', () => {
    const split = new OutputModeTracker();
    split.feed('output\x1b[?10');
    split.feed('49h more output');
    expect(split.altScreen).toBe(true);

    // The pathological case: one char per feed, for a whole realistic startup.
    const byChar = new OutputModeTracker();
    feedByChar(byChar, 'banner\r\n\x1b[?1049h\x1b[?25l\x1b[?1002;1006h\x1b[2J');
    expect(byChar.altScreen).toBe(true);
    expect(byChar.isSet(25)).toBe(false);
    expect(byChar.isSet(1002)).toBe(true);
    expect(byChar.isSet(1006)).toBe(true);
  });

  it('keeps mouse protocol and encoding independent in the preamble', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?1003h\x1b[?1006h');
    const preamble = t.preamble();
    expect(preamble).toContain('\x1b[?1003h');
    expect(preamble).toContain('\x1b[?1006h');
    expect(preamble).not.toContain('\x1b[?1000h');
    // Switching encodings replaces, it does not accumulate.
    t.feed('\x1b[?1006l\x1b[?1015h');
    expect(t.preamble()).toContain('\x1b[?1015h');
    expect(t.preamble()).not.toContain('\x1b[?1006h');
  });

  it('emits the RESET form for modes whose default is on', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?25l\x1b[?7l');
    const preamble = t.preamble();
    expect(preamble).toContain('\x1b[?25l');
    expect(preamble).toContain('\x1b[?7l');
    // Turning them back on returns to silence, not to an explicit `h`.
    t.feed('\x1b[?25h\x1b[?7h');
    expect(t.preamble()).toBe('');
  });

  it('RIS (ESC c) puts everything back to defaults', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?1049h\x1b[?2004h\x1b[?25l');
    expect(t.preamble()).not.toBe('');
    t.feed('\x1bc');
    expect(t.altScreen).toBe(false);
    expect(t.preamble()).toBe('');
  });

  it('applies a reset that lands between two set-mode sequences in stream order', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?1049h\x1bc\x1b[?2004h');
    expect(t.altScreen).toBe(false);
    expect(t.isSet(2004)).toBe(true);
  });

  it('ignores private modes it does not track and non-private mode changes', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?12h\x1b[?1004h\x1b[4h\x1b[20h');
    expect(t.preamble()).toBe('');
  });

  it('leads the preamble with the alt-screen switch before anything else', () => {
    const t = new OutputModeTracker();
    t.feed('\x1b[?2004h\x1b[?25l\x1b[?1049h');
    expect(t.preamble().startsWith('\x1b[?1049h\x1b[2J\x1b[H')).toBe(true);
  });
});
