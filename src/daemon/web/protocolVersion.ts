import { ENV_KEYS } from '../../shared/constants';

/**
 * The phone API's own version, independent of the daemon's release version.
 *
 * Why a second number at all: once a native client ships, the HTTP surface is
 * pinned to binaries the daemon cannot update. The release version moves for
 * reasons a phone does not care about (a renderer fix, a CLI flag), so keying
 * client compatibility on it would strand phones on every unrelated release.
 * This number moves only when the wire contract does.
 *
 * BUMP `PHONE_PROTOCOL_VERSION` when the phone-facing HTTP surface changes in a
 * way a client can observe: a route removed or renamed, a field removed or
 * given a new meaning, a status code repurposed. Do NOT bump it for additive
 * changes — a new optional field or a new route is invisible to a client that
 * does not read it, and every additive change so far has been shipped that way
 * on purpose (see `tier`, `allowUpload`).
 *
 * BUMP `MIN_PHONE_PROTOCOL_VERSION` only when the server genuinely can no
 * longer serve an older client — that is, when support for the old shape is
 * actually deleted, not merely deprecated. It is a hard cutoff: every client
 * below it is told to update and can do nothing else, so raising it strands
 * whoever has not opened the App Store. Keep it lagging as far behind
 * `PHONE_PROTOCOL_VERSION` as the code allows.
 */
export const PHONE_PROTOCOL_VERSION = 1;

/** Oldest client protocol this server still accepts. See the note above. */
export const MIN_PHONE_PROTOCOL_VERSION = 1;

/**
 * The release the daemon was spawned from, for display and bug reports only.
 *
 * Deliberately the SAME source the B′ stale-daemon auto-replacement reads
 * (`daemon.ping.spawnedByVersion`): the launcher injects it unconditionally, so
 * two accessors reading two sources would eventually disagree about which
 * daemon is running — and the copy that drifts would be the one an operator is
 * shown in a bug report. Reading `package.json` here would also be wrong from a
 * bundled daemon, which has no package.json beside it.
 *
 * The 'unknown' sentinel carries the same meaning it does there: B′-or-later
 * code whose spawn path is unclear. Never compare it as a version — clients gate
 * on the protocol numbers above, never on this string.
 */
export function daemonServerVersion(): string {
  return process.env[ENV_KEYS.SPAWNED_BY_VERSION] || 'unknown';
}
