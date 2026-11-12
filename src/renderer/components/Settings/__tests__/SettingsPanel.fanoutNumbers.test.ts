import { describe, expect, it, vi } from 'vitest';
import { createFanoutSaver } from '../SettingsPanel';
import { createInvoke } from '../../../hooks/useIpc';

const isNumber = (v: unknown): v is number => typeof v === 'number';
const isLimit = (v: unknown): v is number | null => v === null || typeof v === 'number';
const fail = async (): Promise<never> => { throw new Error('[UNKNOWN] write failed'); };

describe('createFanoutSaver', () => {
  it('shows the value at once, then the value main stored', async () => {
    const shown: number[] = [];
    const toast = vi.fn();
    const s = createFanoutSaver({ show: (v) => shown.push(v), save: async () => 64, reload: async () => 8, isValue: isNumber, invoke: createInvoke(undefined, toast), initial: 8 });
    await s.change(70);
    expect(shown).toEqual([70, 64]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a rejected save raises the error toast and goes back to the stored value', async () => {
    const shown: number[] = [];
    const toast = vi.fn();
    const reload = vi.fn(async () => 64);
    const s = createFanoutSaver({ show: (v) => shown.push(v), save: fail, reload, isValue: isNumber, invoke: createInvoke(undefined, toast), initial: 16 });
    await s.change(1);
    expect(shown).toEqual([1, 64]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('an optional limit: a failed save goes back to the stored no-limit (null), and a failed clear to the stored cap', async () => {
    const shown: Array<number | null> = [];
    const toast = vi.fn();
    const a = createFanoutSaver<number | null>({ show: (v) => shown.push(v), save: fail, reload: async () => null, isValue: isLimit, invoke: createInvoke(undefined, toast), initial: null });
    await a.change(4);
    const b = createFanoutSaver<number | null>({ show: (v) => shown.push(v), save: fail, reload: async () => 6, isValue: isLimit, invoke: createInvoke(undefined, toast), initial: 6 });
    await b.change(null);
    expect(shown).toEqual([4, null, null, 6]);
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('when the read-back fails too, the last CONFIRMED value comes back, not an unanswered one', async () => {
    const shown: Array<number | null> = [];
    let release: () => void = () => undefined;
    const slow = () => new Promise<never>((_r, reject) => { release = () => reject(new Error('x')); });
    const s = createFanoutSaver<number | null>({ show: (v) => shown.push(v), save: slow, reload: fail, isValue: isLimit, invoke: createInvoke({ toastOnError: false }, vi.fn()), initial: null });
    s.confirm(null);
    const first = s.change(5);
    const firstRelease = release;
    const second = s.change(7);
    firstRelease();
    release();
    await Promise.all([first, second]);
    expect(shown).toEqual([5, 7, null]);
  });

  it('only the latest change reaches the field: a slower answer to an earlier one is dropped', async () => {
    const shown: number[] = [];
    const answers: Array<(v: number) => void> = [];
    const save = () => new Promise<number>((resolve) => { answers.push(resolve); });
    const s = createFanoutSaver({ show: (v) => shown.push(v), save, reload: async () => 0, isValue: isNumber, invoke: createInvoke(undefined, vi.fn()), initial: 8 });
    const first = s.change(5);
    const second = s.change(7);
    answers[1]?.(7);
    await second;
    answers[0]?.(5);
    await first;
    expect(shown).toEqual([5, 7, 7]);
  });

  it('an answer that is not a value (version skew) is not shown: the read-back decides', async () => {
    const shown: number[] = [];
    const s = createFanoutSaver({ show: (v) => shown.push(v), save: async () => undefined, reload: async () => 12, isValue: isNumber, invoke: createInvoke(undefined, vi.fn()), initial: 8 });
    await s.change(20);
    expect(shown).toEqual([20, 12]);
  });
});
