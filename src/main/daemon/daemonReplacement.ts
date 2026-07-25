// B′ — session-preserving stale-daemon auto-replacement.
//
// Design: plans/daemon-auto-replace-plan-2026-07-05.md (v1.1, 3-model panel
// reviewed). The orchestration deliberately reuses the shipped machinery for
// everything destructive-adjacent: `daemon.shutdown` (the daemon's own
// suspend-everything RPC), the launcher's verified-kill guards, and the
// respawn controller's budget loop. What lives here is only the decision
// logic (is the daemon positively older?) and the step sequencing with its
// failure policy — both pure enough to unit-test without a live daemon
// (`tryEscalatedReping` precedent: every effect is injected).
//
// Failure policy, one line: destructive escalation (SIGKILL) only after the
// shutdown ack, only against the PID captured at ack time, and only when the
// image+cmdline verification is DEFINITIVE. Every pre-ack failure falls back
// to "reuse the old daemon" (today's behavior); every post-ack failure falls
// back to the respawn-budget machinery — never to installing a dead client.

import type { ProcessLiveness } from '../../shared/processLiveness';

// Must stay BELOW the daemon's own 10s shutdown hard-timeout
// (daemon/index.ts shutdown() guard). If this budget exceeded 10s, the
// "timeout" branch would always mean "the daemon already exit(1)ed" — and
// reusing that client would install a dead socket the health probe never
// escalates on (it early-returns when !isConnected), permanently wedging the
// app in a fake-connected state (Codex #3 + Claude #1). At 8s a timed-out
// daemon is guaranteed still alive (hung mid-shutdown), so the reuse branch
// is sound: when it self-destructs at 10s, the by-then-installed disconnect
// listener hands off to the normal respawn machinery.
export const REPLACEMENT_SHUTDOWN_BUDGET_MS = 8_000;

export const REPLACEMENT_DEATH_POLL_INTERVAL_MS = 250;
// Normal post-ack exit is ~1.05s (50ms ack flush + 1s force-exit timer);
// 5s covers a hung pipe stop with margin.
export const REPLACEMENT_DEATH_POLL_BUDGET_MS = 5_000;
// After death is confirmed, give Windows a beat to release the named-pipe
// handle before the fresh daemon's first listen — symmetric with the settle
// the launcher's own kill path performs (launcher.ts SIGKILL branch).
export const REPLACEMENT_PIPE_SETTLE_MS = 200;

/** Shape of the daemon.ping additives the gate reads (see launcher.DaemonPingResult). */
export interface DaemonVersionPong {
  spawnedByVersion?: unknown;
  channelsEpoch?: unknown;
}

export interface StalenessVerdict {
  older: boolean;
  /** Human-readable decision trail — logged either way. */
  reason: string;
  /** True for keep-decisions worth surfacing at warn level (newer daemon /
   *  unparseable version / sentinel), where the C1 banner cannot fire
   *  because it is epoch-driven — the log is the only trace. */
  warnOnKeep?: boolean;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

function parseVersion(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] !== undefined,
  };
}

