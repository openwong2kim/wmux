// The daemon's phone-less notification path: POST a small plaintext JSON body
// to an operator-configured URL, or a one-line message to an ntfy topic.
//
// A sibling of `PushSender`, not a generalisation of it. The two share a shape
// — fire and forget, bounded queue, drop oldest — and share nothing else: push
// seals its payload to a device key and speaks the relay's protocol, while this
// one hands readable text to a server the operator picked. Merging them would
// mean one module holding both "the payload is opaque to the transport" and
// "the payload is the transport's message body", and the first of those is a
// security claim worth keeping unqualified.
//
// This adds NO listening surface. The daemon's loopback-only default is
// untouched; everything here is outbound.

import {
  notifyMessageText,
  type NotifyEventKind,
  type NotifyPayload,
} from './notifyPayload';

/** Where one notification goes, and which events reach it. */
export interface NotifySinkConfig {
  /**
   * `webhook` — POST the payload as JSON.
   * `ntfy`    — POST the message text as the body, metadata in headers.
   */
  type: 'webhook' | 'ntfy';
  /** Absolute http(s) URL. For ntfy this is the topic URL. */
  url: string;
  /** Which events to send. Absent = all of them. */
  events?: NotifyEventKind[];
}

const SINK_TYPES: readonly NotifySinkConfig['type'][] = ['webhook', 'ntfy'];
const EVENT_KINDS: readonly NotifyEventKind[] = ['approval', 'attention'];

/**
 * How many sinks one config may name.
 *
 * Every notification fans out to all of them serially, so an unbounded list is
 * an unbounded stall on a slow endpoint. Eight is well past any real setup.
 */
export const NOTIFY_SINKS_MAX = 8;

/**
 * Per-field coercion for the `notifySinks` slice, in the convention the
 * `lanlink` / `browser` / `gate` slices already follow: `validateConfig` never
 * inspects this key, so a malformed entry degrades HERE and cannot trigger the
 * whole-file reset that would take `pipeName` with it.
 *
 * Degrades to "off", not to a default: a notification the operator did not
 * configure would be an outbound connection they did not ask for. A garbage
 * entry is dropped individually; its siblings survive.
 */
export function coerceNotifySinks(
  raw: unknown,
  log?: (level: 'warn', message: string) => void,
): NotifySinkConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: NotifySinkConfig[] = [];
  for (const entry of raw) {
    if (out.length >= NOTIFY_SINKS_MAX) {
      log?.('warn', `[notify] more than ${NOTIFY_SINKS_MAX} sinks configured — ignoring the rest`);
      break;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const slice = entry as Record<string, unknown>;
    const type = slice['type'];
    const url = slice['url'];
    if (typeof type !== 'string' || !SINK_TYPES.includes(type as NotifySinkConfig['type'])) continue;
    if (typeof url !== 'string' || !isSendableUrl(url)) {
      // Named, because a silently ignored sink looks exactly like a sink that
      // is working and whose notifications are being lost.
      log?.('warn', `[notify] ignoring a ${type} sink: the url must be an absolute http(s) URL`);
      continue;
    }
    const events = coerceEvents(slice['events']);
    out.push({
      type: type as NotifySinkConfig['type'],
      url,
      ...(events ? { events } : {}),
    });
  }
  return out;
}

function coerceEvents(raw: unknown): NotifyEventKind[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const events = raw.filter(
    (e): e is NotifyEventKind => typeof e === 'string' && EVENT_KINDS.includes(e as NotifyEventKind),
  );
  // An array that named nothing we recognise stays an EMPTY list rather than
  // becoming "all events": the operator was clearly trying to narrow, and
  // widening on a typo is the wrong direction to fail in.
  return events;
}

/**
 * The only URL rule.
 *
 * The destination is operator-configured, so this is not the untrusted-input
 * problem the navigation SSRF guard solves — a private-range host is a normal
 * answer here (a self-hosted ntfy on the LAN is the common case) and blocking
 * it would break the feature for the people most likely to use it. What is
 * never legitimate is a non-http(s) scheme: `file:`, `data:` and friends are
 * not destinations, they are ways to make `fetch` do something other than send
 * a notification.
 */
export function isSendableUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** Same reasoning as PUSH_QUEUE_CAP: a backlog of "answer me now" is not worth delivering. */
export const NOTIFY_QUEUE_CAP = 32;

