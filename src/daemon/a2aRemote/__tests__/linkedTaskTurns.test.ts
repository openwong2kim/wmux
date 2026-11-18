// LinkedTaskTurns: the turn a remote task's delivery started in a linked pane,
// followed in that pane's transcript (a real file in Claude Code's shape) from
// the submit proof on the task's marker. Read only; nothing acts on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import { promptHash } from '../../../shared/promptHash';
import type { Task } from '../../../shared/types';
import { LinkedTaskTurns } from '../linkedTaskTurns';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const TASK = `rt-${'1'.padStart(32, '0')}`;
const PTY = 'pty-linked';
const PROMPT = `[wmux] task ${TASK} from pc-a/ws/#1:\n> Reply with PONG`;

let dir: string;
let transcript: string;
let bound: boolean;
let tasks: Task[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-task-turns-'));
  transcript = path.join(dir, 'session.jsonl');
  bound = true;
  tasks = [];
});
afterEach(() => {
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

function inboundTask(over: { submit?: unknown; state?: Task['status']['state']; ptyId?: string } = {}): Task {
  const remote: A2aRemoteTaskState = {
    v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: true,
    ...(over.submit !== undefined ? { submit: over.submit as A2aRemoteTaskState['submit'] } : {}),
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

const proof = (text = PROMPT) => ({ ptyId: PTY, incarnation: 'inc-1', submitRevision: 3, promptHash: promptHash(text) });

function tracker(): LinkedTaskTurns {
  return new LinkedTaskTurns({
    tasks: () => tasks,
    transcriptPath: (sessionId) => (bound && sessionId === PTY ? transcript : null),
  });
}

describe('LinkedTaskTurns', () => {
  it('finds a prompt already written behind the pane\'s history, records its tool calls, and closes on the turn end', () => {
    // The pane's earlier conversation: a person's prompts are history, not input that took the turn.
    write(userLine('an earlier prompt'), assistantLine('earlier answer'), userLine(PROMPT), callLine('toolu_1'));
    tasks = [inboundTask({ submit: proof() })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
    write(callLine('toolu_2'), assistantLine('PONG'), userLine('next prompt'), callLine('toolu_3'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: true, toolUseIds: ['toolu_1', 'toolu_2'] });
  });

  it('a prompt not written yet is waited for from the end of the file', () => {
    write(userLine('an earlier prompt'), assistantLine('earlier answer'));
    tasks = [inboundTask({ submit: proof() })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: false, toolUseIds: [] });
    write(userLine(PROMPT), callLine('toolu_1'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: ['toolu_1'] });
  });

  it('other input that reached the agent before the prompt closes it', () => {
    write(assistantLine('earlier answer'));
    tasks = [inboundTask({ submit: proof() })];
    const t = tracker();
    t.tick();
    write(userLine('typed by the person'), userLine(PROMPT), callLine('toolu_1'));
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: false, closed: true, toolUseIds: [] });
  });

  it('unknown without a submit proof, before the transcript is bound, and once the task ended', () => {
    write(userLine(PROMPT));
    tasks = [inboundTask()];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');

    tasks = [inboundTask({ submit: { ...proof(), promptHash: 'nope' } })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');

    // A proof for a pty the pane no longer has.
    tasks = [inboundTask({ submit: proof(), ptyId: 'pty-other' })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');

    bound = false;
    tasks = [inboundTask({ submit: proof() })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
    bound = true;
    t.tick();
    expect(t.taskTurn(TASK)).toEqual({ opened: true, closed: false, toolUseIds: [] });

    tasks = [inboundTask({ submit: proof(), state: 'completed' })];
    t.tick();
    expect(t.taskTurn(TASK)).toBe('unknown');
  });

  it('a transcript cut or replaced after the open closes it', () => {
    write(userLine(PROMPT));
    tasks = [inboundTask({ submit: proof() })];
    const t = tracker();
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ opened: true, closed: false });
    fs.writeFileSync(transcript, '');
    t.tick();
    expect(t.taskTurn(TASK)).toMatchObject({ opened: true, closed: true });
  });
});
