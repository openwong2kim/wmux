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

/** What a writer asks of the holds: whether the pane is held, and to record a paste it left there. */
export interface UnsentPasteGate {
  held(sessionId: string): boolean;
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
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: UnsentPasteHoldDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /**
   * A paste left unsent in the pane, recorded right after the writer's last
   * write: the daemon counts each write in the tick it is made, so the key
   * count read now includes every one of them. False: no session.
   */
  record(sessionId: string, writer: string): boolean {
    const keys = this.deps.keyRevision(sessionId);
    if (keys === undefined) return false;
    this.records.set(sessionId, { at: this.now(), keys, pid: this.deps.agentPid(sessionId), writer, refused: new Set() });
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