/** Give up rather than hold a slot indefinitely. */
export const NOTIFY_TIMEOUT_MS = 5_000;

/** ntfy priority levels. 4 = high (buzzes through), 3 = default. */
const NTFY_PRIORITY_HIGH = '4';
const NTFY_PRIORITY_DEFAULT = '3';

export interface WebhookSinkDeps {
  /** Re-read per notification, so a config edit takes effect without a restart. */
  sinks: () => NotifySinkConfig[];
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class WebhookSink {
  private readonly deps: WebhookSinkDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: NotifyPayload[] = [];
  /** The in-flight drain, or null — same seam PushSender uses so `flush` waits. */
  private drainPromise: Promise<void> | null = null;
  private dropped = 0;
  /** Last failure per sink url, so a steady outage logs once, not per send. */
  private readonly lastFailure = new Map<string, number | null>();

  constructor(deps: WebhookSinkDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Whether a send would do anything. No sinks configured is the normal state
   * and is inert, never an error. `WMUX_NOTIFY_SINKS=0` is the kill switch.
   */
  get enabled(): boolean {
    if (process.env.WMUX_NOTIFY_SINKS === '0') return false;
    return this.deps.sinks().length > 0;
  }

  /**
   * Queue one notification. Returns immediately — the hook path and the
   * approval registry both call this and neither may wait on a network round
   * trip.
   */
  notify(payload: NotifyPayload): void {
    if (!this.enabled) return;
    if (this.queue.length >= NOTIFY_QUEUE_CAP) {
      this.queue.shift();
      this.dropped += 1;
      // One line per burst, not per drop.
      if (this.dropped === 1 || this.dropped % 25 === 0) {
        this.deps.log?.('warn', `[notify] queue full, dropped ${this.dropped} notification(s)`);
      }
    }
    this.queue.push(payload);
    void this.drain();
  }

  /** Test seam: wait for the queue to empty. */
  async flush(): Promise<void> {
    await this.drain();
  }

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
        // A send that throws must not wedge the queue.
        this.deps.log?.('warn', `[notify] send failed: ${errMsg(err)}`);
      }
    }
  }

  private async send(payload: NotifyPayload): Promise<void> {
    for (const sink of this.deps.sinks()) {
      if (sink.events && !sink.events.includes(payload.event)) continue;
      // Re-checked at send time, not just at coerce time: `sinks()` re-reads
      // config, so an edit between boot and now has not been through coercion.
      if (!isSendableUrl(sink.url)) continue;
      const status = await this.postOnce(sink, payload);
      this.noteOutcome(sink, status);
    }
  }

  /** One attempt. Returns the HTTP status, or null when it never got an answer. */
  private async postOnce(sink: NotifySinkConfig, payload: NotifyPayload): Promise<number | null> {
    try {
      const res = await this.fetchImpl(sink.url, {
        method: 'POST',
        ...(sink.type === 'ntfy'
          ? {
              headers: {
                'content-type': 'text/plain; charset=utf-8',
                // ntfy reads these; both are derived, never agent text.
                Title: payload.title,
                Priority: payload.event === 'approval' ? NTFY_PRIORITY_HIGH : NTFY_PRIORITY_DEFAULT,
              },
              body: notifyMessageText(payload),
            }
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
        // A redirect can move the destination off the host the operator named.
        redirect: 'manual',
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      return res.status;
    } catch {
      // Never log the URL — it can carry an ntfy topic that is itself the
      // secret protecting the notification stream.
      return null;
    }
  }

  /**
   * Log a terminal failure only when it CHANGES for that sink, and log the
   * recovery once. A dead endpoint fails identically every time; one line per
   * notification would bury the transition that matters.
   */
  private noteOutcome(sink: NotifySinkConfig, status: number | null): void {
    const ok = status !== null && status >= 200 && status < 300;
    const previous = this.lastFailure.get(sink.url);
    if (ok) {
      if (previous !== undefined) {
        this.lastFailure.delete(sink.url);
        this.deps.log?.('info', `[notify] ${sink.type} sink is answering again`);
      }
      return;
    }
    if (previous === status) return;
    this.lastFailure.set(sink.url, status);
    this.deps.log?.(
      'warn',
      status === null
        ? `[notify] no response from the ${sink.type} sink`
        : `[notify] the ${sink.type} sink answered ${status}`,
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
