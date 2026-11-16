/**
 * The refusal the daemon gives an app-only call (see `isAppOnlyDaemonMethod`)
 * from a connection that has not identified as the app
 * (DaemonPipeServer.dispatch). DaemonClient identifies again and retries once
 * when a call fails with it.
 */
export const NOT_FIRST_PARTY = 'not_first_party';

/**
 * The pane delivery lock's RPCs (daemon/paneDeliveryLock.ts): only main's
 * gated delivery holds a pane's lock and writes under it.
 */
export const PANE_DELIVERY_LOCK_METHODS: ReadonlySet<string> = new Set([
  'daemon.session.deliveryLockV1',
  'daemon.session.deliveryUnlockV1',
  'daemon.session.writeHeldV1',
]);

/**
 * Changing a paired device's grant (`wmux web`'s roster): only the app's
 * Remote page and Paired devices dialog do it, through main.
 */
export const DEVICE_GRANT_METHODS: ReadonlySet<string> = new Set([
  'daemon.web.deviceSetInput',
]);

/**
 * Daemon methods the daemon answers only on the app's own connection: A2A
 * tasks, channels, principals and remote links, fan-out task missions and the
 * pane delivery lock, which act for whichever workspace or pane the call
 * names, and a device's grant. The exceptions are listed in DaemonPipeServer:
 * the channel calls a pane's own tools make, and the pairing calls of
 * `wmux remote` on a host the app does not use.
 */
export function isAppOnlyDaemonMethod(method: string): boolean {
  return (
    method.startsWith('a2a.') ||
    method.startsWith('task.mission.') ||
    PANE_DELIVERY_LOCK_METHODS.has(method) ||
    DEVICE_GRANT_METHODS.has(method)
  );
}

