// @vitest-environment jsdom
//
// Where the wizard looks for its optional hooks bridge.
//
// The accessor is allowed to return null ("older preload"), and the wizard
// then hides the offer without a word. That makes a wrong path invisible: the
// statusline offer once read `electronAPI.statuslineBridge` while the preload
// exposes `electronAPI.deck.statuslineBridge`, so it never rendered in any
// real build and no test noticed. These pin the path itself.

import { describe, it, expect, afterEach } from 'vitest';
import { hooksBridge } from '../FirstRunWizard';

const stubHooks = {
  status: async () => ({ installed: false }),
  install: async () => ({ ok: true, error: null }),
};

function setElectronApi(value: unknown): void {
  (window as unknown as { electronAPI?: unknown }).electronAPI = value;
}

afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI; });

describe('first-run wizard bridge accessors', () => {
  it('finds the hooks bridge under electronAPI.deck (the preload path)', () => {
    setElectronApi({ deck: { hooksBridge: stubHooks } });
    expect(hooksBridge()).toBe(stubHooks);
  });

  it('does not read it off the root of electronAPI', () => {
    setElectronApi({ hooksBridge: stubHooks });
    expect(hooksBridge()).toBeNull();
  });

  it('returns null when the preload predates the bridge', () => {
    setElectronApi({ deck: {} });
    expect(hooksBridge()).toBeNull();
  });
});
