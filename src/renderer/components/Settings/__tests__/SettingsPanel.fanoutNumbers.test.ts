import { describe, expect, it, vi } from 'vitest';
import { saveFanoutNumber } from '../SettingsPanel';
import { createInvoke } from '../../../hooks/useIpc';

describe('saveFanoutNumber', () => {
  it('shows the value at once, then the value main stored', async () => {
    const shown: number[] = [];
    const toast = vi.fn();
    await saveFanoutNumber(70, 8, (v) => shown.push(v), async () => 64, async () => 8, createInvoke(undefined, toast));
    expect(shown).toEqual([70, 64]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a rejected save raises the error toast and goes back to the stored value', async () => {
    const shown: number[] = [];
    const toast = vi.fn();
    const reload = vi.fn(async () => 64);
    await saveFanoutNumber(1, 16, (v) => shown.push(v), async () => { throw new Error('[UNKNOWN] write failed'); }, reload, createInvoke(undefined, toast));
    expect(shown).toEqual([1, 64]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('an optional limit: a failed save goes back to the stored no-limit (null), and a failed clear to the stored cap', async () => {
    const shown: Array<number | null> = [];
    const fail = async (): Promise<number | null> => { throw new Error('[UNKNOWN] write failed'); };
    const toast = vi.fn();
    await saveFanoutNumber<number | null>(4, null, (v) => shown.push(v), fail, async () => null, createInvoke(undefined, toast), true);
    await saveFanoutNumber<number | null>(null, 6, (v) => shown.push(v), fail, async () => 6, createInvoke(undefined, toast), true);
    expect(shown).toEqual([4, null, null, 6]);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('a required number does not take null from the read-back: the last confirmed value comes back', async () => {
    const shown: number[] = [];
    await saveFanoutNumber(5, 8, (v) => shown.push(v), async () => { throw new Error('x'); }, async () => null, createInvoke({ toastOnError: false }, vi.fn()));
    expect(shown).toEqual([5, 8]);
  });

  it('when the read-back fails too, the last confirmed value comes back', async () => {
    const shown: number[] = [];
    await saveFanoutNumber(3, 1, (v) => shown.push(v), async () => { throw new Error('x'); }, async () => { throw new Error('y'); }, createInvoke({ toastOnError: false }, vi.fn()));
    expect(shown).toEqual([3, 1]);
  });
});
