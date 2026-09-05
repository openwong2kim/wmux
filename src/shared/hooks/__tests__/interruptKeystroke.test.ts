import { describe, it, expect } from 'vitest';
import {
  InterruptKeystrokeDetector,
  DOUBLE_ESC_WINDOW_MS,
} from '../interruptKeystroke';

/**
 * Live finding (Claude Code 2.1.236): an interrupted turn fires no Stop hook and
 * OSC 133 cannot see it either, so these bytes are the pane's only evidence that
 * the turn ended. The detector must be exact: a false positive settles a pane
 * that is still working.
 */
describe('InterruptKeystrokeDetector', () => {
  it('treats 0x03 anywhere in the chunk as an interrupt', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '\x03')).toBe(true);
    expect(d.observe('p1', 'abc\x03')).toBe(true);
  });

  it('treats the exact ESC ESC chunk as an interrupt', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '\x1b\x1b')).toBe(true);
  });

  it('never fires on a lone ESC or on a CSI sequence that starts with one', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '\x1b')).toBe(false);
    expect(d.observe('p1', '\x1b[A')).toBe(false); // arrow up
    expect(d.observe('p1', '\x1b[I')).toBe(false); // focus report
    expect(d.observe('p1', 'x')).toBe(false);
  });

  it('fires on two lone ESC chunks inside the window', () => {
    let now = 1_000;
    const d = new InterruptKeystrokeDetector(() => now);
    expect(d.observe('p1', '\x1b')).toBe(false);
    now += DOUBLE_ESC_WINDOW_MS;
    expect(d.observe('p1', '\x1b')).toBe(true);
    // The pair is consumed: a third tap starts a new one.
    expect(d.observe('p1', '\x1b')).toBe(false);
  });

  it('does not fire on two lone ESC chunks past the window', () => {
    let now = 1_000;
    const d = new InterruptKeystrokeDetector(() => now);
    expect(d.observe('p1', '\x1b')).toBe(false);
    now += DOUBLE_ESC_WINDOW_MS + 1;
    expect(d.observe('p1', '\x1b')).toBe(false);
  });

  it('does not fire when something else lands between the two taps', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '\x1b')).toBe(false);
    expect(d.observe('p1', 'a')).toBe(false);
    expect(d.observe('p1', '\x1b')).toBe(false);
  });

  it('keys the pending tap by pane', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '\x1b')).toBe(false);
    expect(d.observe('p2', '\x1b')).toBe(false);
    expect(d.observe('p1', '\x1b')).toBe(true);
  });

  it('forgets a half-finished double-tap on pane disposal', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '\x1b')).toBe(false);
    d.forget('p1');
    expect(d.observe('p1', '\x1b')).toBe(false);
  });

  it('ignores empty writes', () => {
    const d = new InterruptKeystrokeDetector();
    expect(d.observe('p1', '')).toBe(false);
    expect(d.observe('', '\x03')).toBe(false);
  });
});
