// How Moa's transcript reads as a conversation with its operator, applied
// after the purpose calls are lifted and the result events placed, before the
// shared Chat code groups rows:
//
// - One final report per job. A turn that closed its work (a successful
//   deck_complete_work) draws ONE report card where its final reply was: the
//   reply, what Moa checked, and each finished delegation's own report. The
//   completion call and the delegations' result events of that turn are not
//   drawn again on their own.
// - Only a turn's last reply is a message. Earlier prose in the same turn is
//   Moa narrating its steps ("Proposing the hand-off…"): it folds into the
//   activity with the tool rows, as thinking does.
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';
import { isPurposeEventId, type MoaPurpose } from './MoaPurposeCard';
import { resultLinkId } from './MoaResultCard';

const REPORT_PREFIX = 'moa-report:';

export interface MoaReport {
  /** Moa's final reply of the turn (markdown), when it wrote one after closing the work. */
  reply?: string;
  /** What Moa said when it closed the work (deck_complete_work). */
  summary?: string;
  /** How Moa checked the result, in its own words. */
  verification?: string;
  /** The finished delegations this report covers (work link ids). */
  linkIds: string[];
}

export const reportIdOf = (eventId: string): string | null =>
  eventId.startsWith(REPORT_PREFIX) ? eventId : null;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A turn opens on a prompt (or a hidden wake) and closes on a recorded end. */
function turnSpans(events: readonly TurnEvent[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  events.forEach((e, i) => {
    const opens = e.kind === 'user_text' || (e.kind === 'meta' && e.subtype === 'turn_started');
    if (opens && i > start) { spans.push([start, i]); start = i; }
    const closes = (e.kind === 'assistant_text' && !e.thinking && e.turnComplete) || (e.kind === 'meta' && e.subtype === 'turn_complete');
    if (closes) { spans.push([start, i + 1]); start = i + 1; }
  });
  if (start < events.length) spans.push([start, events.length]);
  return spans;
}

const isReply = (e: TurnEvent): boolean => e.kind === 'assistant_text' && !e.thinking;

/**
 * Fold each turn that closed its work into one report row. It takes the
 * delegations that finished in that turn, or since the last report (a link
 * can finish turns before Moa closes the work). A completion that covers no
 * delegation (Moa closing a turn of small talk) is no job: its reply stays a
 * plain message and the completion is not drawn. Turns without a successful
 * completion are left as they are (a delegation that finished there still
 * draws its own report card until a report claims it).
 */
export function foldMoaReports(events: readonly TurnEvent[], purposes: ReadonlyMap<string, MoaPurpose>): { events: TurnEvent[]; reports: Map<string, MoaReport> } {
  const reports = new Map<string, MoaReport>();
  let out: TurnEvent[] = [];
  /** Result events drawn on their own so far, not yet claimed by a report. */
  let unclaimed: string[] = [];
  const isCompletion = (e: TurnEvent) => {
    if (!isPurposeEventId(e.id)) return false;
    const p = purposes.get(e.id);
    return p?.kind === 'complete' && p.ok !== false;
  };
  for (const [from, to] of turnSpans(events)) {
    const turn = events.slice(from, to);
    const last = turn.map(isCompletion).lastIndexOf(true);
    if (last < 0) {
      out.push(...turn);
      unclaimed.push(...turn.flatMap((e) => (resultLinkId(e.id) ? [e.id] : [])));
      continue;
    }
    const inTurn = turn.flatMap((e) => (resultLinkId(e.id) ? [e.id] : []));
    const claimed = [...unclaimed, ...inTurn];
    if (claimed.length === 0) { out.push(...turn.filter((e) => !isCompletion(e))); continue; }
    if (unclaimed.length) { const gone = new Set(unclaimed); out = out.filter((e) => !gone.has(e.id)); }
    unclaimed = [];
    const input = purposes.get(turn[last].id)?.input ?? {};
    let at = -1;
    for (let i = turn.length - 1; i > last; i--) if (isReply(turn[i])) { at = i; break; }
    const anchor = at >= 0 ? turn[at] : turn[last];
    const id = `${REPORT_PREFIX}${anchor.id}`;
    const summary = str(input.summary);
    const verification = str(input.verification);
    const reply = at >= 0 && anchor.kind === 'assistant_text' ? anchor.text : undefined;
    reports.set(id, {
      ...(reply ? { reply } : {}),
      ...(summary ? { summary } : {}),
      ...(verification ? { verification } : {}),
      linkIds: claimed.map((id) => resultLinkId(id) as string),
    });
    turn.forEach((e, i) => {
      if (i === (at >= 0 ? at : last)) out.push({ id, kind: 'meta', subtype: 'unknown', label: '', ...(e.ts !== undefined ? { ts: e.ts } : {}) });
      else if (!isCompletion(e) && !resultLinkId(e.id)) out.push(e);
    });
  }
  return { events: out, reports };
}

/** Every reply but the turn's last one folds into the activity as narration. */
export function foldNarration(events: readonly TurnEvent[]): TurnEvent[] {
  const out = [...events];
  for (const [from, to] of turnSpans(events)) {
    const replies: number[] = [];
    for (let i = from; i < to; i++) if (isReply(out[i])) replies.push(i);
    // A turn whose reply became a report card keeps no prose of its own.
    const keep = out.slice(from, to).some((e) => reportIdOf(e.id)) ? -1 : replies.at(-1);
    for (const i of replies) if (i !== keep) out[i] = { ...(out[i] as Extract<TurnEvent, { kind: 'assistant_text' }>), thinking: true };
  }
  return out;
}
