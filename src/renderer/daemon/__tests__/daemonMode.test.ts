import { describe, it, expect, beforeEach } from 'vitest';
import {
  isDaemonModeActive,
  setDaemonModeActive,
  resetDaemonModeForTests,
} from '../daemonMode';

// Phase A — A6 module-level flag. Verifies the get/set/reset contract so
// the consumers (dumpScrollbackBuffersSync, useTerminal race cancel,
// autosave timer) can rely on it.
describe('daemonMode flag', () => {
  beforeEach(() => {
    resetDaemonModeForTests();
  });

  it('defaults to false (local mode)', () => {
    expect(isDaemonModeActive()).toBe(false);
  });

  it('reflects setDaemonModeActive(true)', () => {
    setDaemonModeActive(true);
    expect(isDaemonModeActive()).toBe(true);
  });

  it('toggles back to false', () => {
    setDaemonModeActive(true);
    setDaemonModeActive(false);
    expect(isDaemonModeActive()).toBe(false);
  });

  it('resetDaemonModeForTests clears the flag', () => {
    setDaemonModeActive(true);
    resetDaemonModeForTests();
    expect(isDaemonModeActive()).toBe(false);
  });
});
