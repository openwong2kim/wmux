// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import { PR_WAKE_NOTICE_KEY, showPrWakeNoticeOnce } from '../prWakeNotice';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe('PR wake one-time notice', () => {
  beforeEach(() => useStore.getState().clearToasts());

  it('shows once, sticky, with a way to Settings — never again', () => {
    const storage = memoryStorage();
    expect(showPrWakeNoticeOnce(storage)).toBe(true);
    expect(storage.getItem(PR_WAKE_NOTICE_KEY)).toBe('1');
    const [toast] = useStore.getState().toasts;
    expect(toast.persist).toBe(true);
    expect(toast.message).toMatch(/Wake the agent on PR events/);
    toast.action?.onClick();
    expect(useStore.getState().settingsPanelVisible).toBe(true);
    expect(showPrWakeNoticeOnce(storage)).toBe(false);
    expect(useStore.getState().toasts).toHaveLength(1);
  });

  it('never shows without storage (so it cannot show on every start)', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(showPrWakeNoticeOnce(throwing)).toBe(false);
    expect(showPrWakeNoticeOnce(null)).toBe(false);
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});
