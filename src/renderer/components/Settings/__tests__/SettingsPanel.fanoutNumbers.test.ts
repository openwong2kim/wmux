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

  it('when the read-back fails too, the last confirmed value comes back', async () => {
    const shown: number[] = [];
    await saveFanoutNumber(3, 1, (v) => shown.push(v), async () => { throw new Error('x'); }, async () => { throw new Error('y'); }, createInvoke({ toastOnError: false }, vi.fn()));
    expect(shown).toEqual([3, 1]);
  });
});
