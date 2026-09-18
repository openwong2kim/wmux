// The part of "talk to the relay" that has nothing to do with what is being
// sent: a bounded queue, one retry, a timeout, and failure logging that says
// something once instead of once per attempt.
//
// Extracted from PushSender because a second sender arrived (LiveActivityPusher)
// and the alternative was a second copy of the queue discipline. That discipline
// is not incidental — the drop-oldest cap and the log-on-change rule are what
// keep a relay outage from becoming a daemon problem, and two copies of it would
// drift on the first fix.
//
// This module knows URLs, statuses and a bearer secret. It never knows what a
// body means.

/** Give up on the relay rather than hold a slot indefinitely. */
export const RELAY_TIMEOUT_MS = 5_000;

/** One retry, jittered, for a transport blip or a 5xx. Never more. */
export const RELAY_RETRY_BASE_MS = 400;
export const RELAY_RETRY_JITTER_MS = 400;

/**
 * How many sends wait when the relay is slow or down.
 *
 * Small on purpose. These are "someone is blocked on you right now" events; a
 * backlog of them is not a backlog worth delivering, it is a sign the phone
 * already missed the moment. Drop-oldest keeps the newest, which is the one
 * still worth answering.
 */
export const RELAY_QUEUE_CAP = 32;

export interface RelayTransportDeps {
  /** Relay base URL, e.g. `https://push.wmux.example`. Absent = push is off. */
  relayUrl?: string;
  /** The deployment-wide secret the relay requires. Absent = push is off. */
  relaySecret?: string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so a retry does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Log prefix, so two senders sharing this file stay tellable apart. */
  tag?: string;
  /** What one queued item is called in a log line. */
  noun?: string;
}

export class RelayTransport {
  private readonly deps: RelayTransportDeps;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tag: string;
  private readonly noun: string;
  private readonly queue: Array<() => Promise<void>> = [];
  /**
   * The in-flight drain, or null. A boolean flag was not enough: `flush()`
   * would see "already draining" and return immediately, so it awaited nothing
   * and every test that inspected the result raced the sends it was checking.
   */
  private drainPromise: Promise<void> | null = null;
  private dropped = 0;
  /** Last terminal failure status, so a steady outage logs once, not per send. */
  private lastFailureStatus: number | null | undefined = undefined;

  constructor(deps: RelayTransportDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tag = deps.tag ?? '[push]';
    this.noun = deps.noun ?? 'notification';
  }

  /**
   * Whether a send would do anything.
   *
   * `WMUX_PUSH=0` is the kill switch, and an unconfigured relay is inert rather
   * than an error — the relay is a release-track component that may simply not
   * be deployed for a given install, and a daemon must not log a failure per
   * notification because of it.
   */
  get enabled(): boolean {
    if (process.env.WMUX_PUSH === '0') return false;
    return Boolean(this.deps.relayUrl && this.deps.relaySecret);
  }

  /**
   * Queue one unit of work and return immediately — no caller of this is
   * allowed to wait on a network round trip, least of all the hook path.
   */
  enqueue(run: () => Promise<void>): void {
    if (this.queue.length >= RELAY_QUEUE_CAP) {
      this.queue.shift();
      this.dropped += 1;
      // One line per burst, not per drop: a relay outage would otherwise write
      // the log it is preventing us from delivering.
      if (this.dropped === 1 || this.dropped % 25 === 0) {
        this.deps.log?.('warn', `${this.tag} queue full, dropped ${this.dropped} ${this.noun}(s)`);
      }
    }
    this.queue.push(run);
    void this.drain();
  }

  /** Test seam: wait for the queue to empty. */
  async flush(): Promise<void> {
    await this.drain();
  }

  /** Join the in-flight drain, or start one. Never runs two at once. */
  private drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.runDrain().finally(() => {
        this.drainPromise = null;
      });
    }
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      try {
        await next();
      } catch (err) {
        // A send that throws must not wedge the queue — the next item is a
        // fresh attempt against a possibly-recovered relay.
        this.deps.log?.('warn', `${this.tag} send failed: ${errMsg(err)}`);
      }
    }
  }

  /**
   * A delivery landed. Says so only when it follows a failure, so a healthy
   * relay is silent and a recovery is one line.
   */
  noteDelivered(): void {
    if (this.lastFailureStatus === undefined) return;
    this.deps.log?.('info', `${this.tag} relay is answering again`);
    this.lastFailureStatus = undefined;
  }

  /**
   * Remember the last terminal failure, and log a distinct one only when it
   * CHANGES.
   *
   * A relay that is down fails identically for every send, and one line per
   * attempt would bury the change that matters — a 401 turning into a 200, or a
   * 500 turning into a 429.
   */
  noteFailure(subject: string, status: number | null): void {
    if (status === this.lastFailureStatus) return;
    this.lastFailureStatus = status;
    this.deps.log?.(
      'warn',
      status === null
        ? `${this.tag} no response from the relay for ${subject} (after one retry)`
        : `${this.tag} relay answered ${status} for ${subject}`,
    );
  }

  /**
   * POST once, retry once on a transport failure or a 5xx.
   *
   * Not retried: 4xx. A rejected token or a refused secret does not get better
   * by being sent again, and hammering the relay with it is the behaviour the
   * rate limit exists to stop.
   */
  async post(routePath: string, body: Record<string, unknown>): Promise<number | null> {
    const first = await this.postOnce(routePath, body);
    if (first !== null && first < 500) return first;
    await this.sleep(
      RELAY_RETRY_BASE_MS + Math.floor(jitterSeed(this.now()) * RELAY_RETRY_JITTER_MS),
    );
    return this.postOnce(routePath, body);
  }

  /** One attempt. Returns the HTTP status, or null when it never got an answer. */
  private async postOnce(
    routePath: string,
    body: Record<string, unknown>,
  ): Promise<number | null> {
    const url = `${String(this.deps.relayUrl).replace(/\/+$/, '')}${routePath}`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${String(this.deps.relaySecret)}`,
        },
        body: JSON.stringify(body),
        // A redirect off the pinned host would carry the bearer secret with it.
        redirect: 'manual',
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      return res.status;
    } catch {
      // Never log the body or the URL's query — there is none, but the habit is
      // what keeps this module's blindness claim true.
      return null;
    }
  }
}

/**
 * Jitter without `Math.random`, so a test can pin it through the injected clock
 * and a retry storm still spreads out in production.
 */
function jitterSeed(now: number): number {
  return ((now % 1000) + 1) / 1001;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
