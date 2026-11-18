// LinkedTaskTurns: the turn each delivery of a remote task started in a linked
// pane, followed in that pane's transcript (a real file in Claude Code's shape)
// from the submit proof on the task's marker. Read only; nothing acts on it.
// The rule under test: a turn is never taken for the task's when it may not be.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2aRemoteInboxItem, A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import { promptHash } from '../../../shared/promptHash';
import type { Task } from '../../../shared/types';
import { LINKED_TURN_SEEK_MAX_MS, LinkedTaskTurns } from '../linkedTaskTurns';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const TASK = `rt-${'1'.padStart(32, '0')}`;
const PTY = 'pty-linked';
const PROMPT = `[wmux] task ${TASK} from pc-a/ws/#1:\n> Reply with PONG`;
const FOLLOW_UP = `[wmux] reply on ${TASK} from pc-a/ws/#1:\n> and the kernel version`;

let dir: string;
let transcript: string;
let bound: boolean;
let tasks: Task[];
let live: { incarnationId: string | null; keyEpoch: string; agent: string | null } | null;
let clock: number;
/** Every tracker a test made: stopped after it, so none polls the next test's fixtures. */
const made: LinkedTaskTurns[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-task-turns-'));
  transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, '');
  bound = true;
  tasks = [];
  live = { incarnationId: 'inc-1', keyEpoch: 'ep-1', agent: 'claude' };
  clock = 1_000_000;
});
afterEach(() => {
  for (const t of made.splice(0)) t.stop();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const stamp = (): string => new Date(Date.UTC(2026, 10, 13, 0, 0, seq++)).toISOString();
const userLine = (text: string): string => JSON.stringify({ type: 'user', uuid: `u${seq}`, timestamp: stamp(), message: { role: 'user', content: text } });
const assistantLine = (text: string): string => JSON.stringify({ type: 'assistant', uuid: `a${seq}`, timestamp: stamp(),
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
const callLine = (id: string): string => JSON.stringify({ type: 'assistant', uuid: `c${seq}`, timestamp: stamp(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'uname -s' } }], stop_reason: 'tool_use' } });
const write = (...lines: string[]): void => fs.appendFileSync(transcript, lines.map((l) => `${l}\n`).join(''));
const size = (): number => fs.statSync(transcript).size;

type Proof = Record<string, unknown>;
const proof = (over: Proof = {}): Proof => ({ ptyId: PTY, incarnation: 'inc-1', keyEpoch: 'ep-1', submitRevision: 3, promptHash: promptHash(PROMPT), ...over });

function inboundTask(over: { submit?: Proof; state?: Task['status']['state']; ptyId?: string; inbox?: A2aRemoteInboxItem[] } = {}): Task {
  const remote: A2aRemoteTaskState = {
    v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: true,
    ...(over.submit !== undefined ? { submit: over.submit as unknown as A2aRemoteTaskState['submit'] } : {}),
    ...(over.inbox ? { inbox: over.inbox } : {}),
  };
  return {
    kind: 'task',
    id: TASK,
    status: { state: over.state ?? 'submitted', timestamp: stamp() },
    history: [{ kind: 'message', messageId: 'm-0', role: 'user', parts: [{ kind: 'text', text: 'Reply with PONG' }] }],
    artifacts: [],
    metadata: {
      title: 'T',
      from: { workspaceId: `remote:${LINK}`, name: 'pc-a/ws/#1' },
      to: { workspaceId: 'ws-local', name: 'Local', paneId: 'pane-l', ptyId: over.ptyId ?? PTY },
      createdAt: stamp(),
      updatedAt: stamp(),
      remote,
    },
  } as Task;
}

function tracker(over: { tasks?: () => Task[] } = {}): LinkedTaskTurns {
  const t = new LinkedTaskTurns({
    tasks: over.tasks ?? (() => tasks),
    transcriptPath: (sessionId) => (bound && sessionId === PTY ? transcript : null),
    session: (sessionId) => (sessionId === PTY ? live : null),
    now: () => clock,
  });
  made.push(t);
  return t;
}

describe('LinkedTaskTurns', () => {
  it('reads from the floor: the prompt written after it opens the turn, its tool calls are recorded, the turn end closes it', () => {
    write(userLine('an earlier prompt'), assistantLine('earlier answer'));
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
    write(callLine('toolu_2'), assistantLine('PONG'), userLine('next prompt'), callLine('toolu_3'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: true, toolUseIds: ['toolu_1', 'toolu_2'] });
  });

  it('an earlier identical prompt before the floor is not bound', () => {
    // A re-offered delivery, or history a resumed conversation copied.
    write(userLine(PROMPT), callLine('toolu_old'), assistantLine('old answer'));
    const floor = size();
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: false, toolUseIds: [] });
    write(userLine(PROMPT), callLine('toolu_new'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_new'] });
  });

  it('two entries of the prompt past the floor: not opened', () => {
    const floor = size();
    write(userLine(PROMPT), userLine(PROMPT), callLine('toolu_1'));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: true, toolUseIds: [] });
  });

  it('the prompt again inside the open turn, read later: not opened either, as in one read', () => {
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
    write(userLine(PROMPT), callLine('toolu_2'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: true, toolUseIds: [] });
  });

  it('without a floor, only an entry written after the unit was first seen counts', () => {
    write(userLine(PROMPT), callLine('toolu_old'));
    tasks = [inboundTask({ submit: proof() })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: false, toolUseIds: [] });
    write(userLine(PROMPT), callLine('toolu_new'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_new'] });
  });

  it('other input that reached the agent before the prompt closes it', () => {
    const floor = size();
    write(userLine('typed by the person'), userLine(PROMPT), callLine('toolu_1'));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: true, toolUseIds: [] });
  });

  it('a restart: a proof from another key epoch is not followed', () => {
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'));
    // The recovered session keeps its incarnation, but its bridge counts again from 0 under a new epoch.
    live = { incarnationId: 'inc-1', keyEpoch: 'ep-2', agent: 'claude' };
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
  });

  it('another incarnation, another agent, or no session: not followed', () => {
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    for (const state of [{ incarnationId: 'inc-2', keyEpoch: 'ep-1', agent: 'claude' }, { incarnationId: 'inc-1', keyEpoch: 'ep-1', agent: 'codex' }, null]) {
      live = state;
      const t = tracker();
      t.tick();
      expect(t.taskTurn(TASK)).toBe('unknown');
    }
  });

  it('the session moving to another transcript closes it, opened or not', () => {
    const floor = size();
    write(userLine(PROMPT));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ opened: true, closed: false });
    const other = path.join(dir, 'other.jsonl');
    fs.writeFileSync(other, `${userLine(PROMPT)}\n`);
    transcript = other;
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ opened: true, closed: true });
  });

  it('a transcript cut closes it', () => {
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: 0 }) })];
    const t = tracker();
    t.tick();
    write(assistantLine('padding'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: false, toolUseIds: [] });
    fs.writeFileSync(transcript, '');
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ opened: false, closed: true });
  });

  it('a transcript replaced at the same path (another file, larger) closes it', () => {
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: 0 }) })];
    const t = tracker();
    t.tick();
    write(assistantLine('padding'));
    t.tick();
    const replaced = path.join(dir, 'replaced.jsonl');
    fs.writeFileSync(replaced, `${assistantLine('a'.repeat(400))}\n${userLine(PROMPT)}\n`);
    fs.renameSync(replaced, transcript);
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ opened: false, closed: true });
  });

  it('a floor that is not a line start closes it', () => {
    write(userLine('an earlier prompt'));
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: 5 }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ closed: true });
  });

  it('a follow-up delivered as an inbox item is its own unit, and the latest is reported', () => {
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'), assistantLine('PONG'));
    const itemFloor = size();
    write(userLine(FOLLOW_UP), callLine('toolu_2'));
    const item: A2aRemoteInboxItem = {
      messageId: 'r-1', kind: 'reply', delivered: true,
      submit: proof({ promptHash: promptHash(FOLLOW_UP), submitRevision: 9, transcriptOffsetAtBase: itemFloor }) as unknown as A2aRemoteInboxItem['submit'],
    };
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }), inbox: [item] })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ messageId: 'r-1', opened: true, closed: false, toolUseIds: ['toolu_2'] });
  });

  it('the latest is the one delivered last, not the one listed last: a held reply delivered late', () => {
    const LATE = `[wmux] reply on ${TASK} from pc-a/ws/#1:\n> the held one`;
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'), assistantLine('PONG'));
    const newerFloor = size();
    write(userLine(FOLLOW_UP), callLine('toolu_2'), assistantLine('5.15'));
    const lateFloor = size();
    write(userLine(LATE), callLine('toolu_3'));
    // r-1 arrived first but was held; r-2 was delivered meanwhile, r-1 after it (a higher key count).
    const late: A2aRemoteInboxItem = {
      messageId: 'r-1', kind: 'reply', delivered: true,
      submit: proof({ promptHash: promptHash(LATE), submitRevision: 20, transcriptOffsetAtBase: lateFloor }) as unknown as A2aRemoteInboxItem['submit'],
    };
    const newer: A2aRemoteInboxItem = {
      messageId: 'r-2', kind: 'reply', delivered: true,
      submit: proof({ promptHash: promptHash(FOLLOW_UP), submitRevision: 9, transcriptOffsetAtBase: newerFloor }) as unknown as A2aRemoteInboxItem['submit'],
    };
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }), inbox: [late, newer] })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ messageId: 'r-1', opened: true, closed: false, toolUseIds: ['toolu_3'] });
  });

  it('a unit from another session listed between two of one session does not change which of those is latest', () => {
    const OTHER = `[wmux] reply on ${TASK} from pc-a/ws/#1:\n> from before the restart`;
    const itemFloor = size();
    write(userLine(FOLLOW_UP), callLine('toolu_2'), assistantLine('5.15'));
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'));
    // The task itself went in last in this session (a higher key count than r-2); r-1 is from another key epoch.
    const before: A2aRemoteInboxItem = {
      messageId: 'r-1', kind: 'reply', delivered: true,
      submit: proof({ promptHash: promptHash(OTHER), keyEpoch: 'ep-0', submitRevision: 99, transcriptOffsetAtBase: 0 }) as unknown as A2aRemoteInboxItem['submit'],
    };
    const item: A2aRemoteInboxItem = {
      messageId: 'r-2', kind: 'reply', delivered: true,
      submit: proof({ promptHash: promptHash(FOLLOW_UP), submitRevision: 5, transcriptOffsetAtBase: itemFloor }) as unknown as A2aRemoteInboxItem['submit'],
    };
    tasks = [inboundTask({ submit: proof({ submitRevision: 10, transcriptOffsetAtBase: floor }), inbox: [before, item] })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
  });

  it('one task that throws does not stop the others, nor the clean-up', () => {
    const floor = size();
    write(userLine(PROMPT), callLine('toolu_1'));
    const bad = { id: 'rt-bad', status: { state: 'submitted' } } as unknown as Task;
    tasks = [bad, inboundTask({ submit: proof({ transcriptOffsetAtBase: floor }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
    tasks = [bad];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
  });

  it('a prompt not seen within the bound is given up on', () => {
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: 0 }) })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: false, toolUseIds: [] });
    clock += LINKED_TURN_SEEK_MAX_MS;
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
  });

  it('unknown without a proof, with a malformed one, for another occupant, before the transcript is bound, and once the task ended', () => {
    tasks = [inboundTask()];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
    tasks = [inboundTask({ submit: proof({ promptHash: 'nope' }) })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
    tasks = [inboundTask({ submit: proof(), ptyId: 'pty-other' })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
    bound = false;
    tasks = [inboundTask({ submit: proof() })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
    bound = true;
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: false, toolUseIds: [] });
    tasks = [inboundTask({ submit: proof(), state: 'completed' })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
  });

  it('no task with a proof: no timer, no work until woken', () => {
    vi.useFakeTimers();
    const list = vi.fn(() => tasks);
    tasks = [inboundTask()];
    const t = tracker({ tasks: list });
    t.start();
    expect(list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    // A mark with a proof lands: woken, it reads until the unit is closed, then stops again.
    tasks = [inboundTask({ submit: proof({ transcriptOffsetAtBase: 0 }) })];
    t.wake();
    expect(list).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3_000);
    expect(list.mock.calls.length).toBeGreaterThan(2);
    write(userLine('typed by the person'));
    vi.advanceTimersByTime(1_000);
    const calls = list.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(list).toHaveBeenCalledTimes(calls);
    t.stop();
  });
});
