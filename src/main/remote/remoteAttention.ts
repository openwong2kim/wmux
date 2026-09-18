// Pure derivation: a remote host's `/api/events` attention frames -> desktop
// notifications.
//
// Split out of the transport (RemoteAttentionSubscriber) so the rule that
// decides WHAT the desktop shows — and, more importantly, what it must NOT
// show — is testable without a socket.
//
// The wire shapes come from WebTerminalServer: a `reset` frame
// (`{epoch, headId}`) followed by the replay window, then live events under
// the kind names `critical` / `notify` / `approval`, each carrying
// `{...payload, tier, id, epoch}`. The phone frontend renders the same events
// (frontend/attentionFormat.js); the headline/subline rules here mirror it.
//
// `agent.liveness` is deliberately NOT consumed: the daemon only delivers it
// to principals that registered as transcript watchers by reading a pane's
// turn view, which is a per-pane phone affordance rather than a fleet signal.

import type { NotificationCategory, NotificationType } from '../../shared/types';

/** The recorded attention kinds the daemon publishes (WebTerminalServer). */
export type RemoteAttentionKind = 'critical' | 'notify' | 'approval';

/** What a fired transition asks the desktop to show. */
export interface RemoteAttentionNotification {
  /** Remote session (pane) id the event came from — for logging/dedup only. */
  sessionId: string;
  title: string;
  body: string;
  type: NotificationType;
  category: NotificationCategory;
}

/** How many `epoch:id` keys the dedup set remembers. Matches the frontend. */
const SEEN_CAP = 200;

/**
 * Caps for remote-supplied text. The strings here are written by whatever is
 * running in a remote pane, so they are attacker-shaped input to an OS toast:
 * a megabyte of text or an embedded newline run breaks the banner's rendering,
 * and a title containing the label separator would forge the "which host is
 * this from" prefix. Same reflex as RemoteHostClient, which already truncates
 * every remote-supplied string it surfaces.
 */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 240;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Collapse control characters (newlines included) and cap the length. */
function clean(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return str(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/**
 * Headline + subline for one attention event, mirroring
 * `frontend/attentionFormat.js` so the desktop and the phone say the same
 * thing about the same event.
 */
export function formatRemoteAttention(
  kind: RemoteAttentionKind,
  data: Record<string, unknown>,
): { title: string; body: string; type: NotificationType; category: NotificationCategory } | null {
  if (kind === 'critical') {
    return {
      title: 'Approval needed',
      body: clean(data.action, MAX_BODY_CHARS) || 'A pane is waiting on you.',
      type: 'warning',
      category: 'approval',
    };
  }
  if (kind === 'approval') {
    // Only the ASK is a notification. The daemon republishes every lifecycle
    // transition of an approval (resolved / expired / superseded) on the same
    // kind, marked `tier: 'info'` — banner-ing those would notify the user
    // about a question that is already answered.
    if (data.tier !== 'act') return null;
    const tool = clean(data.toolName, MAX_TITLE_CHARS);
    const summary = clean(data.toolInputSummary, MAX_BODY_CHARS);
    const detail = tool && summary ? `${tool}: ${summary}` : tool || summary;
    return {
      title: 'Approval needed',
      body: detail || 'An agent is waiting for your decision.',
      type: 'warning',
      category: 'approval',
    };
  }
  // `notify` — the pane's own notification (OSC 9/777/99, and the agent
  // completion notices that ride the same path). Same category as the local
  // twin in DaemonNotificationRouter's `session:notification` handler, so one
  // category mute covers local and remote alike.
  const title = clean(data.title, MAX_TITLE_CHARS);
  const body = clean(data.body, MAX_BODY_CHARS);
  if (!title && !body) return null;
  return {
    // Body-only (OSC 9 carries no title) means the body IS the headline.
    title: title || body,
    body: title ? body : '',
    type: 'info',
    category: 'terminal',
  };
}

/**
 * Per-connection replay gate + cross-connection dedup.
 *
 * The subscriber deliberately connects with NO cursor (no `Last-Event-ID`, no
 * `?since=`), so the daemon always answers with a `reset` frame naming its
 * head id followed by the whole replay window. Everything at or below that
 * head id is, by definition, state that existed BEFORE this connection — the
 * initial snapshot — and is suppressed. That makes a reconnect behave exactly
 * like a first connect: no burst of banners for events the user has already
 * seen in the roster, on every drop, forever.
 *
 * The cost, accepted on purpose: an event raised while the desktop was
 * disconnected is not banner-ed when the stream comes back. A desktop sitting
 * next to its roster is not a phone in a tunnel; a storm on every tailnet blip
 * is the worse failure.
 */
export class RemoteAttentionGate {
  /**
   * Highest id that belongs to the replayed backlog of the CURRENT stream.
   * Starts at "everything", and only a `reset` frame naming a usable head id
   * lowers it: fail CLOSED, so a frame arriving before the boundary is known
   * — or a peer whose reset we could not read — costs a missed banner rather
   * than the whole replay window fired as live events.
   */
  private replayUntilId = Number.MAX_SAFE_INTEGER;
  /** Only the FIRST reset of a stream moves the boundary. A later one (from a
   *  confused or hostile peer) could otherwise raise it and silently swallow
   *  every live event from then on. */
  private boundarySet = false;

  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  /** Called on every (re)connect, before any frame of that stream. */
  beginStream(): void {
    this.replayUntilId = Number.MAX_SAFE_INTEGER;
    this.boundarySet = false;
  }

  /**
   * Feed one decoded SSE frame. Returns the notification to fire, or null when
   * the frame is backlog, a duplicate, an unknown event name, or malformed.
   */
  consume(event: string, data: string): RemoteAttentionNotification | null {
    if (event === 'reset') {
      if (this.boundarySet) return null;
      this.boundarySet = true;
      const parsed = safeParse(data);
      const headId = parsed && typeof parsed.headId === 'number' ? parsed.headId : null;
      // No usable head id: the backlog's end is unknowable on this stream, so
      // stay closed for its whole life. The next reconnect gets another reset.
      if (headId !== null && headId >= 0) this.replayUntilId = headId;
      return null;
    }
    if (event !== 'critical' && event !== 'notify' && event !== 'approval') return null;
    const parsed = safeParse(data);
    if (!parsed) return null;
    const sessionId = str(parsed.sessionId);
    if (!sessionId) return null;

    // An event with no numeric id and no epoch can be neither placed against
    // the replay boundary nor deduped against the pane-stream tee of itself.
    // Firing it would defeat both gates at once, so it is dropped.
    const id = typeof parsed.id === 'number' ? parsed.id : null;
    const epoch = str(parsed.epoch);
    if (id === null || !epoch) return null;
    if (id <= this.replayUntilId) return null; // replayed backlog
    const key = `${epoch}:${id}`;
    if (this.seen.has(key)) return null;
    this.markSeen(key);

    const formatted = formatRemoteAttention(event, parsed);
    if (!formatted) return null;
    return { sessionId, ...formatted };
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > SEEN_CAP) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

function safeParse(data: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
