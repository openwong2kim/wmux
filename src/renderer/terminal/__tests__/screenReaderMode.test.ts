import { describe, it, expect, afterEach } from 'vitest';
import {
  followScreenReader,
  imeResidueGuardStep,
  syncScreenReaderMode,
  type ScreenReaderModeTerminal,
} from '../screenReaderMode';
import { screenReaderOn, setScreenReaderOn, subscribeScreenReader } from '../../utils/screenReader';

function harness(opts: { mode?: boolean; attached?: boolean; settingOn?: boolean } = {}) {
  const terminal: ScreenReaderModeTerminal = { options: { screenReaderMode: opts.mode ?? false } };
  const state = { attached: opts.attached ?? false, settingOn: opts.settingOn ?? true, attaches: 0, detaches: 0 };
  const unsubscribe = followScreenReader(terminal, {
    on: screenReaderOn,
    subscribe: subscribeScreenReader,
    guardSettingOn: () => state.settingOn,
    guard: {
      attached: () => state.attached,
      attach: () => { state.attached = true; state.attaches++; },
      detach: () => { state.attached = false; state.detaches++; },
    },
  });
  return { terminal, state, unsubscribe };
}

afterEach(() => setScreenReaderOn(false));

describe('imeResidueGuardStep', () => {
  it.each([
    // attached, mode, setting → step
    [true, true, true, 'detach'],
    [true, true, false, 'detach'],
    [false, true, true, 'keep'],
    [false, true, false, 'keep'],
    [false, false, true, 'attach'],
    [false, false, false, 'keep'],
    [true, false, true, 'keep'],
    [true, false, false, 'keep'],
  ] as const)('attached=%s mode=%s setting=%s → %s', (attached, screenReaderMode, settingOn, step) => {
    expect(imeResidueGuardStep({ attached, screenReaderMode, settingOn })).toBe(step);
  });
});

describe('syncScreenReaderMode', () => {
  it('sets an adopted terminal to the current state and reports the change', () => {
    const terminal: ScreenReaderModeTerminal = { options: { screenReaderMode: false } };
    expect(syncScreenReaderMode(terminal, true)).toBe(true);
    expect(terminal.options.screenReaderMode).toBe(true);
    expect(syncScreenReaderMode(terminal, true)).toBe(false);
  });

  it('leaves a terminal without the option untouched while off', () => {
    const terminal: ScreenReaderModeTerminal = { options: {} };
    expect(syncScreenReaderMode(terminal, false)).toBe(false);
    expect('screenReaderMode' in terminal.options).toBe(false);
  });
});

describe('followScreenReader', () => {
  it('turns the mode on and drops the attached guard', () => {
    const { terminal, state } = harness({ attached: true });
    setScreenReaderOn(true);
    expect(terminal.options.screenReaderMode).toBe(true);
    expect(state.attached).toBe(false);
    expect(state.detaches).toBe(1);
  });

  it('turns the mode off and re-attaches the guard only when the setting is on', () => {
    setScreenReaderOn(true);
    const on = harness({ mode: true, settingOn: true });
    const off = harness({ mode: true, settingOn: false });
    setScreenReaderOn(false);
    expect(on.terminal.options.screenReaderMode).toBe(false);
    expect(on.state.attaches).toBe(1);
    expect(off.terminal.options.screenReaderMode).toBe(false);
    expect(off.state.attaches).toBe(0);
  });

  it('stops following after the unsubscribe', () => {
    const { terminal, state, unsubscribe } = harness({ attached: true });
    unsubscribe();
    setScreenReaderOn(true);
    expect(terminal.options.screenReaderMode).toBe(false);
    expect(state.detaches).toBe(0);
  });
});
