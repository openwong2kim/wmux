import { describe, it, expect } from 'vitest';
import {
  createDeadInputWatchdog,
  isNonInputKey,
  DEAD_INPUT_THRESHOLD_DEFAULT,
  DEAD_INPUT_WINDOW_MS_DEFAULT,
  DEAD_INPUT_COOLDOWN_MS_DEFAULT,
  type DeadInputReport,
} from '../deadInputWatchdog';

describe('deadInputWatchdog', () => {
  const setup = (opts?: Partial<Parameters<typeof createDeadInputWatchdog>[0]>) => {
    let t = 0;
    const reports: DeadInputReport[] = [];
    const w = createDeadInputWatchdog({
      report: (r) => reports.push(r),
      threshold: 4,
      windowMs: 400,
      cooldownMs: 10_000,
      now: () => t,
      ...opts,
    });
    const key = (keyCode: number, isComposing = false, code = 'KeyA') => w.onKeyDown({ keyCode, isComposing, code });
    const at = (ms: number) => { t = ms; };
    return { w, reports, key, at };
  };

  it('reports when enough input keydowns go unanswered across the window', () => {
    const { reports, key, at } = setup();
    at(0); key(229);
    at(150); key(229);
    at(300); key(229);
    expect(reports).toEqual([]);        // only 3 so far
    at(450); key(229);                  // 4th, span 450 >= 400 → report
    expect(reports).toHaveLength(1);
    expect(reports[0].keydownCount).toBe(4);
    expect(reports[0].keyCodes).toEqual([229]);  // all IME-claimed
    expect(reports[0].codes).toEqual(['KeyA']);
  });

  it('does not report below the threshold', () => {
    const { reports, key, at } = setup();
    at(0); key(229); at(500); key(229); at(1000); key(229); // 3, well past window
    expect(reports).toEqual([]);
  });

  it('does not report a fast burst that does not span the window', () => {
    const { reports, key, at } = setup();
    at(0); key(65); at(50); key(66); at(100); key(67); at(150); key(68); // 4 keys, span 150 < 400
    expect(reports).toEqual([]);
  });

  it('resets when input actually reaches the app (onData)', () => {
    const { w, reports, key, at } = setup();
    at(0); key(229); at(150); key(229); at(300); key(229);
    w.onData();                         // input got through → reset
    at(450); key(229); at(600); key(229); at(750); key(229);
    expect(reports).toEqual([]);        // only 3 since the reset
  });

  it('does NOT report healthy IME composition (isComposing resets the accumulator)', () => {
    // Normal slow CJK typing: 229 keydowns with isComposing=true, no onData until
    // commit. This has the same shape as the storm we hunt EXCEPT isComposing —
    // it must never self-report, or the diagnostic is worthless for Korean users.
    const { reports, key, at } = setup();
    for (let i = 0; i < 8; i++) { at(i * 200); key(229, true, 'KeyR'); } // spans 1.4s, composing
    expect(reports).toEqual([]);
  });

  it('ignores modifier / lock / function keys (they produce no shell input)', () => {
    const { reports, key, at } = setup();
    at(0); key(16, false, 'ShiftLeft');
    at(150); key(17, false, 'ControlLeft');
    at(300); key(18, false, 'AltLeft');
    at(450); key(112, false, 'F1');
    at(600); key(20, false, 'CapsLock');
    expect(reports).toEqual([]);        // none of these count
  });

  it('still catches a storm interleaved with modifier keys', () => {
    const { reports, key, at } = setup();
    at(0); key(229, false, 'KeyH');
    at(150); key(16, false, 'ShiftLeft'); // ignored, does not reset
    at(300); key(229, false, 'KeyA');
    at(450); key(229, false, 'KeyN');
    at(600); key(229, false, 'KeyG');     // 4 real input keys, span 600 → report
    expect(reports).toHaveLength(1);
    expect(reports[0].keydownCount).toBe(4);
    expect(reports[0].codes).toEqual(['KeyH', 'KeyA', 'KeyN', 'KeyG']);
  });

  it('rate-limits to one report per episode (cooldown)', () => {
    const { reports, key, at } = setup();
    at(0); key(229); at(150); key(229); at(300); key(229); at(450); key(229); // report #1
    expect(reports).toHaveLength(1);
    at(600); key(229); at(900); key(229); at(1200); key(229); at(1500); key(229); // within cooldown
    expect(reports).toHaveLength(1);
    at(11_000); key(229); at(11_500); key(229); at(12_000); key(229); at(12_500); key(229); // past cooldown
    expect(reports).toHaveLength(2);
  });

  it('is a no-op after dispose', () => {
    const { w, reports, key, at } = setup();
    w.dispose();
    at(0); key(229); at(150); key(229); at(300); key(229); at(450); key(229);
    expect(reports).toEqual([]);
  });

  it('isNonInputKey classifies keys correctly', () => {
    for (const c of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaRight', 'CapsLock', 'NumLock', 'F1', 'F12']) {
      expect(isNonInputKey(c)).toBe(true);
    }
    for (const c of ['KeyA', 'Enter', 'Tab', 'ArrowUp', 'Space', 'Digit1']) {
      expect(isNonInputKey(c)).toBe(false);
    }
  });

  it('exports sane defaults', () => {
    expect(DEAD_INPUT_THRESHOLD_DEFAULT).toBeGreaterThanOrEqual(2);
    expect(DEAD_INPUT_WINDOW_MS_DEFAULT).toBeGreaterThan(0);
    expect(DEAD_INPUT_COOLDOWN_MS_DEFAULT).toBeGreaterThanOrEqual(1000);
  });
});
