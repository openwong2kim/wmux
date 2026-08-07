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
 * Every notification fans out to all of them at once, so the list is also the
 * concurrency of one send. Eight is well past any real setup.
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
    const events = coerceEvents(slice['events'], type, log);
    out.push({
      type: type as NotifySinkConfig['type'],
      url,
      ...(events ? { events } : {}),
    });
  }
  return out;
}

function coerceEvents(
  raw: unknown,
  type: string,
  log?: (level: 'warn', message: string) => void,
): NotifyEventKind[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const events: NotifyEventKind[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && EVENT_KINDS.includes(entry as NotifyEventKind)) {
      events.push(entry as NotifyEventKind);
      continue;
    }
    // NAMED, because the failure mode is invisible: `"aproval"` silences the
    // sink forever and looks exactly like a sink whose events never fire.
    log?.(
      'warn',
      `[notify] ${type} sink: unknown event ${JSON.stringify(entry)} — known events are ` +
        `${EVENT_KINDS.join(', ')}`,
    );
  }
  // An array that named nothing we recognise stays an EMPTY list rather than
  // becoming "all events": the operator was clearly trying to narrow, and
  // widening on a typo is the wrong direction to fail in. It is loud, though —
  // a permanently silent sink is worth a line in the log.
  if (events.length === 0) {
    log?.('warn', `[notify] ${type} sink: no recognised events — it will never fire`);
  }
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

/**
 * Same reasoning as PUSH_QUEUE_CAP: a backlog of "answer me now" is not worth
 * delivering. Applied PER EVENT KIND — see `queues`.
 */
export const NOTIFY_QUEUE_CAP = 32;

/** Give up rather than hold a slot indefinitely. */
export const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * ntfy priority levels. 5 = max (bypasses most quiet settings), 4 = high,
 * 3 = default.
 *
 * The tiers are the point: a `rm -rf` approval and a turn-completion ping
 * arriving with the same urgency trains people to ignore both.
 */
const NTFY_PRIORITY_MAX = '5';
const NTFY_PRIORITY_HIGH = '4';
const NTFY_PRIORITY_DEFAULT = '3';

