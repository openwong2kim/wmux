/**
 * Cache for transcript-existence probes.
 *
 * Invariant: **a transcript-existence answer is at most `ttlMs` old, and an
 * unreachable guest is never evidence of absence.**
 *
 * Why this is its own module. The host branch of a transcript liveness probe is
 * one local `lstat`, but the WSL branch spawns `wsl.exe` and blocks for up to
 * WSL_READ_TIMEOUT_MS. The daemon probes from its `listSessions` handler — a
 * per-poll stat — so N WSL panes would stall the daemon event loop N × 750 ms on
 * every poll, delaying PTY data forwarding and every other RPC. A transcript
 * appearing or being deleted is rare, so the first answer for a key is resolved
 * for real and later polls are served from cache while a refresh runs out of
 * band, keeping the call sites synchronous.
 *
 * That mechanism previously lived inline next to the probe itself with two write
 * paths whose error rules contradicted each other: the synchronous one recorded
 * every failure as "does not exist", while the asynchronous one refused to. Here
 * there is exactly one writer of an answer — `record` — and exactly one error
 * rule: an `unreachable` outcome never becomes an answer.
 *
 * Three states, not two. A key can be unknown (probe it, blocking, once), or
 * known-and-answered, or known-but-never-answered. The third state is what makes
 * "cannot probe" survivable: it records the *attempt* so repeat polls neither
 * block nor re-spawn, while recording no *answer*, so nothing can later mistake
 * it for evidence the transcript is gone.
 */

/**
 * The result of one probe attempt.
 *
 * `unreachable` means the probe could not run or could not be trusted to have
 * looked — a spawn failure, a timeout, a guest whose distro is not resolved yet.
 * It is deliberately distinct from `answered` with `lives: false`, which means a
 * probe ran and the file was not there.
 */
export type ProbeOutcome =
  | { status: 'answered'; lives: boolean }
  | { status: 'unreachable' };

/** A recorded existence answer and when it was recorded. */
export interface ProbeAnswer {
  lives: boolean;
  at: number;
}

export const DEFAULT_PROBE_TTL_MS = 30_000;
export const DEFAULT_PROBE_CACHE_MAX = 256;

/**
 * What a poll gets for a transcript that has never been answered for.
 *
 * "Cannot prove it dead" — the same rule the daemon already applies to a resume
 * binding with no transcript path at all. A WSL distro that is cold-booting
 * cannot answer within the probe timeout, and reporting absence there is what
 * dropped the exact `--resume <id>` and restarted agents without their
 * conversation. A false positive costs one `--resume` that prints "No
 * conversation found." and exits 0; a false negative costs the conversation.
 */
const ASSUME_ALIVE_WHEN_UNPROVEN = true;

interface ProbeEntry {
  /** Null until a probe has actually answered. `unreachable` never writes here. */
  answer: ProbeAnswer | null;
  /** When a probe was last attempted, answered or not. Throttles retries so an
   *  unreachable guest is not re-spawned on every poll. */
  attemptedAt: number;
  /** The in-flight out-of-band refresh, if any — single-flight per key. */
  pending: Promise<void> | null;
}

export interface TranscriptProbeCacheOptions {
  ttlMs?: number;
  max?: number;
  /** Injected so TTL behaviour is testable without mocking global time. */
  now?: () => number;
}

export interface TranscriptProbeCache {
  /**
   * Answer "does this transcript exist?" without ever blocking twice for the
   * same cache entry. `probeSync` runs once per entry — on first sight, and
   * again only if that entry is later evicted or reset away — and `probeAsync`
   * carries every refresh.
   */
  lives(
    key: string,
    probeSync: () => ProbeOutcome,
    probeAsync: () => Promise<ProbeOutcome>,
  ): boolean;
  /**
   * Settle in-flight refreshes — for one key, or all of them.
   *
   * The all-keys form drains refreshes whose entry has since been evicted or
   * reset away, which a per-entry view cannot see.
   */
  whenIdle(key?: string): Promise<void>;
  /** Read seam: the recorded answer, or null when no probe has answered yet. */
  answerFor(key: string): ProbeAnswer | null;
  reset(): void;
}

