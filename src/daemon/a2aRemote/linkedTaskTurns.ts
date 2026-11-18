import { localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import { parseGatedSubmitProof, type GatedSubmitProof } from '../../shared/ptyMessageDelivery';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import { parseTranscriptLine } from '../transcript/parseEntry';
import { isLineBoundary, readTranscriptDelta, statTranscript } from '../transcript/readTail';
import { HEADLESS_DELIVERY_TICK_MS } from './headlessDelivery';
import { isPromptEntry, stepTaskTurn, type TaskTurn } from './taskTurn';

/**
 * The turn each delivery of a remote task started in a linked pane, read from
 * that pane's agent transcript (Claude Code). A delivered unit (the task
 * itself, or one inbox item of it: a follow-up) is followed while its task is
 * open and inbound and its delivery recorded what main submitted (`submit`,
 * RemoteA2aBridge → the daemon's mark): the session written to, its
 * incarnation and key epoch, the hash of the text typed, and the transcript's
 * size at the Enter (the floor: the prompt's own entry can only come after it).
 * The turn is tracked with stepTaskTurn (taskTurn.ts).
 *
 * The rule throughout: never take a turn for the task's when it may not be.
 * A unit is closed, and not read further, when its session is gone or is no
 * longer the incarnation, key epoch or agent (Claude Code) the proof names,
 * when the pane's occupant is another pty, when the transcript moves to
 * another file or is cut or replaced, or when the prompt is seen more than
 * once past the floor while the unit is read (then it is not opened at all).
 * Without a floor the unit starts at the end of the file as first seen, so
 * only an entry written after that counts. A prompt not seen within
 * LINKED_TURN_SEEK_MAX_MS gives up (`unknown`).
 *
 * Read only: `taskTurn` answers what was seen, and nothing here acts on it.
 * The timer runs only while some unit is still read (`wake` starts it again,
 * e.g. when a mark with a proof lands); each transcript is read once per tick
 * for all its units, and a line is parsed only from the prompt's entry on.
 */
export interface LinkedTaskTurnsDeps {
  /** Every remote task (A2aTaskService.listRemote). */
  tasks(): Task[];
  /** The agent's transcript file, once the daemon has bound the session to its conversation; null before. */
  transcriptPath(sessionId: string): string | null;
  /** The live session: its incarnation, key epoch and agent (slug); null when it is gone. */
  session(sessionId: string): { incarnationId: string | null; keyEpoch: string; agent: string | null } | null;
  log?(level: 'warn', msg: string): void;
  now?: () => number;
}

/** A prompt not seen this long after its unit was first followed: given up on. */
export const LINKED_TURN_SEEK_MAX_MS = 10 * 60 * 1000;

/** What was seen of a task's latest followed delivery (`messageId`: an inbox item's); `unknown` when nothing can be said. */
export type LinkedTaskTurn = { messageId?: string; opened: boolean; closed: boolean; toolUseIds: string[] } | 'unknown';

interface Unit {
  taskId: string;
  messageId?: string;
  /** Listed order within its task: the task itself first, then its inbox items (see deliveredAfter). */
  order: number;
  /** The proof this follows: another one starts over. */
  key: string;
  proof: GatedSubmitProof;
  turn: TaskTurn;
  /** The transcript `offset` counts in, and its inode; null until first read. */
  path: string | null;
  ino: number;
  offset: number;
  firstSeenAt: number;
  /** Gave up before the prompt was seen. */
  expired: boolean;
}

type Line = { line: string; start: number };

export class LinkedTaskTurns {
  /** By `taskId` + NUL + `messageId` ('' for the task itself). */
  private readonly units = new Map<string, Unit>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: LinkedTaskTurnsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One pass now; the timer then runs only while a unit is still read. */
  start(): void {
    this.wake();
  }

  /** Something may have a proof to follow now (a delivered mark carried one). */
  wake(): void {
    this.tick();
  }

  stop(): void {
    this.pause();
    this.units.clear();
  }

  /** What was seen of the latest followed delivery of `taskId`. Reads nothing. */
  taskTurn(taskId: string): LinkedTaskTurn {
    let latest: Unit | undefined;
    for (const u of this.units.values()) if (u.taskId === taskId && (!latest || deliveredAfter(u, latest))) latest = u;
    if (!latest || latest.path === null || latest.expired) return 'unknown';
    return {
      ...(latest.messageId !== undefined ? { messageId: latest.messageId } : {}),
      opened: latest.turn.opened,
      closed: latest.turn.closed,
      toolUseIds: [...latest.turn.toolUseIds],
    };
  }

  /** One pass: the units to follow now, each transcript read once for all of its units. */
  tick(): void {
    const now = this.now();
    const live = new Set<string>();
    const byPath = new Map<string, Unit[]>();
    let tasks: Task[] = [];
    try {
      tasks = this.deps.tasks();
    } catch (err) {
      this.warn('the task list', err);
    }
    for (const task of tasks) {
      try {
        for (const found of unitsOf(task)) {
          live.add(found.id);
          let u = this.units.get(found.id);
          if (!u || u.key !== found.key) {
            u = {
              taskId: task.id, ...(found.messageId !== undefined ? { messageId: found.messageId } : {}), order: found.order,
              key: found.key, proof: found.proof, turn: { promptHash: found.proof.promptHash, opened: false, closed: false, toolUseIds: [] },
              path: null, ino: 0, offset: 0, firstSeenAt: now, expired: false,
            };
            this.units.set(found.id, u);
          }
          const path = this.pathToRead(u, now);
          if (path) byPath.set(path, [...(byPath.get(path) ?? []), u]);
        }
      } catch (err) {
        this.warn(`task ${task.id}`, err);
      }
    }
    for (const id of [...this.units.keys()]) if (!live.has(id)) this.units.delete(id);
    for (const [path, units] of byPath) {
      try {
        this.read(path, units);
      } catch (err) {
        for (const u of units) u.turn.closed = true;
        this.warn('a transcript', err);
      }
    }
    if ([...this.units.values()].some((u) => !u.turn.closed)) this.resume();
    else this.pause();
  }

  /** The transcript to read for `u` now, or null (closed here when it can no longer be followed). */
  private pathToRead(u: Unit, now: number): string | null {
    if (u.turn.closed) return null;
    const s = this.deps.session(u.proof.ptyId);
    // The turn is read in Claude Code's own transcript grammar (taskTurn.ts, parseEntry.ts): this module is that
    // agent's adapter, so the slug is named here (agentSlugBranches.allowlist.json).
    if (!s || s.incarnationId !== u.proof.incarnation || s.keyEpoch !== u.proof.keyEpoch || s.agent !== 'claude') {
      u.turn.closed = true;
      return null;
    }
    if (!u.turn.opened && now - u.firstSeenAt >= LINKED_TURN_SEEK_MAX_MS) {
      u.expired = true;
      u.turn.closed = true;
      return null;
    }
    const path = this.deps.transcriptPath(u.proof.ptyId);
    if (!path) return null;
    // Another conversation in the pane: the turn is never looked for there.
    if (u.path !== null && u.path !== path) {
      u.turn.closed = true;
      return null;
    }
    return path;
  }

  private read(path: string, units: Unit[]): void {
    const st = statTranscript(path);
    if (!st) return;
    for (const u of units) {
      if (u.path === null) {
        u.path = path;
        u.ino = st.ino;
        u.offset = u.proof.transcriptOffsetAtBase ?? st.size;
        if (u.offset > st.size || !isLineBoundary(path, u.offset)) u.turn.closed = true;
      } else if (st.ino !== u.ino || st.size < u.offset) {
        // Replaced or cut.
        u.turn.closed = true;
      }
    }
    const open = units.filter((u) => !u.turn.closed);
    if (open.length === 0) return;
    const from = Math.min(...open.map((u) => u.offset));
    if (st.size === from) return;
    if (!isLineBoundary(path, from)) {
      for (const u of open) u.turn.closed = true;
      return;
    }
    const lines: Line[] = [];
    // Raw lines only: each unit parses from its prompt's entry on.
    const delta = readTranscriptDelta(path, from, undefined, (line, start) => {
      lines.push({ line, start });
      return [];
    });
    if (!delta) return;
    if (delta.reset) {
      for (const u of open) u.turn.closed = true;
      return;
    }
    for (const u of open) {
      // Not read yet by this unit: from its own offset (each is a line start, so is `from`).
      this.step(u, lines.filter((l) => l.start >= u.offset));
      u.offset = Math.max(u.offset, delta.cursor.tailOffset);
    }
  }

  private step(u: Unit, lines: Line[]): void {
    let from = 0;
    if (!u.turn.opened) {
      const matches: number[] = [];
      lines.forEach((l, i) => { if (isPromptEntry(l.line, u.turn.promptHash)) matches.push(i); });
      // Two entries of the prompt past the floor: which one is this submit's cannot be told.
      if (matches.length > 1) {
        u.turn.closed = true;
        return;
      }
      // Before the prompt's entry, only the raw lines decide (any input there closes the turn).
      const until = matches.length === 1 ? matches[0] : lines.length;
      for (let i = 0; i < until && !u.turn.closed; i++) stepTaskTurn(u.turn, lines[i].line, []);
      if (u.turn.closed || matches.length === 0) return;
      from = until;
    }
    for (let i = from; i < lines.length && !u.turn.closed; i++) {
      // The prompt again while its turn is open (a later read): as two entries in one read, not this submit's.
      if (u.turn.opened && isPromptEntry(lines[i].line, u.turn.promptHash)) {
        u.turn.opened = false;
        u.turn.toolUseIds = [];
        u.turn.closed = true;
        return;
      }
      stepTaskTurn(u.turn, lines[i].line, parseTranscriptLine(lines[i].line, lines[i].start));
    }
  }

  private resume(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), HEADLESS_DELIVERY_TICK_MS);
    this.timer.unref?.();
  }

  private pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private warn(what: string, err: unknown): void {
    this.deps.log?.('warn', `[a2a-remote] linked task turns: ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Whether `a` was delivered after `b`. In one session (pty, incarnation and
 * key epoch) the key count orders them: each submit's count includes every
 * earlier one's Enters, so a held item delivered late is told apart from the
 * newer ones delivered before it. Across sessions, the listed order.
 */
function deliveredAfter(a: Unit, b: Unit): boolean {
  const same = a.proof.ptyId === b.proof.ptyId && a.proof.incarnation === b.proof.incarnation && a.proof.keyEpoch === b.proof.keyEpoch;
  return same ? a.proof.submitRevision > b.proof.submitRevision : a.order > b.order;
}

/** The delivered units of an open inbound task that carry a proof for the pane's current occupant. */
function unitsOf(task: Task): Array<{ id: string; messageId?: string; order: number; key: string; proof: GatedSubmitProof }> {
  const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
  if (marker?.direction !== 'inbound' || (TERMINAL_STATES as readonly string[]).includes(task.status.state)) return [];
  const occupant = task.metadata[localSideOf(task)].ptyId;
  const out: Array<{ id: string; messageId?: string; order: number; key: string; proof: GatedSubmitProof }> = [];
  const add = (delivered: boolean | undefined, submit: unknown, order: number, messageId?: string): void => {
    const proof = delivered === true ? parseGatedSubmitProof(submit) : undefined;
    if (!proof || proof.ptyId !== occupant) return;
    const key = [proof.ptyId, proof.incarnation, proof.keyEpoch, proof.submitRevision, proof.promptHash, proof.transcriptOffsetAtBase ?? ''].join('\0');
    out.push({ id: `${task.id}\0${messageId ?? ''}`, ...(messageId !== undefined ? { messageId } : {}), order, key, proof });
  };
  add(marker.delivered, marker.submit, 0);
  (marker.inbox ?? []).forEach((item, i) => add(item.delivered, item.submit, i + 1, item.messageId));
  return out;
}