/** The ntfy `Priority` header for one payload. */
function ntfyPriority(payload: NotifyPayload): string {
  if (payload.event !== 'approval') return NTFY_PRIORITY_DEFAULT;
  return payload.risk === 'critical' ? NTFY_PRIORITY_MAX : NTFY_PRIORITY_HIGH;
}

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
  /**
   * One queue PER EVENT KIND, not one shared FIFO.
   *
   * A shared queue with drop-oldest has a failure mode that defeats the whole
   * feature: `attention` fires on every turn a machine completes, so a busy
   * afternoon can push 32 turn-completions through the queue and evict the one
   * `approval` that is actually blocking an agent. Notifications are not
   * fungible, so they do not share a budget — a flood of the chatty kind can
   * only ever evict its own.
   *
   * `approval` also drains first, so a backlog of the chatty kind cannot delay
   * the kind someone is waiting on.
   */
  private readonly queues: Record<NotifyEventKind, NotifyPayload[]> = {
    approval: [],
    attention: [],
  };
  /** The in-flight drain, or null — same seam PushSender uses so `flush` waits. */
  private drainPromise: Promise<void> | null = null;
  private readonly dropped: Record<NotifyEventKind, number> = { approval: 0, attention: 0 };
  /** Last failure per sink url, so a steady outage logs once, not per send. */
  private readonly lastFailure = new Map<string, number | null>();
  /** Urls already warned about for cleartext, so the notice is once per url. */
  private readonly cleartextWarned = new Set<string>();

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
    const queue = this.queues[payload.event];
    if (queue.length >= NOTIFY_QUEUE_CAP) {
      queue.shift();
      this.dropped[payload.event] += 1;
      const n = this.dropped[payload.event];
      // One line per burst, not per drop.
      if (n === 1 || n % 25 === 0) {
        this.deps.log?.('warn', `[notify] ${payload.event} queue full, dropped ${n} notification(s)`);
      }
    }
    queue.push(payload);
    void this.drain();
  }

  /** Anything queued, in either kind? */
  private pending(): boolean {
    return this.queues.approval.length > 0 || this.queues.attention.length > 0;
  }

  /** The next payload to send — approvals first, then attention. */
  private take(): NotifyPayload | undefined {
    return this.queues.approval.shift() ?? this.queues.attention.shift();
  }

  /**
   * Test seam: wait until nothing is queued AND no drain is running.
   *
   * The loop is not belt-and-braces. A drain that finished can be restarted
   * from its own `finally` (see `drain`), so a single `await` can return while
   * a freshly restarted drain is still in flight.
   */
  async flush(): Promise<void> {
    while (this.drainPromise || this.pending()) {
      await this.drain();
    }
  }

  private drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.runDrain().finally(() => {
        this.drainPromise = null;
        // RESTART, do not just clear. `runDrain` returns synchronously when it
        // finds the queues empty, but this callback runs a microtask later —
        // and a `notify()` landing in that gap sees a non-null `drainPromise`,
        // joins the drain that is already finishing, and has its payload
        // stranded until some unrelated event happens to start another one.
        if (this.pending()) void this.drain();
      });
    }
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    for (let next = this.take(); next !== undefined; next = this.take()) {
      try {
        await this.send(next);
      } catch (err) {
        // A send that throws must not wedge the queue.
        this.deps.log?.('warn', `[notify] send failed: ${errMsg(err)}`);
      }
    }
  }

  /**
   * Fan one payload out to every matching sink CONCURRENTLY.
   *
   * Serially, one endpoint that black-holes packets costs every sink behind it
   * the full 5 s timeout — with the cap at eight sinks that is a 40 s stall on
   * a queue whose entire purpose is telling someone an agent is blocked right
   * now. `allSettled` because one dead sink must not abort delivery to the
   * healthy ones, and because a rejection here would unwind into `runDrain`'s
   * catch and get logged as if the whole notification failed.
   */
  private async send(payload: NotifyPayload): Promise<void> {
    const matching = this.deps.sinks().filter((sink) => {
      if (sink.events && !sink.events.includes(payload.event)) return false;
      // Re-checked at send time, not just at coerce time: `sinks()` re-reads
      // config, so an edit between boot and now has not been through coercion.
      return isSendableUrl(sink.url);
    });
    await Promise.allSettled(
      matching.map(async (sink) => {
        this.warnCleartextOnce(sink);
        const status = await this.postOnce(sink, payload);
        this.noteOutcome(sink, status);
      }),
    );
  }

  /**
   * Say once, per url, that an `http:` sink is not private.
   *
   * `http:` stays ALLOWED — a self-hosted ntfy on the LAN is the main reason
   * this feature exists and forcing TLS there would just mean nobody uses it.
   * But the body names which machine wants attention, and on ntfy the topic in
   * the URL is the only thing standing between a stranger and the notification
   * stream. That is worth knowing once, not suppressing.
   */
  private warnCleartextOnce(sink: NotifySinkConfig): void {
    if (this.cleartextWarned.has(sink.url)) return;
    if (!sink.url.startsWith('http://')) return;
    this.cleartextWarned.add(sink.url);
    this.deps.log?.(
      'warn',
      `[notify] the ${sink.type} sink uses http:// — notifications, and an ntfy topic name, ` +
        'travel in cleartext. Use https:// unless this stays on a trusted network.',
    );
  }

  /** One attempt. Returns the HTTP status, or null when it never got an answer. */
  private async postOnce(sink: NotifySinkConfig, payload: NotifyPayload): Promise<number | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(sink.url, {
        method: 'POST',
        ...(sink.type === 'ntfy'
          ? {
              headers: {
                'content-type': 'text/plain; charset=utf-8',
                // ntfy reads these; both are derived, never agent text.
                Title: payload.title,
                Priority: ntfyPriority(payload),
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
    } catch {
      // Never log the URL — it can carry an ntfy topic that is itself the
      // secret protecting the notification stream.
      return null;
    }
    // The status is all we want, but undici holds the connection and its
    // buffers until the body is consumed or cancelled. Reading only `res.status`
    // and dropping the response leaks a socket per notification until GC gets
    // round to it — on a long-lived daemon sending these all day, that is a
    // slow leak plus a connection pool that never recycles.
    await discardBody(res);
    return res.status;
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

/**
 * Release the response body without looking at it.
 *
 * `cancel()` is the cheap path — it tells the transport we want none of it, so
 * nothing is buffered. A body that was already consumed (or a stub response in
 * a test) has no stream, and `arrayBuffer()` covers that; both are wrapped
 * because a failure to drain is not a failure to notify, and must never turn a
 * delivered notification into a logged error.
 */
async function discardBody(res: Response): Promise<void> {
  try {
    if (res.body && !res.bodyUsed) {
      await res.body.cancel();
      return;
    }
    if (!res.bodyUsed) await res.arrayBuffer();
  } catch {
    // Nothing to do — the status was already read.
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
