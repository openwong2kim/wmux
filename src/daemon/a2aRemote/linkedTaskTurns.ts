import { localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import { parseGatedSubmitProof } from '../../shared/ptyMessageDelivery';
import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import { parseTranscriptLine } from '../transcript/parseEntry';
import { readTranscriptDelta, readTranscriptPage, TAIL_BYTES } from '../transcript/readTail';
import { HEADLESS_DELIVERY_TICK_MS } from './headlessDelivery';
import { isPromptEntry, stepTaskTurn, type TaskTurn } from './taskTurn';

/**
 * The turn each remote task started in a linked pane, read from that pane's
 * agent transcript (Claude Code). A task is followed while it is open, inbound,
 * delivered, and its delivery recorded what main submitted (`submit` on its
 * marker, RemoteA2aBridge → the daemon's mark): the session written to and the
 * hash of the text typed. The turn is tracked with stepTaskTurn (taskTurn.ts).
 *
 * Read only: `taskTurn` answers what was seen, and nothing here acts on it.
 * The transcript is read at most once per HEADLESS_DELIVERY_TICK_MS, a closed
 * turn is not read any further, and a task is forgotten once it ends or its
 * record goes.
 */
export interface LinkedTaskTurnsDeps {
  /** Every remote task (A2aTaskService.listRemote). */
  tasks(): Task[];
  /** The agent's transcript file, once the daemon has bound the session to its conversation; null before. */
  transcriptPath(sessionId: string): string | null;
  log?(level: 'warn', msg: string): void;
}

/** What was seen of a task's turn; `unknown` while the task is not followed or its transcript not read yet. */
export type LinkedTaskTurn = { opened: boolean; closed: boolean; toolUseIds: string[] } | 'unknown';

interface Followed {
  /** The submit this follows: a new one starts over. */
  key: string;
  sessionId: string;
  turn: TaskTurn;
  /** The transcript `offset` counts in; null until its first read. */
  path: string | null;
  offset: number;
}

type Line = { line: string; events: TurnEvent[] };

export class LinkedTaskTurns {
  private readonly followed = new Map<string, Followed>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: LinkedTaskTurnsDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), HEADLESS_DELIVERY_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.followed.clear();
  }

  /** What was seen of `taskId`'s turn so far. Reads nothing. */
  taskTurn(taskId: string): LinkedTaskTurn {
    const f = this.followed.get(taskId);
    if (!f || f.path === null) return 'unknown';
    return { opened: f.turn.opened, closed: f.turn.closed, toolUseIds: [...f.turn.toolUseIds] };
  }

  /** One pass: the tasks to follow now, each read on from where it was. */
  tick(): void {
    try {
      const open = new Set<string>();
      for (const task of this.deps.tasks()) {
        const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
        if (marker?.direction !== 'inbound' || marker.delivered !== true) continue;
        if ((TERMINAL_STATES as readonly string[]).includes(task.status.state)) continue;
        const submit = parseGatedSubmitProof(marker.submit);
        // Only a proof for the pane's current occupant.
        if (!submit || task.metadata[localSideOf(task)].ptyId !== submit.ptyId) continue;
        open.add(task.id);
        const key = `${submit.ptyId}\0${submit.incarnation}\0${submit.submitRevision}\0${submit.promptHash}`;
        let f = this.followed.get(task.id);
        if (!f || f.key !== key) {
          f = { key, sessionId: submit.ptyId, turn: { promptHash: submit.promptHash, opened: false, closed: false, toolUseIds: [] }, path: null, offset: 0 };
          this.followed.set(task.id, f);
        }
        this.follow(f);
      }
      for (const taskId of [...this.followed.keys()]) if (!open.has(taskId)) this.followed.delete(taskId);
    } catch (err) {
      this.deps.log?.('warn', `[a2a-remote] linked task turns: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private follow(f: Followed): void {
    if (f.turn.closed) return;
    const path = this.deps.transcriptPath(f.sessionId);
    if (!path) return;
    if (f.path !== null && f.path !== path) {
      // Another conversation in the pane: the turn cannot be followed into it. Not opened yet: looked for there.
      if (f.turn.opened) {
        f.turn.closed = true;
        return;
      }
      f.path = null;
    }
    if (f.path === null) {
      this.locate(f, path);
      return;
    }
    const lines: Line[] = [];
    const delta = readTranscriptDelta(path, f.offset, undefined, capture(lines));
    if (!delta) return;
    // Cut or replaced: what follows is not where the turn was.
    if (delta.reset) {
      f.turn.closed = true;
      return;
    }
    f.offset = delta.cursor.tailOffset;
    this.step(f, lines);
  }

  /**
   * The first read: the prompt may already be in the file when the mark lands.
   * The last page is searched for its own user entry only (earlier entries are
   * the pane's history, not input that took the turn) and read on from there;
   * not found, the file is read on from its end.
   */
  private locate(f: Followed, path: string): void {
    const lines: Line[] = [];
    const page = readTranscriptPage(path, { maxBytes: TAIL_BYTES, parseLine: capture(lines) });
    if (!page) return;
    f.path = path;
    f.offset = page.cursor.tailOffset;
    let from = -1;
    for (let i = lines.length - 1; i >= 0 && from < 0; i--) if (isPromptEntry(lines[i].line, f.turn.promptHash)) from = i;
    if (from >= 0) this.step(f, lines.slice(from));
  }

  private step(f: Followed, lines: Line[]): void {
    for (const { line, events } of lines) {
      stepTaskTurn(f.turn, line, events);
      if (f.turn.closed) return;
    }
  }
}

/** A line parser for readTail that also keeps each raw line, in file order. */
function capture(into: Line[]): typeof parseTranscriptLine {
  return (line, offset) => {
    const events = parseTranscriptLine(line, offset);
    into.push({ line, events });
    return events;
  };
}
