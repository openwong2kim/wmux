import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  createBrowserHelpSlice,
  selectHelpRequestForSurface,
  type BrowserHelpSlice,
} from '../browserHelpSlice';
import type { BrowserHelpRequestInfo } from '../../../../shared/browserHelp';

type TestState = BrowserHelpSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createBrowserHelpSlice(...args),
    }))
  );
}

function makeRequest(
  requestId: string,
  overrides: Partial<BrowserHelpRequestInfo> = {},
): BrowserHelpRequestInfo {
  return {
    requestId,
    workspaceId: 'ws-1',
    surfaceId: 'surf-1',
    prompt: 'Sign in, then press Done.',
    deadlineAt: 1_700_000_300_000,
    ...overrides,
  };
}

describe('browserHelpSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('starts empty', () => {
    expect(store.getState().browserHelpRequests).toEqual({});
    expect(store.getState().browserHelpOrder).toEqual([]);
  });

  it('records a request and appends it to the order', () => {
    store.getState().addBrowserHelpRequest(makeRequest('r1'));
    expect(store.getState().browserHelpRequests.r1?.prompt).toBe('Sign in, then press Done.');
    expect(store.getState().browserHelpOrder).toEqual(['r1']);
  });

  it('is idempotent on requestId: overwrites the record, never duplicates the order', () => {
    store.getState().addBrowserHelpRequest(makeRequest('r1'));
    store.getState().addBrowserHelpRequest(makeRequest('r1', { prompt: 'solve the CAPTCHA' }));
    expect(store.getState().browserHelpOrder).toEqual(['r1']);
    expect(store.getState().browserHelpRequests.r1?.prompt).toBe('solve the CAPTCHA');
  });

  it('removes from both maps, and a repeat removal is a no-op', () => {
    store.getState().addBrowserHelpRequest(makeRequest('r1'));
    store.getState().addBrowserHelpRequest(makeRequest('r2', { surfaceId: 'surf-2' }));
    store.getState().removeBrowserHelpRequest('r1');
    expect(store.getState().browserHelpRequests).toEqual({ r2: makeRequest('r2', { surfaceId: 'surf-2' }) });
    expect(store.getState().browserHelpOrder).toEqual(['r2']);
    // The BROWSER_HELP_CLOSED push landing after an optimistic local removal.
    store.getState().removeBrowserHelpRequest('r1');
    expect(store.getState().browserHelpOrder).toEqual(['r2']);
  });

  it('removes an unknown id without throwing', () => {
    expect(() => store.getState().removeBrowserHelpRequest('nope')).not.toThrow();
  });
});

describe('selectHelpRequestForSurface', () => {
  it('returns the stored record for a surface, by identity', () => {
    const record = makeRequest('r1');
    const state = { browserHelpRequests: { r1: record }, browserHelpOrder: ['r1'] };
    // Identity matters: BrowserPanel subscribes with a bare selector and relies
    // on the record being the stored object, not a fresh projection.
    expect(selectHelpRequestForSurface(state as never, 'surf-1')).toBe(record);
  });

  it('returns undefined for a surface with no open request', () => {
    const state = {
      browserHelpRequests: { r1: makeRequest('r1') },
      browserHelpOrder: ['r1'],
    };
    expect(selectHelpRequestForSurface(state as never, 'surf-other')).toBeUndefined();
  });

  it('ignores a request that carries no surface', () => {
    const state = {
      browserHelpRequests: { r1: makeRequest('r1', { surfaceId: undefined }) },
      browserHelpOrder: ['r1'],
    };
    expect(selectHelpRequestForSurface(state as never, 'surf-1')).toBeUndefined();
  });

  it('skips an order entry whose record is gone (torn intermediate state)', () => {
    const state = { browserHelpRequests: {}, browserHelpOrder: ['r1'] };
    expect(selectHelpRequestForSurface(state as never, 'surf-1')).toBeUndefined();
  });
});
