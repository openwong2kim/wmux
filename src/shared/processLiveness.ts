// Three-state process-liveness classification, shared by the main-side daemon
// launcher (checkProcessLiveness) and the daemon itself (acquireLock). Kept PURE
// (no fs / child_process / electron) so both bundles import the exact same
// contract — the daemon runs as a bare Node process and must not pull in
// launcher.ts (which imports electron) — and so vitest can pin it directly.
//
// A probe FAILURE (timeout / exec error) is `unknown`, NEVER `dead`. Reading a
// flaky probe as "process absent" was Defect-1 of the duplicate-daemon /
// split-brain chain: a second daemon whose `tasklist` stalled under load read a
// LIVE daemon's lock as stale, removed it, and spawned over it → session-pipe
// EADDRINUSE → terminal reset. Only positive confirmation of death may authorize
// a destructive / spawn-over branch.

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Classify a Windows `tasklist` probe result. `stdout === null` means the probe
 * itself failed (timeout under Defender realtime scan, CPU/WMI pressure, exec
 * error) — that is `unknown`, NOT `dead`. Only an authoritative listing (exec
 * succeeded) with the PID absent is `dead`.
 */
export function classifyTasklistOutput(pid: number, stdout: string | null): ProcessLiveness {
  if (stdout === null) return 'unknown';
  return stdout.includes(`"${pid}"`) ? 'alive' : 'dead';
}

/**
 * Classify a POSIX `process.kill(pid, 0)` outcome. No error → the signal reached
 * a live process (`alive`). `ESRCH` → authoritative "no such process" (`dead`).
 * `EPERM` → the process exists but we may not signal it (`alive`). Anything else
 * → `unknown`.
 */
export function classifyKillOutcome(code: string | undefined): ProcessLiveness {
  if (code === undefined) return 'alive';
  if (code === 'ESRCH') return 'dead';
  if (code === 'EPERM') return 'alive';
  return 'unknown';
}

/**
 * A daemon lock file is reclaimable ONLY when its owner PID is positively
 * confirmed dead. `alive` (owner running) and `unknown` (a flaky probe) both
 * mean "assume a live daemon holds it — do NOT remove the lock and spawn over
 * it." This is the daemon-side counterpart of the launcher's "treat unknown as
 * alive, do not spawn" rule (Defect-1 of the split-brain chain).
 */
export function lockOwnerIsReclaimable(liveness: ProcessLiveness): boolean {
  return liveness === 'dead';
}
