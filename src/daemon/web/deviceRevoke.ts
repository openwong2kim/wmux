import type { DeviceRevokeResult } from './DeviceStore';

/**
 * M3 — the ordering decision behind `daemon.web.deviceRevoke`, extracted from
 * the RPC closure so it can be tested without booting a daemon.
 *
 * Revocation has two halves that fail independently: the roster write, and
 * cutting the device's live SSE streams. Getting only the first right is what
 * this function exists to prevent — an established SSE stream never
 * re-authenticates, so a device that is blocked for every NEW request keeps
 * receiving pane bytes on the connection it already holds. Fail-closed on disk
 * and fail-open on live traffic is the half that actually leaks.
 */

/** What a device the operator asked to revoke is a live SSE client of. */
export interface DeviceStreamHost {
  /** Ends that device's open streams, returning how many were torn down. */
  disconnectDevice(deviceId: string): number;
}

/** Just the roster verb this needs — a full DeviceStore satisfies it. */
export interface DeviceRoster {
  revoke(deviceId: string): DeviceRevokeResult;
}

export interface DeviceRevokeRpcResult {
  /** True ONLY when the revocation reached disk and survives a restart. */
  ok: boolean;
  reason?: 'not-found' | 'persist-failed';
  /**
   * Live SSE streams cut. `{ok: false, closed: 2}` is not a contradiction — it
   * says the write did not land but the device's connections were severed
   * anyway, so the operator should retry before a restart.
   */
  closed?: number;
}

/**
 * Revoke a device, then cut its live streams.
 *
 * ORDER (contract §5): the roster write happens FIRST and always. On the
 * success path that is the whole guarantee — an operator who is told "revoked"
 * is never told it about a credential that comes back on the next daemon start.
 *
 * What this deliberately does NOT do is treat a failed write as a reason to
 * leave traffic flowing. `DeviceStore.revoke` blocks the device in memory
 * whether or not the write landed, so the streams go either way and the caller
 * still gets the honest `{ok: false}`. `not-found` is the one short circuit:
 * nothing was blocked, and there is nothing to disconnect.
 *
 * A throw from `disconnectDevice` is deliberately NOT caught. The revocation is
 * already durable at that point and `revoke` is idempotent, so a retry re-runs
 * the teardown; swallowing it would hide a real bug behind a success report.
 */
export function revokeDeviceAndDisconnect(
  deviceId: string,
  roster: DeviceRoster,
  streams: DeviceStreamHost,
): DeviceRevokeRpcResult {
  if (!deviceId) return { ok: false, reason: 'not-found' };

  const result = roster.revoke(deviceId);
  if (result.reason === 'not-found') return result;

  const closed = streams.disconnectDevice(deviceId);
  return { ...result, closed };
}
