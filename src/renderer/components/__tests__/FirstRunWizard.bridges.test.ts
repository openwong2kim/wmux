// @vitest-environment jsdom
//
// Where the wizard looks for its optional bridges.
//
// Both accessors are allowed to return null ("older preload"), and the wizard
// then hides the offer without a word. That makes a wrong path invisible: the
// statusline accessor read `electronAPI.statuslineBridge` while the preload
// exposes `electronAPI.deck.statuslineBridge`, so the offer never rendered in
// any real build and no test noticed. These pin the path itself.

import { describe, it, expect, afterEach } from 'vitest';
import { hooksBridge, statuslineBridge } from '../FirstRunWizard';

const stubStatusline = {
  status: async () => ({
    installed: false,
    outcome: { scriptDest: '', scriptExists: false, targets: [] },
  }),
  install: async () => ({ ok: true, error: null, targets: [] }),
};
const stubHooks = {
  status: async () => ({ installed: false }),
  install: async () => ({ ok: true, error: null }),
};

function setElectronApi(value: unknown): void {
  (window as unknown as { electronAPI?: unknown }).electronAPI = value;
}

afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI; });

describe('first-run wizard bridge accessors', () => {
  it('finds both bridges under electronAPI.deck (the preload path)', () => {
    setElectronApi({ deck: { statuslineBridge: stubStatusline, hooksBridge: stubHooks } });
    expect(statuslineBridge()).toBe(stubStatusline);
    expect(hooksBridge()).toBe(stubHooks);
  });

  it('does not read them off the root of electronAPI', () => {
    setElectronApi({ statuslineBridge: stubStatusline, hooksBridge: stubHooks });
    expect(statuslineBridge()).toBeNull();
    expect(hooksBridge()).toBeNull();
  });

  it('returns null when the preload predates the bridges', () => {
    setElectronApi({ deck: {} });
    expect(statuslineBridge()).toBeNull();
    expect(hooksBridge()).toBeNull();
  });
});
