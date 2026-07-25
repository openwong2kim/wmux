import { describe, it, expect } from 'vitest';
import { revokeDeviceAndDisconnect } from '../deviceRevoke';
import type { DeviceRevokeResult } from '../DeviceStore';

// Pure — no disk, no daemon. This covers the seam the store's own tests cannot
// reach: the store proves a revoked device is blocked for NEW requests, but the
// teardown of streams it ALREADY holds lives in the web server, and only this
// wiring decides whether that teardown runs.

/** Records what was called, in order, so persist-before-teardown is provable. */
function harness(revokeResult: DeviceRevokeResult) {
  const calls: string[] = [];
  const disconnected: string[] = [];
  return {
    calls,
    disconnected,
    roster: {
      revoke(deviceId: string): DeviceRevokeResult {
        calls.push(`revoke:${deviceId}`);
        return revokeResult;
      },
    },
    streams: {
      disconnectDevice(deviceId: string): number {
        calls.push(`disconnect:${deviceId}`);
        disconnected.push(deviceId);
        return 2;
      },
    },
  };
}

describe('daemon.web.deviceRevoke wiring', () => {
  it('persists BEFORE tearing down, and reports what it closed', () => {
    const h = harness({ ok: true });

    const result = revokeDeviceAndDisconnect('dev-1', h.roster, h.streams);

    expect(result).toEqual({ ok: true, closed: 2 });
    // Contract §5: the write completes first. If these ever invert, an operator
    // could be told "revoked" about a credential that comes back on restart.
    expect(h.calls).toEqual(['revoke:dev-1', 'disconnect:dev-1']);
  });

  it('still cuts live streams when the roster write FAILED', () => {
    const h = harness({ ok: false, reason: 'persist-failed' });

    const result = revokeDeviceAndDisconnect('dev-1', h.roster, h.streams);

    // The store blocked the device in memory regardless of the disk, and an
    // established SSE stream never re-authenticates — so leaving it up would
    // keep pane bytes flowing to a device the operator just revoked.
    expect(h.disconnected).toEqual(['dev-1']);
    // And the operator is still told the truth about the write.
    expect(result).toEqual({ ok: false, reason: 'persist-failed', closed: 2 });
  });

  it('does not disconnect anything for a device that was never paired', () => {
    const h = harness({ ok: false, reason: 'not-found' });

    const result = revokeDeviceAndDisconnect('ghost', h.roster, h.streams);

    expect(result).toEqual({ ok: false, reason: 'not-found' });
    // Nothing was blocked in memory and nothing exists to tear down.
    expect(h.disconnected).toEqual([]);
    expect(h.calls).toEqual(['revoke:ghost']);
  });

  it('refuses an empty id without touching the roster at all', () => {
    const h = harness({ ok: true });

    expect(revokeDeviceAndDisconnect('', h.roster, h.streams)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(h.calls).toEqual([]);
  });

  it('disconnects exactly once, for exactly the named device', () => {
    const h = harness({ ok: true });

    revokeDeviceAndDisconnect('dev-1', h.roster, h.streams);

    // Other devices' streams and the operator's own are never in scope here.
    expect(h.disconnected).toEqual(['dev-1']);
  });

  it('reports zero closed when the device held no live stream', () => {
    const calls: string[] = [];
    const result = revokeDeviceAndDisconnect(
      'dev-1',
      {
        revoke: (): DeviceRevokeResult => {
          calls.push('revoke');
          return { ok: true };
        },
      },
      {
        disconnectDevice: (): number => {
          calls.push('disconnect');
          return 0;
        },
      },
    );

    // A revoke with nothing to cut is still a successful revoke.
    expect(result).toEqual({ ok: true, closed: 0 });
    expect(calls).toEqual(['revoke', 'disconnect']);
  });

  it('lets a disconnect throw rather than reporting a false success', () => {
    // The revocation is already durable here and revoke() is idempotent, so a
    // retry re-runs the teardown. Swallowing this would hide a real bug behind
    // an "ok" the operator would trust.
    expect(() =>
      revokeDeviceAndDisconnect(
        'dev-1',
        { revoke: (): DeviceRevokeResult => ({ ok: true }) },
        {
          disconnectDevice: (): number => {
            throw new Error('socket teardown exploded');
          },
        },
      ),
    ).toThrow(/socket teardown exploded/);
  });
});
