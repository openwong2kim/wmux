// @wmux-lane unit
// The platform is a parameter here ("win32" is data), never process.platform.
import { describe, expect, it, vi } from 'vitest';
import {
  createScreenReaderMonitor,
  includesScreenReader,
  parseProcessNames,
  screenReaderForcedForTest,
  type ScreenReaderMonitorDeps,
} from '../screenReader';

describe('includesScreenReader', () => {
  it.each([
    ['darwin', ['Finder', 'VoiceOver'], true],
    ['darwin', ['Finder', 'Rectangle'], false],
    ['darwin', ['voiceover'], false],
    ['win32', ['explorer.exe', 'NVDA.EXE'], true],
    ['win32', ['jfw.exe'], true],
    ['win32', ['Narrator.exe'], true],
    ['win32', ['explorer.exe'], false],
    ['linux', ['gnome-shell', 'orca'], true],
    ['linux', ['gnome-shell'], false],
    ['freebsd', ['orca'], false],
  ] as const)('%s %j → %s', (platform, running, expected) => {
    expect(includesScreenReader(platform, running)).toBe(expected);
  });
});

describe('parseProcessNames', () => {
  it('reads tasklist CSV names on Windows', () => {
    const out = '"System Idle Process","0","Services","0","8 K"\r\n"nvda.exe","4120","Console","1","60,120 K"\r\n';
    expect(parseProcessNames('win32', out)).toEqual(['System Idle Process', 'nvda.exe']);
  });
  it('reads one name per line elsewhere', () => {
    expect(parseProcessNames('darwin', 'launchd\nVoiceOver\n\n')).toEqual(['launchd', 'VoiceOver']);
  });
});

describe('screenReaderForcedForTest', () => {
  it('forces the state on for an isolated instance only', () => {
    expect(screenReaderForcedForTest({ WMUX_TEST_SCREEN_READER: '1' }, '-verify-a1')).toBe(true);
    expect(screenReaderForcedForTest({ WMUX_TEST_SCREEN_READER: '1' }, '')).toBe(false);
    expect(screenReaderForcedForTest({}, '-verify-a1')).toBe(false);
  });
});

function rig(init: { support: boolean; running: string[] }) {
  const state = { ...init };
  let supportChanged: (enabled: boolean) => void = () => undefined;
  const timers: Array<() => void> = [];
  const listProcesses = vi.fn(async () => state.running);
  const cleared = vi.fn();
  const deps: ScreenReaderMonitorDeps = {
    platform: 'darwin',
    accessibilitySupport: () => state.support,
    onAccessibilitySupportChanged: (fn) => { supportChanged = fn; },
    listProcesses,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: cleared,
  };
  const monitor = createScreenReaderMonitor(deps);
  const changes: boolean[] = [];
  monitor.onChange((on) => changes.push(on));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    state, monitor, changes, listProcesses, timers, cleared, settle,
    supportTurns: async (enabled: boolean) => { state.support = enabled; supportChanged(enabled); await settle(); },
    tick: async () => { for (const t of [...timers]) t(); await settle(); },
  };
}

describe('createScreenReaderMonitor', () => {
  it('reads no process list and stays off while Chromium accessibility is off', async () => {
    const r = rig({ support: false, running: ['VoiceOver'] });
    r.monitor.start();
    await r.settle();
    expect(r.monitor.isOn()).toBe(false);
    expect(r.listProcesses).not.toHaveBeenCalled();
    expect(r.timers).toHaveLength(0);
  });

  it('stays off when accessibility is on for another reason (no screen-reader process)', async () => {
    const r = rig({ support: true, running: ['Rectangle'] });
    r.monitor.start();
    await r.settle();
    expect(r.monitor.isOn()).toBe(false);
    expect(r.changes).toEqual([]);
  });

  it('turns on with a screen reader, and off when it quits while accessibility stays on', async () => {
    const r = rig({ support: false, running: [] });
    r.monitor.start();
    await r.settle();
    r.state.running = ['VoiceOver'];
    await r.supportTurns(true);
    expect(r.monitor.isOn()).toBe(true);
    expect(r.timers).toHaveLength(1);
    r.state.running = [];
    await r.tick();
    expect(r.monitor.isOn()).toBe(false);
    r.state.running = ['VoiceOver'];
    await r.tick();
    expect(r.changes).toEqual([true, false, true]);
  });

  it('turns off and stops reading processes when accessibility turns off', async () => {
    const r = rig({ support: true, running: ['VoiceOver'] });
    r.monitor.start();
    await r.settle();
    expect(r.monitor.isOn()).toBe(true);
    const reads = r.listProcesses.mock.calls.length;
    await r.supportTurns(false);
    expect(r.monitor.isOn()).toBe(false);
    expect(r.cleared).toHaveBeenCalled();
    expect(r.listProcesses.mock.calls.length).toBe(reads);
  });

  it('lets the newest read decide when an older one answers last', async () => {
    const r = rig({ support: true, running: [] });
    let releaseSlow: (names: string[]) => void = () => undefined;
    r.listProcesses.mockImplementationOnce(() => new Promise<string[]>((res) => { releaseSlow = res; }));
    r.monitor.start();
    await r.settle();
    // A newer read, after accessibility turned off: off.
    await r.supportTurns(false);
    releaseSlow(['VoiceOver']);
    await r.settle();
    expect(r.monitor.isOn()).toBe(false);
    expect(r.changes).toEqual([]);
  });

  it('is on without reading anything when forced for a test', async () => {
    const listProcesses = vi.fn(async () => [] as string[]);
    const monitor = createScreenReaderMonitor({
      platform: 'darwin',
      accessibilitySupport: () => false,
      onAccessibilitySupportChanged: () => undefined,
      listProcesses,
      forceOn: true,
    });
    monitor.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(monitor.isOn()).toBe(true);
    expect(listProcesses).not.toHaveBeenCalled();
  });
});
