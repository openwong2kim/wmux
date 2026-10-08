import { describe, it, expect } from 'vitest';
import {
  createDeadInputWatchdog,
  isNonInputKey,
  DEAD_INPUT_THRESHOLD_DEFAULT,
  DEAD_INPUT_WINDOW_MS_DEFAULT,
  DEAD_INPUT_COOLDOWN_MS_DEFAULT,
  describeDeclinedKey,
  keyKind,
  readXtermCompositionState,
  type DeadInputReport,
  type DeadInputWatchdogKey,
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

// #1950: the field log could not tell a handler swallow from xterm encoding
// nothing, nor say which modifiers the dead keys carried.
describe('deadInputWatchdog diagnostics (#1950)', () => {
  const setup = () => {
    let t = 0;
    const reports: DeadInputReport[] = [];
    const w = createDeadInputWatchdog({ report: (r) => reports.push(r), now: () => t });
    const press = (k: Partial<DeadInputWatchdogKey>) => {
      w.onKeyDown({ keyCode: 32, isComposing: false, code: 'Space', ...k });
      t += 200;
    };
    return { w, reports, press };
  };

  it('reports the shape of the field episode: Space with a stale Meta, handed to xterm', () => {
    const { reports, press } = setup();
    const k = { key: ' ', mods: 'Meta', staleMods: 'Meta', defaultPrevented: false, verdict: 'none' };
    press(k); press(k); press(k); press(k);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      keyCodes: [32],
      codes: ['Space'],
      keyKinds: ['char'],
      mods: ['Meta'],
      staleMods: ['Meta'],
      defaultPrevented: 0,
      verdicts: ['none'],
    });
  });

  it('collects distinct values and counts prevented keys', () => {
    const { reports, press } = setup();
    press({ keyCode: 70, code: 'KeyF', key: 'f', mods: 'none', staleMods: '', verdict: 'none' });
    press({ keyCode: 65, code: 'KeyA', key: 'a', mods: 'none', staleMods: '', verdict: 'none' });
    press({ keyCode: 66, code: 'KeyB', key: 'Dead', mods: 'Ctrl+Shift', staleMods: 'Ctrl+Shift', defaultPrevented: true, verdict: 'ctrlShift' });
    press({ keyCode: 76, code: 'KeyL', key: 'l', mods: 'none', staleMods: '', defaultPrevented: true, verdict: 'handler' });
    expect(reports).toHaveLength(1);
    expect(reports[0].keyKinds).toEqual(['char', 'Dead']);
    expect(reports[0].mods).toEqual(['none', 'Ctrl+Shift']);
    expect(reports[0].staleMods).toEqual(['Ctrl+Shift']); // an empty set is not listed
    expect(reports[0].defaultPrevented).toBe(2);
    expect(reports[0].verdicts).toEqual(['none', 'ctrlShift', 'handler']);
  });

  it('never carries the typed characters themselves', () => {
    const { reports, press } = setup();
    press({ key: 'p', code: 'KeyP', keyCode: 80 });
    press({ key: 'w', code: 'KeyW', keyCode: 87 });
    press({ key: 'ą', code: 'KeyA', keyCode: 65 });
    press({ key: 'd', code: 'KeyD', keyCode: 68 });
    expect(reports[0].keyKinds).toEqual(['char']);
    expect(JSON.stringify(reports[0])).not.toMatch(/"[pwąd]"/);
  });

  it('a new episode after onData does not inherit the previous diagnostics', () => {
    const { w, reports, press } = setup();
    press({ mods: 'Meta', staleMods: 'Meta', verdict: 'ctrlShift', defaultPrevented: true });
    w.onData();
    for (let i = 0; i < 4; i++) press({ key: ' ', mods: 'none', staleMods: '', verdict: 'none' });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ mods: ['none'], staleMods: [], verdicts: ['none'], defaultPrevented: 0 });
  });

  it('keyKind names keys and hides characters', () => {
    expect(keyKind('a')).toBe('char');
    expect(keyKind(' ')).toBe('char');
    expect(keyKind('😀')).toBe('char');
    expect(keyKind('Process')).toBe('Process');
    expect(keyKind('Unidentified')).toBe('Unidentified');
    expect(keyKind(undefined)).toBe('unknown');
  });

  it('readXtermCompositionState reads xterm private flags defensively', () => {
    expect(readXtermCompositionState({ _core: { _compositionHelper: { _isComposing: true, _isSendingComposition: false } } })).toBe('1/0');
    expect(readXtermCompositionState({ _core: { _compositionHelper: { _isComposing: false, _isSendingComposition: true } } })).toBe('0/1');
    expect(readXtermCompositionState({})).toBe('?');
    expect(readXtermCompositionState(null)).toBe('?');
  });
});

describe('describeDeclinedKey (#1950)', () => {
  const ev = (over: Partial<{ key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }>) => ({
    key: 'a', code: 'KeyA', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over,
  });
  const ctx = {
    isPressDuplicate: () => false,
    bindings: [{ action: 'searchTerminal' as const, combo: 'Ctrl+F' }],
    prefixKeyCode: 'KeyB',
  };

  it('names the branch that swallowed the key', () => {
    expect(describeDeclinedKey(ev({ key: 'f', code: 'KeyF', ctrlKey: true }), ctx)).toBe('shortcut:searchTerminal');
    expect(describeDeclinedKey(ev({ key: 'b', code: 'KeyB', ctrlKey: true }), ctx)).toBe('prefixTrigger');
    expect(describeDeclinedKey(ev({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }), ctx)).toBe('ctrlShift');
    expect(describeDeclinedKey(ev({}), { ...ctx, isPressDuplicate: () => true })).toBe('pressGuard');
  });

  it('falls back to `handler` for branches that write their own byte', () => {
    expect(describeDeclinedKey(ev({ key: 'c', code: 'KeyC', ctrlKey: true }), ctx)).toBe('handler');
  });
});
