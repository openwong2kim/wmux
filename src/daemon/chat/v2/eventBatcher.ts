import type { HarnessEvent, StampedHarnessEvent } from '../../../shared/chatv2/harnessEvents';
import {
  CHATV2_BATCH_MS,
  CHATV2_MAX_EVENT_BYTES,
  CHATV2_MAX_EVENTS_PER_PUSH,
  CHATV2_MAX_PUSH_BYTES,
  truncateUtf8,
  utf8Bytes,
} from '../../../shared/chatv2/limits';

/** Room a push keeps for its envelope and a whole binding. */
const PUSH_ENVELOPE_BYTES = 8 * 1024;
/** Events of one push, serialized. */
export const CHATV2_PUSH_EVENTS_BUDGET = CHATV2_MAX_PUSH_BYTES - PUSH_ENVELOPE_BYTES;

/** Events a client must see at once: decisions, errors, turn and session edges. */
export function isUrgentEvent(event: HarnessEvent): boolean {
  switch (event.type) {
    case 'approval.requested':
    case 'approval.resolved':
    case 'question.asked':
    case 'question.updated':
    case 'question.resolved':
    case 'session.error':
    case 'session.started':
    case 'session.ended':
    case 'session.providerBound':
    case 'user.message':
    case 'turn.ended':
    case 'usage.limited':
      return true;
    default:
      return false;
  }
}

/**
 * Coalesces one record's stamped events into pushes: deltas wait up to
 * CHATV2_BATCH_MS, urgent events flush at once, and a push never exceeds
 * CHATV2_MAX_EVENTS_PER_PUSH events or the push byte budget. The host calls
 * `admit` BEFORE it folds an event, so every flushed push ends exactly at the
 * fold state the host reports with it.
 */
export class EventBatcher {
  private events: StampedHarnessEvent[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flushTo: (events: StampedHarnessEvent[]) => void, private readonly windowMs = CHATV2_BATCH_MS) {}

  get empty(): boolean {
    return this.events.length === 0;
  }

  /** Flush what is queued when an event of `bytes` would not fit the same push. */
  admit(bytes: number): void {
    if (this.events.length === 0) return;
    if (this.events.length + 1 > CHATV2_MAX_EVENTS_PER_PUSH || this.bytes + bytes > CHATV2_PUSH_EVENTS_BUDGET) this.flush();
  }

  push(stamped: StampedHarnessEvent, bytes: number): void {
    this.events.push(stamped);
    this.bytes += bytes;
    if (isUrgentEvent(stamped.event)) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.events.length === 0) return;
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    this.flushTo(events);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.events = [];
    this.bytes = 0;
  }
}

/**
 * Longest stream delta text a single event carries; longer deltas are split.
 * Not a divisor of CHATV2_BLOCK_TEXT_BYTES, so pieces of one delta never land
 * a block exactly on its cap.
 */
const DELTA_PIECE_BYTES = 15 * 1024;

/**
 * An event as the host stamps it: stream deltas split into pieces, and every
 * other event's long agent-authored fields cut so one stamped event stays
 * near CHATV2_MAX_EVENT_BYTES. The text cuts are larger than the fold's own
 * caps. The daemon's capped fold and every renderer fold the same bounded
 * event, so they agree; only the uncapped shadow fold (for `bodies`) gets the
 * full event.
 */
export function boundEvent(event: HarnessEvent): HarnessEvent[] {
  if (event.type === 'message.delta' || event.type === 'reasoning.delta') {
    return splitText(event.text).map((text) => ({ ...event, text }));
  }
  if (utf8Bytes(JSON.stringify(event)) <= CHATV2_MAX_EVENT_BYTES) return [event];
  const cut = (text: string | undefined, max: number): string | undefined =>
    text === undefined ? undefined : truncateUtf8(text, max);
  switch (event.type) {
    case 'tool.started':
    case 'tool.updated':
    case 'agent.step':
    case 'approval.requested': {
      const bounded = { ...event } as Record<string, unknown>;
      if (typeof bounded.title === 'string') bounded.title = cut(bounded.title, 1024);
      if (typeof bounded.text === 'string') bounded.text = cut(bounded.text, 8 * 1024);
      if (typeof bounded.detail === 'string') bounded.detail = cut(bounded.detail, 12 * 1024);
      const preview = bounded.preview as Record<string, unknown> | undefined;
      if (preview) {
        bounded.preview = {
          ...preview,
          ...(typeof preview.output === 'string' ? { output: cut(preview.output, 8 * 1024) } : {}),
          ...(Array.isArray(preview.lines)
            ? { lines: (preview.lines as Array<{ text: string }>).slice(0, 200).map((line) => ({ ...line, text: truncateUtf8(line.text, 512) })) }
            : {}),
        };
      }
      return [bounded as HarnessEvent];
    }
    case 'plan':
    case 'status':
    case 'interjection':
      return [{ ...event, text: truncateUtf8(event.text, 16 * 1024) }];
    case 'session.error':
      return [{ ...event, message: truncateUtf8(event.message, 4 * 1024) }];
    default:
      return [event];
  }
}

/** The pieces of a stream delta, each within DELTA_PIECE_BYTES. */
function splitText(text: string): string[] {
  if (utf8Bytes(text) <= DELTA_PIECE_BYTES) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest) {
    const piece = truncateUtf8(rest, DELTA_PIECE_BYTES) || rest.slice(0, 1);
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  return pieces;
}
