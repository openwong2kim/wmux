import { describe, expect, it, vi } from 'vitest';
import { stoppedWorkOf, toastStoppedWork } from '../botsStop';

const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;

describe('stopped work on Off', () => {
  it('reads the report only when main sends a well-formed one', () => {
    expect(stoppedWorkOf({ enabled: false })).toBeNull();
    expect(stoppedWorkOf(null)).toBeNull();
    expect(stoppedWorkOf({ stoppedWork: { workers: '2', tasks: 0, ok: true } })).toBeNull();
    expect(stoppedWorkOf({ stoppedWork: { workers: 2, tasks: 1, ok: true } })).toEqual({ workers: 2, tasks: 1, ok: true });
  });

  it('toasts the count, nothing when no worker ran or main sent no report', () => {
    const pushToast = vi.fn();
    toastStoppedWork({ enabled: false }, t, { pushToast }, {});
    toastStoppedWork({ stoppedWork: { workers: 0, tasks: 0, ok: true } }, t, { pushToast }, {});
    expect(pushToast).not.toHaveBeenCalled();
    toastStoppedWork({ stoppedWork: { workers: 1, tasks: 1, ok: true } }, t, { pushToast }, {});
    expect(pushToast).toHaveBeenLastCalledWith({ message: 'settings.factory.offStoppedOne{"count":1}', level: 'info' });
  });

  it('a failed stop offers Try again through Stop all', async () => {
    const pushToast = vi.fn();
    const stopAll = vi.fn(async () => ({ ok: true, botsInterrupted: 0, workersStopped: 2, gatesCancelled: 0 }));
    toastStoppedWork({ stoppedWork: { workers: 0, tasks: 0, ok: false } }, t, { pushToast }, { stopAll });
    const toast = pushToast.mock.calls[0][0];
    expect(toast).toMatchObject({ message: 'settings.factory.offStopFailed', level: 'error', persist: true });
    toast.action.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledTimes(2);
  });
});