function compareCore(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Decide whether the reused daemon is POSITIVELY older than this app.
 *
 * The asymmetry between the first two rows is deliberate (Claude #4): a ping
 * that omits `spawnedByVersion` entirely can only come from pre-B′ daemon
 * code (it passed token auth, so it IS a wmux daemon; B′ daemons always echo
 * something — sentinel 'unknown' when their spawn env was bare). Absence is
 * therefore a positive confirmation of old code, while the sentinel is an
 * absence of information — and destruction requires positive confirmation,
 * mirroring the launcher's unknown≠dead liveness principle.
 */
export function isDaemonOlder(
  pong: DaemonVersionPong | null | undefined,
  appVersion: string,
  currentChannelsEpoch: number,
): StalenessVerdict {
  const raw = pong?.spawnedByVersion;
  if (raw === undefined || raw === null) {
    return { older: true, reason: 'ping has no spawnedByVersion — pre-B′ daemon (positively old)' };
  }
  if (typeof raw !== 'string') {
    return { older: false, warnOnKeep: true, reason: `spawnedByVersion has unexpected type ${typeof raw} — keeping (no positive-old confirmation)` };
  }
  if (raw === 'unknown') {
    return { older: false, warnOnKeep: true, reason: 'spawnedByVersion sentinel "unknown" — B′ daemon with unclear spawn path; keeping' };
  }
  const daemonV = parseVersion(raw);
  const appV = parseVersion(appVersion);
  if (!daemonV || !appV) {
    return { older: false, warnOnKeep: true, reason: `unparseable version (daemon="${raw}", app="${appVersion}") — keeping` };
  }
  const cmp = compareCore(daemonV, appV);
  if (cmp < 0) {
    return { older: true, reason: `daemon ${raw} < app ${appVersion}` };
  }
  if (cmp > 0) {
    return { older: false, warnOnKeep: true, reason: `daemon ${raw} is NEWER than app ${appVersion} — downgrade replacement forbidden; keeping` };
  }
  // Same core. A prerelease daemon under a release app is older (3.16.0-x < 3.16.0).
  if (daemonV.prerelease && !appV.prerelease) {
    return { older: true, reason: `daemon ${raw} is a prerelease of app core ${appVersion}` };
  }
  // Secondary signal, channels schema only (dev-window bumps within one
  // version). Absent / non-numeric epoch takes NO branch here — explicit
  // keep (Claude #11: `undefined < n` is a silent NaN-false; make it a rule).
  const epoch = pong?.channelsEpoch;
  if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch < currentChannelsEpoch) {
    return { older: true, reason: `channelsEpoch ${epoch} < ${currentChannelsEpoch} (same version core ${raw})` };
  }
  return { older: false, reason: `daemon ${raw} is current (app ${appVersion}, epoch ok)` };
}

export type ReplacementOutcome =
  /** Pre-ack failure with the old daemon still connected — caller keeps and
   *  installs the EXISTING client (today's behavior; C1 banner guides). */
  | 'reuse-old-daemon'
  /** Old daemon confirmed dead + pipe settle done — caller may spawn fresh. */
  | 'old-daemon-dead'
  /** Post-shutdown failure (no ack + dead client, kill refused, or still
   *  alive). Caller must NOT install any client and must route into the
   *  respawn-budget machinery. */
  | 'dead-end'
  /** dispose() fired mid-sequence (before-quit race) — caller returns null
   *  quietly and must not spawn. */
  | 'cancelled';

/** Outcome of the daemon.shutdown race as the orchestrator consumes it.
 *  `stateSaved` mirrors the daemon's additive ack field: false means the
 *  suspended-state save failed and recovery degrades to the 30s periodic
 *  snapshots; undefined means a pre-B′ daemon that doesn't report it. */
export interface ShutdownRpcResult {
  acked: boolean;
  stateSaved?: boolean;
}

export interface ReplacementDeps {
  /** Old daemon PID captured from ensureDaemon BEFORE the shutdown — never
   *  re-read from daemon.pid (another instance may have rewritten it). */
  oldPid: number;
  /** Send daemon.shutdown with the given timeout. */
  shutdownRpc: (timeoutMs: number) => Promise<ShutdownRpcResult>;
  /** Live connection state of the client the shutdown was sent on. */
  isClientConnected: () => boolean;
  disconnectClient: () => Promise<void>;
  checkLiveness: (pid: number) => ProcessLiveness;
  /**
   * Issue #545 — probe-independent evidence that the old daemon finished
   * shutting down: its control pipe no longer accepts connections. Wired to a
   * short connect against the daemon pipe that is destroyed the instant it
   * succeeds, so the probe itself can never hold a dying server open. A connect
   * that SUCCEEDS or times out must report false (fail-closed); only an
   * authoritative "nothing is listening" (ENOENT / ECONNREFUSED) is true.
   */
  isPipeGone: () => Promise<boolean>;
  /** Verified SIGKILL against an explicit pid (definitiveOnly mode). */
  killVerifiedPid: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  isCancelled: () => boolean;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Issue #545 — has the old daemon finished shutting down?
 *
 * `tasklist` is the only death signal today, and by deliberate design
 * (`processLiveness`, Defect-1 / split-brain) a probe that fails or times out
 * returns `unknown`, NEVER `dead`. On a box where tasklist is slow or
 * AV-blocked, EVERY poll returns `unknown`, so a daemon that acked cleanly and
 * exited 10 ms later still burns the full 5 s budget, then fails the
 * `definitiveOnly` kill (its image lookup is null for the same reason), and the
 * whole replacement dead-ends. That matches the reported "dead=false after
 * graceful poll 5s, every run" far better than an actually-lingering process
 * does — measured post-ack exit is 7-12 ms (node and Electron, 10 and 35
 * sessions).
 *
 * So accept a second, independent proof:
 *
 *   liveness === 'dead'                       ─► confirmed (authoritative)
 *   liveness === 'unknown' && acked && pipeGone ─► confirmed (shutdown completed)
 *   anything else                             ─► not confirmed (keep polling)
 *
 * Two preconditions, both load-bearing:
 *
 *  - `acked`: without an ack we never learned the daemon committed to dying, so
 *    a pipe that merely looks gone must not authorize spawning over it.
 *  - `liveness !== 'alive'`: a process the probe POSITIVELY sees running has not
 *    finished exiting, whatever its pipe says — it is mid-shutdown. Only
 *    `unknown` (we learned nothing) gets rescued by the pipe signal. Spawning a
 *    second daemon next to a confirmed-live one is the split-brain hazard this
 *    whole file exists to prevent, and the existing SIGKILL escalation already
 *    covers a daemon that genuinely lingers.
 *
 * NAMING: this proves "shutdown() ran to completion", not "the process left the
 * process table" — `pipeServer.stop()` happens before the exit. That is still
 * exactly what the caller needs, because by then `releaseLock()` has run and
 * `disposeAll()` has killed the PTYs, so the lock and the pipe name are free
 * for a fresh daemon. Named for what it proves so it is never reused as a
 * liveness oracle.
 */
export function confirmShutdownComplete(input: {
  liveness: ProcessLiveness;
  acked: boolean;
  pipeGone: boolean;
}): boolean {
  if (input.liveness === 'dead') return true;
  if (input.liveness === 'alive') return false;
  return input.acked && input.pipeGone;
}

/**
 * Steps 1–3 of the replacement sequence (plan §5): graceful shutdown →
 * death confirmation → escalation/abort. Spawning the fresh daemon stays in
 * the controller (it owns ensureDaemon/createClient and the disposed flag).
 */
export async function runDaemonReplacement(deps: ReplacementDeps): Promise<ReplacementOutcome> {
  // Step 1 — graceful shutdown, budgeted BELOW the daemon's hard timeout.
  let acked = false;
  let stateSaved: boolean | undefined;
  try {
    const r = await deps.shutdownRpc(REPLACEMENT_SHUTDOWN_BUDGET_MS);
    acked = r.acked;
    stateSaved = r.stateSaved;
  } catch {
    acked = false;
  }
  if (acked && stateSaved === false) {
    // Plan §5 step-1: the ack still means "the daemon finished trying", but
    // the suspended records did not land — recovery will be snapshot-grade.
    deps.log('warn', `[replace] old daemon (pid=${deps.oldPid}) acked shutdown but reported stateSaved=false — recovery degrades to periodic snapshots`);
  }

  if (!acked) {
    if (deps.isCancelled()) {
      // before-quit disposed the controller during the shutdown race
      // (Codex code-review #1a). Do not hand the old client back for
      // install — quit teardown owns the daemon from here (the before-quit
      // pid-file kill covers the full-shutdown case).
      deps.log('warn', '[replace] cancelled during shutdown race (app quitting) — not reusing, not spawning');
      return 'cancelled';
    }
    if (deps.isClientConnected()) {
      // Genuine refusal or slow-walk by a still-alive daemon. Reuse it —
      // pre-ack means nothing was suspended, so this is lossless. If it was
      // actually hung and self-destructs at its 10s timer, the disconnect
      // listener wired during install hands off to the respawn machinery.
      deps.log('warn', `[replace] old daemon (pid=${deps.oldPid}) did not ack shutdown within ${REPLACEMENT_SHUTDOWN_BUDGET_MS}ms and is still connected — aborting pre-ack, reusing old daemon`);
      return 'reuse-old-daemon';
    }
    // Socket dropped without an ack: the daemon died mid-shutdown
    // (crash-grade — e.g. its 10s hard timeout). Its persistence is
    // unconfirmed, so SIGKILL escalation stays OFF; recovery degrades to
    // the 30s periodic snapshots, same as any daemon crash today.
    deps.log('warn', `[replace] old daemon (pid=${deps.oldPid}) dropped the connection without acking shutdown — treating as crash-grade death, escalation disabled`);
  }

  // Step 2 — release our socket so it cannot hold the dying server open.
  try {
    await deps.disconnectClient();
  } catch { /* best-effort */ }

  // Step 3 — confirm process death against the CAPTURED pid.
  const attempts = Math.max(1, Math.ceil(REPLACEMENT_DEATH_POLL_BUDGET_MS / REPLACEMENT_DEATH_POLL_INTERVAL_MS));
  // #545 — two independent signals, either of which confirms. `isPipeGone` is
  // best-effort: a probe that throws must read as "not gone" (fail-closed), so
  // a broken probe can only ever cost us the old 5 s wait, never a bad spawn.
  const pipeGone = async (): Promise<boolean> => {
    try {
      return await deps.isPipeGone();
    } catch {
      return false;
    }
  };
  const confirm = async (): Promise<boolean> =>
    confirmShutdownComplete({
      liveness: deps.checkLiveness(deps.oldPid),
      acked,
      pipeGone: await pipeGone(),
    });
  let dead = await confirm();
  for (let i = 0; i < attempts && !dead; i++) {
    await deps.sleep(REPLACEMENT_DEATH_POLL_INTERVAL_MS);
    dead = await confirm();
  }

  if (!dead) {
    if (!acked) {
      // No ack AND the process won't die — nothing here is safe to force.
      deps.log('error', `[replace] old daemon (pid=${deps.oldPid}) neither acked nor died within budget — dead-end`);
      return 'dead-end';
    }
    // Ack received: the daemon is on its own self-destruct path (1s
    // force-exit), so a verified SIGKILL merely accelerates what it already
    // committed to — it cannot change data outcomes. definitiveOnly means
    // an indeterminate image/cmdline lookup refuses rather than kills
    // (Claude #6: after ~5s of polling, "we just talked to this PID" no
    // longer rules out reuse).
    const killed = deps.killVerifiedPid(deps.oldPid);
    if (killed) {
      for (let i = 0; i < 4 && !dead; i++) {
        await deps.sleep(REPLACEMENT_DEATH_POLL_INTERVAL_MS);
        dead = await confirm();
      }
    }
    if (!dead) {
      deps.log('error', `[replace] old daemon (pid=${deps.oldPid}) lingered past ack and ${killed ? 'survived verified SIGKILL' : 'could not be definitively verified for SIGKILL'} — dead-end`);
      return 'dead-end';
    }
  }

  // Windows named-pipe handle settle (symmetric with the launcher kill path).
  await deps.sleep(REPLACEMENT_PIPE_SETTLE_MS);

  if (deps.isCancelled()) {
    // before-quit disposed the controller while we were confirming death.
    // The old daemon has already suspended durably; do not spawn during
    // teardown (Codex #6 + Claude #3).
    deps.log('warn', '[replace] cancelled after old-daemon death (app quitting) — not spawning');
    return 'cancelled';
  }
  return 'old-daemon-dead';
}
