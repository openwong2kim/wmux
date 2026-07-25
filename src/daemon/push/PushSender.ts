// The daemon's outbound half of push: seal a notification per registered
// device and hand it to the relay.
//
// Everything sensitive happened before this file runs. The payload is sealed by
// `pushEnvelope` to a key only the phone holds, so what leaves here is an opaque
// blob plus an APNs routing token — the relay is designed around not being able
// to read it, and this module must not quietly widen that.
//
// The shape of the work is "fire and forget, but honestly": a notification is
// worth a best effort and never worth blocking the daemon, so sends are queued,
// bounded, and dropped oldest-first under pressure rather than allowed to grow.
// An approval prompt that arrives late is useless anyway — the whole point is a
// human answering something that is currently blocking an agent.

import {
  PushEnvelopeError,
  encodePushEnvelopeForRelay,
  sealPushEnvelope,
  type PushPayload,
} from '../../shared/push/pushEnvelope';

/** One device that has told us where to reach it. */
export interface PushTarget {
  deviceId: string;
  name: string;
  push: { apnsToken: string; publicKey: string };
}

export interface PushSenderDeps {
  /** Relay base URL, e.g. `https://push.wmux.example`. Absent = push is off. */
  relayUrl?: string;
  /** The deployment-wide secret the relay requires. Absent = push is off. */
  relaySecret?: string;
  /** Devices that can be pushed to right now. Re-read per send — the roster moves. */
  targets: () => PushTarget[];
  /** Called when Apple says a token is dead (410), so we stop sending to it. */
  forgetPush: (deviceId: string) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so a retry does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How many notifications wait when the relay is slow or down.
 *
 * Small on purpose. These are "someone is blocked on you right now" events; a
 * backlog of them is not a backlog worth delivering, it is a sign the phone
 * already missed the moment. Drop-oldest keeps the newest, which is the one
 * still worth answering.
 */
export const PUSH_QUEUE_CAP = 32;

/** Give up on the relay rather than hold a slot indefinitely. */
export const PUSH_TIMEOUT_MS = 5_000;

/** One retry, jittered, for a transport blip or a 5xx. Never more. */
export const PUSH_RETRY_BASE_MS = 400;
export const PUSH_RETRY_JITTER_MS = 400;

/** APNs priorities the relay accepts. 10 = deliver now. */
const PRIORITY_IMMEDIATE = 10;

interface QueuedPush {
  payload: PushPayload;
  collapseId?: string;
}

export interface PushSendOutcome {
  attempted: number;
  delivered: number;
  /** Devices whose token Apple reported dead; already forgotten. */
  pruned: string[];
}

export class PushSender {
  private readonly deps: PushSenderDeps;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: QueuedPush[] = [];
  /**
   * The in-flight drain, or null. A boolean flag was not enough: `flush()`
   * would see "already draining" and return immediately, so it awaited nothing
   * and every test that inspected the result raced the sends it was checking.
   */
  private drainPromise: Promise<void> | null = null;
  private dropped = 0;

  constructor(deps: PushSenderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
   * Queue one notification for every registered device. Returns immediately —
   * no caller of this is allowed to wait on a network round trip, least of all
   * the hook path.
   */
  notify(payload: PushPayload, opts: { collapseId?: string } = {}): void {
    if (!this.enabled) return;
    if (this.queue.length >= PUSH_QUEUE_CAP) {
      this.queue.shift();
      this.dropped += 1;
      // One line per burst, not per drop: a relay outage would otherwise write
      // the log it is preventing us from delivering.
      if (this.dropped === 1 || this.dropped % 25 === 0) {
        this.deps.log?.('warn', `[push] queue full, dropped ${this.dropped} notification(s)`);
      }
    }
    this.queue.push({ payload, ...(opts.collapseId ? { collapseId: opts.collapseId } : {}) });
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
        await this.send(next);
      } catch (err) {
        // A send that throws must not wedge the queue — the next notification
        // is a fresh attempt against a possibly-recovered relay.
        this.deps.log?.('warn', `[push] send failed: ${errMsg(err)}`);
      }
    }
  }

  private async send(item: QueuedPush): Promise<PushSendOutcome> {
    const outcome: PushSendOutcome = { attempted: 0, delivered: 0, pruned: [] };
    const targets = this.deps.targets();
    const ts = this.now();

    for (const target of targets) {
      outcome.attempted += 1;
      let blob: string;
      try {
        blob = encodePushEnvelopeForRelay(
          sealPushEnvelope({
            devicePublicKey: Buffer.from(target.push.publicKey, 'base64'),
            deviceId: target.deviceId,
            payload: item.payload,
            ts,
          }),
        );
      } catch (err) {
        // A key we cannot seal to is a registration problem, not a transport
        // one. Say which device, never what we were trying to send.
        const code = err instanceof PushEnvelopeError ? err.code : 'unknown';
        this.deps.log?.('warn', `[push] could not seal for ${target.deviceId} (${code})`);
        continue;
      }

      const status = await this.postWithOneRetry({
        apnsDeviceToken: target.push.apnsToken,
        ciphertext: blob,
        priority: PRIORITY_IMMEDIATE,
        ...(item.collapseId ? { collapseId: item.collapseId } : {}),
      });

      if (status === 200) {
        outcome.delivered += 1;
      } else if (status === 410) {
        // Apple's word that this token is gone. Continuing to send to it is
        // exactly the traffic that gets a provider throttled.
        this.deps.forgetPush(target.deviceId);
        outcome.pruned.push(target.deviceId);
      }
    }
    return outcome;
  }

  /**
   * POST once, retry once on a transport failure or a 5xx.
   *
   * Not retried: 4xx. A rejected token or a refused secret does not get better
   * by being sent again, and hammering the relay with it is the behaviour the
   * rate limit exists to stop.
   */
  private async postWithOneRetry(body: Record<string, unknown>): Promise<number | null> {
    const first = await this.postOnce(body);
    if (first !== null && first < 500) return first;
    await this.sleep(PUSH_RETRY_BASE_MS + Math.floor(jitterSeed(this.now()) * PUSH_RETRY_JITTER_MS));
    return this.postOnce(body);
  }

  /** One attempt. Returns the HTTP status, or null when it never got an answer. */
  private async postOnce(body: Record<string, unknown>): Promise<number | null> {
    const url = `${String(this.deps.relayUrl).replace(/\/+$/, '')}/push`;
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
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
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
