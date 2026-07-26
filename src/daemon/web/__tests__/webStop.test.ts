import { describe, expect, it, vi } from 'vitest';
import { stopWebServerDurably } from '../webStop';

describe('stopWebServerDurably (#620)', () => {
  it('persists the disabled intent before stopping the live server', async () => {
    const order: string[] = [];
    const revoke = vi.fn(() => order.push('revoke'));
    const stop = vi.fn(async () => {
      order.push('stop');
      return { stopped: true };
    });

    await expect(stopWebServerDurably(revoke, stop)).resolves.toEqual({ stopped: true });
    expect(order).toEqual(['revoke', 'stop']);
  });

  it('still stops live after persistence fails, then rejects the false acknowledgement', async () => {
    const persistenceError = new Error('disk denied the disabled record');
    const revoke = vi.fn(() => {
      throw persistenceError;
    });
    const stop = vi.fn(async () => ({ stopped: true }));

    await expect(stopWebServerDurably(revoke, stop)).rejects.toThrow(
      'The web server is stopped now, but persisted state could not be revoked; ' +
        'it may return after a daemon restart: disk denied the disabled record',
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it('propagates the original live-stop error when persistence succeeded', async () => {
    const liveError = new Error('listener close failed');
    const revoke = vi.fn();
    const stop = vi.fn(async () => {
      throw liveError;
    });

    await expect(stopWebServerDurably(revoke, stop)).rejects.toBe(liveError);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('reports both failures when persistence and the live stop fail together', async () => {
    const revoke = vi.fn(() => {
      throw new Error('disk remained enabled');
    });
    const stop = vi.fn(async () => {
      throw new Error('listener close failed');
    });

    await expect(stopWebServerDurably(revoke, stop)).rejects.toThrow(
      'The web server could not be stopped now (listener close failed), and persisted state ' +
        'could not be revoked (disk remained enabled); the listener may still be running ' +
        'and may return after a daemon restart.',
    );
    expect(stop).toHaveBeenCalledOnce();
  });
});
