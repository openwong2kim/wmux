/**
 * #3393 — panes whose input box got a delivery's paste that was not submitted
 * (left there), recorded by whichever writer left it: the daemon's own writers
 * (scheduled prompts, automation runs, caller nudges, continues, the channel
 * wake worker, chat sends) and main's gated deliveries
 * (`daemon.session.unsentPasteV1`). While a pane is held, no writer types
 * there: a screen read alone cannot tell the paste is still in the box, as one
 * taken while the agent redraws can miss it.
 *
 * The pane is clear again once
 * - a turn starts after the record (the agent's prompt-submit hook: someone
 *   submitted the box);
 * - input reaches the pane after the record (its key count past the one
 *   taken right after the writer's last write: a person's key, or any other
 *   writer's);
 * - the agent's process exits, or a launch edge names a different process
 *   than the one recorded (a new agent's composer is a new one);
 * - the session ends.
 * A turn's end does not clear it: a turn already running when the paste was
 * left ends with the paste still in the box. No screen read clears it either.
 */

import { shownOf, type DeliveryCheck, type DeliveryPresence } from '../shared/deliveryPresence';

/** What a writer asks of the holds: whether the pane is held, and to record a paste it left there. */
export interface UnsentPasteGate {
  held(sessionId: string): boolean;
  /** Right after each write the writer makes (the daemon counts it in the same tick). */
  wrote(sessionId: string): void;
  record(sessionId: string, writer: string): void;
}

/** A chat send refused while the pane is held: how the person clears it. */
export const UNSENT_PASTE_CHAT_DETAIL =
  "the agent's input box still holds an earlier message wmux pasted and did not submit: press Enter on the waiting text, or Ctrl+U to clear it";

export interface UnsentPasteRecord {
  /** When the paste was left. */
  at: number;
  /** The pane's key count right after the writer's last write. */
  keys: number;
  /** The agent process at the time, when the tracker knew it. */
  pid: number | undefined;
  /** Who left it, for the log. */
  writer: string;
  /** Writers already told the pane is held, so each logs its refusal once. */
  refused: Set<string>;
}

export interface UnsentPasteHoldDeps {
  /** The pane's key count (DaemonPTYBridge.getKeyInputRevision); undefined: no session. */
  keyRevision(sessionId: string): number | undefined;
  /** When the pane's latest prompt-submit hook landed; undefined: none. */
  promptSubmittedAt(sessionId: string): number | undefined;
  /** The pane's attributed agent process; undefined: not known. */
  agentPid(sessionId: string): number | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

export class UnsentPasteHolds {
  private readonly records = new Map<string, UnsentPasteRecord>();
  /** The pane's key count and time right after the lock holder's latest write: what a record is taken from. */
  private readonly lastWrite = new Map<string, { at: number; keys: number }>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: UnsentPasteHoldDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * A write by the pane's lock holder: the key count and time right after it, read in the tick the daemon counted it.
   * A record taken later starts from here, so a key or a submitted prompt between that write and the record clears it.
   */
  wrote(sessionId: string): void {
    const keys = this.deps.keyRevision(sessionId);
    if (keys !== undefined) this.lastWrite.set(sessionId, { at: this.now(), keys });
  }

  /**
   * A paste left unsent in the pane, as of the writer's last write (`wrote`), or now when none was noted. False: no
   * session.
   */
  record(sessionId: string, writer: string): boolean {
    const now = this.deps.keyRevision(sessionId);
    const last = this.lastWrite.get(sessionId);
    this.lastWrite.delete(sessionId);
    if (now === undefined) return false;
    const { at, keys } = last ?? { at: this.now(), keys: now };
    this.records.set(sessionId, { at, keys, pid: this.deps.agentPid(sessionId), writer, refused: new Set() });
    this.log(`[unsent-paste] session=${sessionId} held: ${writer} left a paste unsubmitted`);
    return true;
  }

  /** Whether the pane still holds a paste left unsent; a record that is clear now is dropped. */
  held(sessionId: string): boolean {
    const record = this.records.get(sessionId);
    if (!record) return false;
    const why = this.clearedBy(sessionId, record);
    if (!why) return true;
    this.drop(sessionId, why);
    return false;
  }

  /** As `held`, for `writer`'s delivery: its first refusal while this record stands is logged (busy, reason unsent-paste). */
  heldFor(sessionId: string, writer: string): boolean {
    if (!this.held(sessionId)) return false;
    const record = this.records.get(sessionId);
    if (record && !record.refused.has(writer)) {
      record.refused.add(writer);
      this.log(`[unsent-paste] session=${sessionId} ${writer}: busy (unsent-paste), left by ${record.writer}`);
    }
    return true;
  }

