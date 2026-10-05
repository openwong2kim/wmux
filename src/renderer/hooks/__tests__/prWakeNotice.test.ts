// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import { PR_WAKE_NOTICE_KEY, markPrWakeNoticeSeen, prWakeNoticePending, showPrWakeNoticeOnce } from '../prWakeNotice';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('PR wake one-time notice', () => {
  beforeEach(() => useStore.getState().clearToasts());

  it('shows once, sticky, with a way to Settings — never again', () => {
    const storage = memoryStorage();
    const id = showPrWakeNoticeOnce(storage);
    expect(id).toEqual(expect.any(String));
    expect(storage.getItem(PR_WAKE_NOTICE_KEY)).toBe('1');
    const [toast] = useStore.getState().toasts;
    // The id is the toast's, so the first-boot queue can hold until it is dismissed.
    expect(toast.id).toBe(id);
    expect(toast.persist).toBe(true);
    expect(toast.message).toMatch(/Wake the agent on PR events/);
    toast.action?.onClick();
    expect(useStore.getState().settingsPanelVisible).toBe(true);
    expect(showPrWakeNoticeOnce(storage)).toBeNull();
    expect(useStore.getState().toasts).toHaveLength(1);
  });

  it('never shows without storage (so it cannot show on every start)', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(showPrWakeNoticeOnce(throwing)).toBeNull();
    expect(showPrWakeNoticeOnce(null)).toBeNull();
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});

describe('PR wake notice on a fresh install', () => {
  beforeEach(() => useStore.getState().clearToasts());

  it('marking it seen (fresh install) means it never shows, now or later', () => {
    const storage = memoryStorage();
    expect(prWakeNoticePending(storage)).toBe(true);
    markPrWakeNoticeSeen(storage);
    expect(prWakeNoticePending(storage)).toBe(false);
    expect(showPrWakeNoticeOnce(storage)).toBeNull();
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('is not pending without storage', () => {
    expect(prWakeNoticePending(null)).toBe(false);
    expect(prWakeNoticePending({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
  });
});
