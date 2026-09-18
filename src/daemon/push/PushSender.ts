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
//
// The queue, the one retry, the timeout and the log-on-change rule all live in
// `RelayTransport`, which a second sender (LiveActivityPusher) shares. What is
// left here is the part that is about NOTIFICATIONS: sealing per device, and
// what a 410 means for a push registration.

import {
  PushEnvelopeError,
  encodePushEnvelopeForRelay,
  sealPushEnvelope,
  type PushPayload,
} from '../../shared/push/pushEnvelope';
import {
  RELAY_QUEUE_CAP,
  RELAY_RETRY_BASE_MS,
  RELAY_RETRY_JITTER_MS,
  RELAY_TIMEOUT_MS,
  RelayTransport,
} from './RelayTransport';

/** One device that has told us where to reach it. */
export interface PushTarget {
  deviceId: string;
  name: string;
  push: {
    apnsToken: string;
    publicKey: string;
    /**
     * Which Apple host this token belongs to, as the device reported at
     * registration. Forwarded verbatim; absent stays absent, and the relay then
     * uses whatever it was configured with. See `DevicePushRegistration`.
     */
    apnsEnvironment?: 'development' | 'production';
  };
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

/** Re-exported under their original names: these are this module's contract. */
export const PUSH_QUEUE_CAP = RELAY_QUEUE_CAP;
export const PUSH_TIMEOUT_MS = RELAY_TIMEOUT_MS;
export const PUSH_RETRY_BASE_MS = RELAY_RETRY_BASE_MS;
export const PUSH_RETRY_JITTER_MS = RELAY_RETRY_JITTER_MS;

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
  /** Neither delivered nor pruned — a relay or transport problem. */
  failed: number;
  /** The last terminal status seen, or null when the relay never answered. */
  lastStatus: number | null;
}

export class PushSender {
  private readonly deps: PushSenderDeps;
  private readonly now: () => number;
  private readonly transport: RelayTransport;

  constructor(deps: PushSenderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.transport = new RelayTransport({
      ...(deps.relayUrl !== undefined ? { relayUrl: deps.relayUrl } : {}),
      ...(deps.relaySecret !== undefined ? { relaySecret: deps.relaySecret } : {}),
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      tag: '[push]',
      noun: 'notification',
    });
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
    return this.transport.enabled;
  }

  /**
   * Queue one notification for every registered device. Returns immediately —
   * no caller of this is allowed to wait on a network round trip, least of all
   * the hook path.
   */
  notify(payload: PushPayload, opts: { collapseId?: string } = {}): void {
    if (!this.enabled) return;
    const item: QueuedPush = {
      payload,
      ...(opts.collapseId ? { collapseId: opts.collapseId } : {}),
    };
    this.transport.enqueue(() => this.send(item).then(() => undefined));
  }

  /** Test seam: wait for the queue to empty. */
  async flush(): Promise<void> {
    await this.transport.flush();
  }

  private async send(item: QueuedPush): Promise<PushSendOutcome> {
    const outcome: PushSendOutcome = {
      attempted: 0,
      delivered: 0,
      pruned: [],
      failed: 0,
      lastStatus: null,
    };
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

      const status = await this.transport.post('/push', {
        apnsDeviceToken: target.push.apnsToken,
        ciphertext: blob,
        priority: PRIORITY_IMMEDIATE,
        ...(item.collapseId ? { collapseId: item.collapseId } : {}),
        // Per device, so two builds of this app on one tailnet stop routing
        // each other's tokens to the wrong Apple host. Omitted when the device
        // could not name its own stage — the relay must not have one guessed
        // for it here either.
        ...(target.push.apnsEnvironment
          ? { apnsEnvironment: target.push.apnsEnvironment }
          : {}),
      });

      if (status === 200) {
        outcome.delivered += 1;
        this.transport.noteDelivered();
      } else if (status === 410) {
        // Apple's word that this token is gone. Continuing to send to it is
        // exactly the traffic that gets a provider throttled.
        this.deps.forgetPush(target.deviceId);
        outcome.pruned.push(target.deviceId);
      } else {
        // EVERY other terminal outcome is reported. Handling only 200 and 410
        // left a misconfigured relay secret, a persistent 5xx, or a network
        // failure that survived the retry completely silent — the only symptom
        // would be a user noticing notifications that never arrive, which is
        // the least debuggable signal there is. The status is a number from the
        // relay; the payload is never mentioned.
        outcome.failed += 1;
        outcome.lastStatus = status;
        this.transport.noteFailure(target.deviceId, status);
      }
    }
    if (outcome.failed > 0) {
      this.deps.log?.(
        'warn',
        `[push] ${outcome.failed}/${outcome.attempted} notification(s) were not delivered` +
          `${outcome.lastStatus === null ? ' (no response)' : ` (last status ${outcome.lastStatus})`}`,
      );
    }
    return outcome;
  }
}