  /** The tracker's edge for the pane: a death, or a launch whose process differs from the recorded one, clears it. */
  agentState(sessionId: string, alive: boolean): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    if (!alive) {
      this.drop(sessionId, 'its agent exited');
      return;
    }
    const pid = this.deps.agentPid(sessionId);
    if (record.pid !== undefined && pid !== undefined && pid !== record.pid) this.drop(sessionId, 'a new agent process started');
  }

  /** The session ended. */
  sessionEnded(sessionId: string): void {
    this.lastWrite.delete(sessionId);
    this.drop(sessionId, 'the session ended');
  }

  private clearedBy(sessionId: string, record: UnsentPasteRecord): string | null {
    const keys = this.deps.keyRevision(sessionId);
    if (keys === undefined) return 'the session ended';
    const turnAt = this.deps.promptSubmittedAt(sessionId);
    if (turnAt !== undefined && turnAt > record.at) return 'a turn started';
    if (keys > record.keys) return 'input reached the pane';
    return null;
  }

  private drop(sessionId: string, why: string): void {
    if (this.records.delete(sessionId)) this.log(`[unsent-paste] session=${sessionId} clear: ${why}`);
  }
}

/** A writer's write edge: its paste, then its Enter (`queued`: the agent's composer queued it behind a turn). */
export type HeldWriteEdge = (stage: 'paste' | 'submit', queued?: boolean) => void;

export interface HeldDeliveryOptions<R extends string> {
  holds: UnsentPasteHolds | null;
  sessionId: string;
  /** Who writes, for the log and the busy reason. */
  writer: string;
  /** The text pasted: what the take-back's own-text check looks for. */
  text: string;
  /** The writer's delivery, reporting its write edges to `onWrite`. */
  deliver: (onWrite: HeldWriteEdge) => Promise<R>;
  /** The caller's write edges. Its paste is reported only once it is not taken back (see deliverUnderHold). */
  onWrite?: HeldWriteEdge;
  /** daemon.deliveryPresence for the pane at the given check. */
  presence: (check: DeliveryCheck) => Promise<DeliveryPresence>;
  /** Ctrl+U into the pane, counted like any write; false: no session. */
  eraseLine: () => boolean;
  log: (line: string) => void;
}

/**
 * A daemon writer's delivery under the pane's lock (the caller holds it): refused (busy, reason unsent-paste) while
 * the pane holds an earlier unsubmitted paste. A paste it leaves unsubmitted is taken back with Ctrl+U while the box
 * shows exactly its own text (the channel wake nudge's rule): then nothing of it is left, no hold is recorded, and the
 * answer is `busy` (reason taken-back), which every caller retries. Otherwise (someone typed, the box cannot be read)
 * nothing is erased and the pane is held. A delivery that throws after its paste is treated the same way.
 *
 * The caller hears of the paste only once it stays: before the Enter, or when it is left in the box. A paste taken
 * back was never reported, so no caller takes it for text that may sit in the composer.
 */
export async function deliverUnderHold<R extends string>(opts: HeldDeliveryOptions<R>): Promise<R | 'busy'> {
  const { holds, sessionId, writer } = opts;
  if (holds?.heldFor(sessionId, writer)) return 'busy';
  let pasted = false;
  let reported = false;
  const reportPaste = (): void => {
    if (pasted && !reported) {
      reported = true;
      opts.onWrite?.('paste');
    }
  };
  let result: R | undefined;
  let takenBack = false;
  try {
    result = await opts.deliver((stage, queued) => {
      if (stage === 'paste') {
        pasted = true;
        return;
      }
      reportPaste();
      opts.onWrite?.(stage, queued);
    });
  } finally {
    if (result !== 'sent' && pasted) takenBack = await leftUnsent(opts);
    if (!takenBack) reportPaste();
  }
  return takenBack ? 'busy' : result;
}

/** True when the paste was taken back; false when it is left in the box and the pane is held. */
async function leftUnsent<R extends string>(opts: HeldDeliveryOptions<R>): Promise<boolean> {
  const { holds, sessionId, writer } = opts;
  const shown = await opts.presence({ phase: 'enter', ...shownOf(opts.text) }).catch(() => null);
  if (shown?.pasteShown === true && opts.eraseLine()) {
    opts.log(`[unsent-paste] session=${sessionId} ${writer}: its paste was not submitted and was taken back (Ctrl+U); not held; busy (taken-back), retried`);
    return true;
  }
  opts.log(`[unsent-paste] session=${sessionId} ${writer}: its paste was not submitted and the box does not show it as its own; not erased, held`);
  holds?.record(sessionId, writer);
  return false;
}