export function createTranscriptProbeCache(
  options: TranscriptProbeCacheOptions = {},
): TranscriptProbeCache {
  const ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
  const max = options.max ?? DEFAULT_PROBE_CACHE_MAX;
  // Read through to the global on every call rather than capturing `Date.now`
  // once — the reference is captured at module load, which a caller that
  // controls time later could not then influence.
  const clock = options.now ?? (() => Date.now());
  const entries = new Map<string, ProbeEntry>();
  /**
   * Every refresh still running, including ones whose entry was evicted or reset
   * away. Awaitability cannot hang off the entry alone: an eviction mid-refresh
   * would drop the promise from view while the spawn is still live.
   */
  const inFlight = new Set<Promise<void>>();

  /**
   * The only writer of `answer`.
   *
   * Both the first blocking probe and every out-of-band refresh land here, which
   * is what keeps the error rule single: an outcome that could not look is
   * recorded as an attempt and nothing else.
   */
  function record(key: string, outcome: ProbeOutcome): void {
    const entry = entries.get(key);
    if (!entry) return;
    entry.attemptedAt = clock();
    if (outcome.status !== 'answered') return;
    entry.answer = { lives: outcome.lives, at: entry.attemptedAt };
  }

  /**
   * FIFO, at insertion — the only place an entry is created, so the bound holds
   * for unanswered entries too. Map iteration is insertion-ordered and `record`
   * never re-inserts, so the first key is the oldest.
   *
   * Evicting a key whose refresh is still in flight costs one extra probe: the
   * next sighting re-inserts and probes synchronously while the orphan finishes.
   * The orphan must not then write into the replacement, which is what the
   * entry-identity check in `ensureRefresh` prevents.
   *
   * `attemptedAt` is stamped here as well as in `record` — belt and braces, so a
   * fresh entry is never one poll away from a refresh regardless of which writer
   * ran last.
   */
  function insert(key: string, outcome: ProbeOutcome): void {
    if (entries.size >= max) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    entries.set(key, { answer: null, attemptedAt: clock(), pending: null });
    record(key, outcome);
  }

  function ensureRefresh(
    key: string,
    entry: ProbeEntry,
    probeAsync: () => Promise<ProbeOutcome>,
  ): void {
    if (entry.pending) return;
    // Throttle on the attempt, not the answer: an entry that has never been
    // answered for has no answer timestamp to age, and retrying it on every poll
    // would keep waking an idle distro indefinitely.
    if (clock() - entry.attemptedAt < ttlMs) return;
    entry.attemptedAt = clock();
    const pending: Promise<void> = (async () => {
      try {
        const outcome = await probeAsync();
        // Write only into the entry this refresh was started for. A `reset`, or
        // an eviction followed by a fresh probe, replaces that object — and a
        // stale answer must not overwrite the newer one, least of all in the
        // live-to-absent direction, nor restamp it with this older attempt.
        if (entries.get(key) === entry) record(key, outcome);
      } catch {
        // A rejected probe is unreachable: keep the last known answer.
      }
    })().finally(() => {
      inFlight.delete(pending);
      const current = entries.get(key);
      if (current?.pending === pending) current.pending = null;
    });
    entry.pending = pending;
    inFlight.add(pending);
  }

  return {
    lives(key, probeSync, probeAsync) {
      const entry = entries.get(key);
      if (!entry) {
        const outcome = probeSync();
        insert(key, outcome);
        return outcome.status === 'answered' ? outcome.lives : ASSUME_ALIVE_WHEN_UNPROVEN;
      }
      if (entry.answer && clock() - entry.answer.at < ttlMs) return entry.answer.lives;
      ensureRefresh(key, entry, probeAsync);
      return entry.answer ? entry.answer.lives : ASSUME_ALIVE_WHEN_UNPROVEN;
    },
    async whenIdle(key) {
      if (key !== undefined) {
        await entries.get(key)?.pending;
        return;
      }
      await Promise.all([...inFlight]);
    },
    answerFor(key) {
      return entries.get(key)?.answer ?? null;
    },
    reset() {
      // In-flight refreshes are deliberately left tracked so they stay
      // awaitable; each one finds its entry gone and writes nothing.
      entries.clear();
    },
  };
}
