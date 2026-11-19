/**
 * Set to '1' by the launcher (spawnDirect, the launchd job) when the daemon's
 * stderr is the rotated `daemon-stderr.log`. The daemon's log sink then writes
 * console output to its daily log only, not also to stderr.
 */
export const DAEMON_STDERR_TO_FILE_ENV = 'WMUX_DAEMON_STDERR_TO_FILE';
