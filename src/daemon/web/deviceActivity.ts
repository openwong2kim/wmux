import { DEVICE_ACTIVE_WINDOW_MS } from '../../shared/web';

/**
 * "Active now" for the paired-device roster.
 *
 * A device is active when it is holding a live stream right now OR it made an
 * authenticated request within the window. Both halves are needed:
 *
 *   - A stream is opened with a ticket and never re-authenticates, so a phone
 *     watching a pane for an hour has a stale `lastSeenAt` while plainly
 *     present (SSE-only).
 *   - A client that polls (the desktop's remote attach, a phone app between
 *     streams) holds no stream but touches `lastSeenAt` on every request.
 *
 * A registered push token is deliberately NOT activity: a phone in a pocket
 * that only receives notifications is paired, not present. A revoked device is
 * never active, whatever its timestamp says.
 */
export interface ActivityInput {
  deviceId: string;
  lastSeenAt: number;
  revokedAt?: number;
}

export function isDeviceActiveNow(
  device: ActivityInput,
  liveDeviceIds: ReadonlySet<string>,
  now: number,
  windowMs: number = DEVICE_ACTIVE_WINDOW_MS,
): boolean {
  if (device.revokedAt !== undefined) return false;
  if (liveDeviceIds.has(device.deviceId)) return true;
  return now - device.lastSeenAt <= windowMs;
}

/** Stamp `activeNow` onto every roster row (list time, never persisted). */
export function withActivity<T extends ActivityInput>(
  devices: readonly T[],
  liveDeviceIds: ReadonlySet<string>,
  now: number,
): Array<T & { activeNow: boolean }> {
  return devices.map((d) => ({ ...d, activeNow: isDeviceActiveNow(d, liveDeviceIds, now) }));
}

/**
 * Stamp `viewingSessions` (the pty session ids a device is streaming right
 * now) onto every roster row. List time only, never persisted. Always present
 * so the renderer can tell "watching nothing" (`[]`) from a daemon that
 * predates the field (absent); a revoked device is never watching.
 */
export function withViewingSessions<T extends ActivityInput>(
  devices: readonly T[],
  liveSessionsByDevice: ReadonlyMap<string, readonly string[]>,
): Array<T & { viewingSessions: string[] }> {
  return devices.map((d) => ({
    ...d,
    viewingSessions: d.revokedAt !== undefined ? [] : [...(liveSessionsByDevice.get(d.deviceId) ?? [])],
  }));
}
