// Boot ordering for the one-time site guides auto-enable. Two async inputs land
// in either order: main's backend value (hydrateBrowserBackend) and the saved
// session (loadSession). The rule must run once both are in, or a session load
// arriving second would overwrite the auto-enabled value with the saved one.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../uiSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type SessionData } from '../../../../shared/types';
import type { BrowserBackend } from '../../../../shared/browserBackend';

vi.mock('../../../i18n', () => ({
  setLocale: vi.fn(),
  t: (key: string) => key,
  detectSupportedLocale: () => 'en',
}));

vi.mock('../../../themes', () => ({
  applyCustomCssVars: vi.fn(),
  clearCustomCssVars: vi.fn(),
  migrateThemeId: (id: string) => id,
  migrateCustomThemeColors: (c: unknown) => c,
  DEFAULT_CUSTOM_THEME: {},
}));

beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: { setAttribute: vi.fn() } },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI: { settings: {} } },
    writable: true,
    configurable: true,
  });
});

type TestState = UISlice & WorkspaceSlice;

function createTestStore() {
  return create<TestState>()(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    immer((...args: any) => ({
      ...createUISlice(...(args as Parameters<typeof createUISlice>)),
      ...createWorkspaceSlice(...(args as Parameters<typeof createWorkspaceSlice>)),
    })),
  );
}

function session(fields: Partial<SessionData>, { empty = false } = {}): SessionData {
  const ws = createWorkspace('A');
  return {
    workspaces: empty ? [] : [ws],
    activeWorkspaceId: empty ? '' : ws.id,
    sidebarVisible: true,
    ...fields,
  } as SessionData;
}

type Order = 'hydration-then-session' | 'session-then-hydration';
const ORDERS: Order[] = ['hydration-then-session', 'session-then-hydration'];

function boot(order: Order, backend: BrowserBackend, saved: Partial<SessionData>, opts: { empty?: boolean } = {}) {
  const store = createTestStore();
  const hydrate = () => store.getState().hydrateBrowserBackend(backend);
  const load = () => store.getState().loadSession(session(saved, opts));
  if (order === 'hydration-then-session') {
    hydrate();
    load();
  } else {
    load();
    hydrate();
  }
  return store.getState();
}

describe('site guides auto-enable — boot ordering', () => {
  for (const order of ORDERS) {
    it(`turns guides on for a chrome user without the marker (${order})`, () => {
      const s = boot(order, 'chrome', { siteGuidesEnabled: false });
      expect(s.siteGuidesEnabled).toBe(true);
      expect(s.siteGuidesAutoEnabled).toBe(true);
    });

    it(`keeps guides off for a chrome user who already has the marker (${order})`, () => {
      const s = boot(order, 'chrome', { siteGuidesEnabled: false, siteGuidesAutoEnabled: true });
      expect(s.siteGuidesEnabled).toBe(false);
      expect(s.siteGuidesAutoEnabled).toBe(true);
    });

    // loadSession returns early for a session with no workspaces; the saved
    // marker must still be honoured, or guides the user turned off come back.
    it(`keeps guides off for a chrome user with the marker in an empty-workspace session (${order})`, () => {
      const s = boot(order, 'chrome', { siteGuidesEnabled: false, siteGuidesAutoEnabled: true }, { empty: true });
      expect(s.siteGuidesEnabled).toBe(false);
      expect(s.siteGuidesAutoEnabled).toBe(true);
    });

    it(`leaves a builtin user untouched (${order})`, () => {
      const s = boot(order, 'builtin', { siteGuidesEnabled: false });
      expect(s.siteGuidesEnabled).toBe(false);
      expect(s.siteGuidesAutoEnabled).toBe(false);
    });
  }

  // The backend is read synchronously at startup, so the select can be used
  // before the session load lands. Patching then would be overwritten by the
  // saved guides=false while the marker stayed set, losing the auto-enable.
  it('keeps the auto-enable when chrome is chosen before the session lands', () => {
    const store = createTestStore();
    store.getState().hydrateBrowserBackend('builtin');
    store.getState().setBrowserBackend('chrome');
    expect(store.getState().siteGuidesAutoEnabled).toBe(false);
    store.getState().loadSession(session({ siteGuidesEnabled: false }));
    expect(store.getState().siteGuidesEnabled).toBe(true);
    expect(store.getState().siteGuidesAutoEnabled).toBe(true);
  });

  it('does not run before the session has landed', () => {
    const store = createTestStore();
    store.getState().hydrateBrowserBackend('chrome');
    expect(store.getState().siteGuidesEnabled).toBe(false);
    expect(store.getState().siteGuidesAutoEnabled).toBe(false);
  });

  it('runs for a first launch with no saved session once hydration lands', () => {
    const store = createTestStore();
    store.getState().markSessionSettingsLoaded();
    expect(store.getState().siteGuidesEnabled).toBe(false);
    store.getState().hydrateBrowserBackend('chrome');
    expect(store.getState().siteGuidesEnabled).toBe(true);
  });

  it('falls back to the current backend when hydration returns null', () => {
    const store = createTestStore();
    store.getState().setBrowserBackend('builtin');
    store.getState().loadSession(session({ siteGuidesEnabled: false }));
    store.getState().hydrateBrowserBackend(null);
    expect(store.getState().siteGuidesEnabled).toBe(false);
  });

  it('ignores a non-boolean persisted marker', () => {
    const s = boot('hydration-then-session', 'chrome', {
      siteGuidesEnabled: false,
      siteGuidesAutoEnabled: 'true' as unknown as boolean,
    });
    expect(s.siteGuidesEnabled).toBe(true);
    expect(s.siteGuidesAutoEnabled).toBe(true);
  });
});
