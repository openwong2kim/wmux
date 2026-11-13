// The headless task delivery against fake ports: what each result of the
// paste-and-Enter does, who may type, and how the agent's transcript decides
// the reply (stepEpisode). The transcript is a real file in Claude Code's shape.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A2aRemoteTaskMarkerV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import type { SessionPromptScheduleResult } from '../../../shared/sessionPromptSchedule';
import { VALID_TRANSITIONS, type Task } from '../../../shared/types';
import { USAGE_LIMIT_CONTINUE_PROMPT } from '../../../shared/usageLimit';
import { A2A_REMOTE_BODY_MAX } from '../../../shared/a2aRemote';
import {
  ASK_REASON, HeadlessDelivery, QUESTION_NOTICE_MS, QUESTION_REASON, QUESTION_TIMEOUT_MS, assistantTextOf, cutReply, type HeadlessDeliveryDeps,
} from '../headlessDelivery';
import type { HeadlessStartRecordV1 } from '../headlessStartStore';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const SESSION = 'hl-11111111-2222-4333-8444-555555555555';
const WS = 'hl-0123abcd-4567-4abc-8def-0123456789ab';
const TASK = `rt-${'1'.padStart(32, '0')}`;
/** The first task of a remote start carries this message id (spawnFirstMessageId). */
const FIRST = `first_${LINK}`;
const PROMPT = 'Reply with PONG and the output of uname -s';

let dir: string;
let transcript: string;
let active: boolean;
let rec: HeadlessStartRecordV1;
let task: Task;
let results: Array<SessionPromptScheduleResult | 'error!'>;
/** What the screen shows when the delivery asks for a question on it. */
let screen: 'dialog' | 'clear' | 'unknown';
let rejected: Array<{ taskId: string; reason: string }>;
let delivered: Array<{ sessionId: string; prompt: string }>;
let marks: Array<Record<string, unknown>>;
let replies: Array<{ taskId: string; workspaceId: string; text: string }>;
let replyError: string | null;
let moves: Array<{ to: string; summary?: string }>;
let bound: boolean;
let clock: number;
/** What the gate answered when the deliverer asked it. */
let gateAnswers: boolean[];

function startRecord(over: Partial<HeadlessStartRecordV1> = {}): HeadlessStartRecordV1 {
  return {
    v: 1, hostId: HOST, spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab', agent: 'claude', repoPath: '/repo',
    sessionId: SESSION, workspaceId: WS, agentSessionId: '33333333-3333-4333-8333-333333333333', lineage: `remote-spawn:${HOST}`,
    runId: 'run-1', phase: 'started', startedAt: new Date().toISOString(), ...over,
  };
}

function inboundTask(text = PROMPT, messageId = FIRST): Task {
  const marker: A2aRemoteTaskMarkerV1 = { v: 1, linkId: LINK, hostId: HOST, messageId, direction: 'inbound', delivered: false };
  return {
    kind: 'task',
    id: TASK,
    status: { state: 'submitted', timestamp: '2026-11-13T00:00:00.000Z' },
    history: [{ kind: 'message', messageId, role: 'user', parts: [{ kind: 'text', text }] }],
    artifacts: [],
    metadata: {
      title: 'remote',
      from: { workspaceId: `remote:${LINK}`, name: 'pc-a' },
      to: { workspaceId: WS, name: 'box', paneId: SESSION },
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
      remote: marker,
    },
  } as Task;
}

const marker = (): A2aRemoteTaskState => task.metadata.remote as A2aRemoteTaskState;
const isEnded = (): boolean => ['completed', 'failed', 'canceled'].includes(task.status.state);

function deps(over: Partial<HeadlessDeliveryDeps> = {}): HeadlessDeliveryDeps {
  return {
    mode: { active: () => active },
    starts: { list: () => [rec] },
    runId: 'run-1',
    tasks: {
      pending: () => (marker().delivered !== true && !marker().held && !isEnded() ? [task] : []),
      remote: () => [task],
      held: () => (marker().held && !isEnded() ? [task] : []),
      get: (id) => (id === task.id ? task : undefined),
    },
    rejectHeld: async (input) => {
      rejected.push(input);
      task.status = { state: 'failed', timestamp: new Date().toISOString() };
      return { ok: true };
    },
    questionOnScreen: async () => screen,
    mark: async (input) => {
      marks.push(input);
      const m = marker();
      if (input.delivered) {
        m.delivered = true;
        delete m.attempted;
      } else if (input.attempted === true) m.attempted = true;
      else if (input.attempted === false) delete m.attempted;
      return { ok: true };
    },
    deliver: async (sessionId, _agent, prompt, authorized, onWrite) => {
      gateAnswers.push(authorized());
      const result = results.shift() ?? 'sent';
      // `sent` and a real `error` wrote; `error!` is an error before any write (the gate said no).
      if (result === 'sent' || result === 'error') onWrite();
      if (result === 'sent') delivered.push({ sessionId, prompt });
      return (result === 'error!' ? 'error' : result) as SessionPromptScheduleResult;
    },
    transcriptPath: () => (bound ? transcript : null),
    transcriptSize: (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0),
    reply: async (input) => {
      if (replyError) return { ok: false, error: replyError };
      replies.push(input);
      task.history.push({ kind: 'message', messageId: `r${replies.length}`, role: 'agent', parts: [{ kind: 'text', text: input.text }] });
      return { ok: true };
    },
    // The ledger's own rule: only a legal transition is committed.
    transition: async ({ to, summary }) => {
      if (!VALID_TRANSITIONS[task.status.state].includes(to)) return { ok: false, error: `illegal ${task.status.state} -> ${to}` };
      moves.push({ to, ...(summary ? { summary } : {}) });
      task.status = { state: to, timestamp: new Date().toISOString() };
      return { ok: true };
    },
    log: () => undefined,
    now: () => clock,
    ...over,
  };
}

// Claude Code transcript entries (one JSON object per line).
let seq = 0;
const stamp = (): string => new Date(Date.UTC(2026, 10, 13, 0, 0, seq++)).toISOString();
const userLine = (text: string): string => JSON.stringify({ type: 'user', uuid: `u${seq}`, timestamp: stamp(), message: { role: 'user', content: text } });
const assistantLine = (text: string, end = true, extra: object[] = []): string => JSON.stringify({
  type: 'assistant', uuid: `a${seq}`, timestamp: stamp(),
  message: { role: 'assistant', content: [...extra, { type: 'text', text }], ...(end ? { stop_reason: 'end_turn' } : {}) },
});
const toolUseLine = (): string => JSON.stringify({ type: 'assistant', uuid: `t${seq}`, timestamp: stamp(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool${seq}`, name: 'Bash', input: { command: 'uname -s' } }] } });
const toolResultLine = (): string => JSON.stringify({ type: 'user', uuid: `r${seq}`, timestamp: stamp(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool${seq - 1}`, content: 'Linux' }] } });
const interruptLine = (): string => JSON.stringify({ type: 'user', uuid: `i${seq}`, timestamp: stamp(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
const apiErrorLine = (error: string, text: string): string => JSON.stringify({ type: 'assistant', uuid: `e${seq}`, timestamp: stamp(), isApiErrorMessage: true, error,
  message: { role: 'assistant', content: [{ type: 'text', text }] } });
const write = (...lines: string[]): void => fs.appendFileSync(transcript, lines.map((l) => `${l}\n`).join(''));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-delivery-'));
  transcript = path.join(dir, '33333333-3333-4333-8333-333333333333.jsonl');
  active = true;
  rec = startRecord();
  task = inboundTask();
  results = [];
  screen = 'clear';
  rejected = [];
  delivered = [];
  marks = [];
  replies = [];
  replyError = null;
  moves = [];
  bound = true;
  clock = 1_000_000;
  gateAnswers = [];
  seq = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('typing the task in', () => {
  it('stopped (the daemon shutting down): a pass types nothing more, and the write gate says no', async () => {
    const d = new HeadlessDelivery(deps({
      deliver: async (_s, _a, _p, authorized) => {
        d.stop();
        gateAnswers.push(authorized());
        return 'busy';
      },
    }));
    await d.tick();
    expect(gateAnswers).toEqual([false]);
    await d.tick();
    expect(gateAnswers).toHaveLength(1);
  });

  it('a task that ended while it was being typed in (canceled by the asker) is not let through the write gate', async () => {
    const d = new HeadlessDelivery(deps({
      deliver: async (_s, _a, _p, authorized) => {
        task.status = { state: 'canceled', timestamp: '' };
        gateAnswers.push(authorized());
        return 'error';
      },
    }));
    await d.tick();
    expect(gateAnswers).toEqual([false]);
  });

  it('sent: the attempt is recorded first, then delivered, and the task is working', async () => {
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(delivered).toEqual([{ sessionId: SESSION, prompt: PROMPT }]);
    expect(marks).toEqual([{ taskId: TASK, attempted: true }, { taskId: TASK, delivered: true, ptyId: SESSION }]);
    expect(moves).toEqual([{ to: 'working' }]);
    expect(gateAnswers).toEqual([true]);
    // Typed once.
    await d.tick();
    expect(delivered).toHaveLength(1);
  });

  it('busy and unavailable wrote nothing: the attempt is withdrawn and it is tried again after a backoff', async () => {
    results = ['busy', 'unavailable'];
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(marks).toEqual([{ taskId: TASK, attempted: true }, { taskId: TASK, attempted: false }]);
    await d.tick();
    expect(marks).toHaveLength(2);
    clock += 2000;
    await d.tick();
    expect(marks.slice(2)).toEqual([{ taskId: TASK, attempted: true }, { taskId: TASK, attempted: false }]);
    // The wait doubles.
    clock += 2000;
    await d.tick();
    expect(marks).toHaveLength(4);
    clock += 2000;
    await d.tick();
    expect(delivered).toHaveLength(1);
    expect(moves).toEqual([{ to: 'working' }]);
  });

  it('error may have written part of it: the task ends with the reason (canceled, it was never taken), never typed again', async () => {
    results = ['error'];
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(marks).toEqual([{ taskId: TASK, attempted: true }]);
    expect(moves).toEqual([{ to: 'canceled', summary: 'the task may have reached the agent only in part' }]);
    clock += 60_000;
    await d.tick();
    expect(delivered).toEqual([]);
  });

  it('session_changed and folder_trust: withdrawn and failed with the reason', async () => {
    for (const result of ['session_changed', 'folder_trust'] as const) {
      task = inboundTask();
      results = [result];
      moves = [];
      await new HeadlessDelivery(deps()).tick();
      expect(moves).toEqual([{ to: 'canceled', summary: `the agent could not take the task (${result})` }]);
      expect(marker().attempted).toBeUndefined();
    }
  });

  it('an attempt an earlier pass left unconfirmed is never typed again', async () => {
    marker().attempted = true;
    await new HeadlessDelivery(deps()).tick();
    expect(delivered).toEqual([]);
    expect(marks).toEqual([]);
    expect(moves).toEqual([{ to: 'canceled', summary: 'the task may have reached the agent only in part' }]);
  });

  it('only into a started start of this run, with headless mode on, and only while that holds', async () => {
    for (const over of [{ runId: 'run-0' }, { phase: 'created' as const }, { survivors: [{ pid: 9, reason: 'x', startTime: 's' }] }, { workspaceId: 'hl-other' }]) {
      rec = startRecord(over);
      await new HeadlessDelivery(deps()).tick();
    }
    active = false;
    rec = startRecord();
    await new HeadlessDelivery(deps()).tick();
    expect(delivered).toEqual([]);
    expect(marks).toEqual([]);
    // A task for another pane of that workspace is not this start's.
    active = true;
    task.metadata.to.paneId = 'hl-99999999-2222-4333-8444-555555555555';
    await new HeadlessDelivery(deps()).tick();
    expect(delivered).toEqual([]);
    // The gate is asked at the write: headless mode turned off in between answers no.
    task = inboundTask();
    await new HeadlessDelivery(deps({ deliver: async (_s, _a, _p, authorized) => {
      active = false;
      gateAnswers.push(authorized());
      return 'busy';
    } })).tick();
    expect(gateAnswers).toEqual([false]);
  });

  it('the agent process is looked for on its own session only, before each try', async () => {
    const armed: string[] = [];
    results = ['unavailable'];
    const d = new HeadlessDelivery(deps({ armAgent: (id) => void armed.push(id) }));
    await d.tick();
    clock += 2000;
    await d.tick();
    expect(armed).toEqual([SESSION, SESSION]);
    // Not for a task this delivery does not own.
    armed.length = 0;
    rec = startRecord({ runId: 'run-0' });
    task = inboundTask();
    await new HeadlessDelivery(deps({ armAgent: (id) => void armed.push(id) })).tick();
    expect(armed).toEqual([]);
  });

  it('an error before anything was written (the gate said no) is not a partial write: tried again', async () => {
    results = ['error!'];
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(marks).toEqual([{ taskId: TASK, attempted: true }, { taskId: TASK, attempted: false }]);
    expect(moves).toEqual([]);
    clock += 2000;
    await d.tick();
    expect(delivered).toHaveLength(1);
  });

  it('a mark that does not go through is tried again, and the task is never typed twice for it', async () => {
    // The attempt is recorded, the delivered mark is not.
    const realMark = deps().mark;
    let n = 0;
    const flaky = new HeadlessDelivery(deps({ mark: async (input) => (++n === 2 ? { ok: false, error: 'store unavailable' } : realMark(input)) }));
    await flaky.tick();
    expect(delivered).toHaveLength(1);
    expect(marker().delivered).not.toBe(true);
    await flaky.tick();
    expect(marker().delivered).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(moves.filter((m) => m.to === 'canceled' || m.to === 'failed')).toEqual([]);
  });

  it('a start that is ending gets nothing typed in, even by a pass already under way', async () => {
    const d = new HeadlessDelivery(deps({ deliver: async (_s, _a, _p, authorized, onWrite) => {
      // The start begins to end while the paste waits for its Enter.
      await d.startEnding(rec, 'the daemon restarted');
      gateAnswers.push(authorized());
      onWrite();
      return 'error';
    } }));
    await d.tick();
    expect(gateAnswers).toEqual([false]);
    expect(moves).toEqual([{ to: 'canceled', summary: 'the daemon restarted' }]);
    await d.tick();
    expect(gateAnswers).toEqual([false]);
  });

  it('one failing task does not stop the pass', async () => {
    const other = inboundTask('second');
    other.id = `rt-${'2'.padStart(32, '0')}`;
    let typed = 0;
    const d = new HeadlessDelivery(deps({
      tasks: { pending: () => [task, other], remote: () => [task, other], held: () => [], get: (id) => (id === task.id ? task : id === other.id ? other : undefined) },
      starts: { list: () => [rec, startRecord({ sessionId: 'hl-22222222-2222-4333-8444-555555555555', workspaceId: 'hl-second' })] },
      mark: async (input) => {
        if (input.taskId === task.id) throw new Error('store broke');
        return { ok: true };
      },
      deliver: async () => {
        typed += 1;
        return 'sent';
      },
    }));
    other.metadata.to = { workspaceId: 'hl-second', name: 'box', paneId: 'hl-22222222-2222-4333-8444-555555555555' };
    await d.tick();
    expect(typed).toBe(1);
  });

  it('one task at a time per agent, oldest first: follow-ups (`direct`) wait for the open turn, then go in the order they came', async () => {
    // A small ledger of three tasks for the same agent: the first, then two follow-ups (the newer one listed first).
    const at = (n: number): string => `2026-11-13T00:00:0${n}.000Z`;
    const first = task;
    const later = inboundTask('second follow-up', 'm3');
    later.id = `rt-${'3'.padStart(32, '0')}`;
    later.metadata.createdAt = at(3);
    const next = inboundTask('first follow-up', 'm2');
    next.id = `rt-${'2'.padStart(32, '0')}`;
    next.metadata.createdAt = at(2);
    first.metadata.createdAt = at(1);
    const all = [later, next, first];
    const owed = (t: Task): boolean => (t.metadata.remote as A2aRemoteTaskState).delivered !== true && !['completed', 'failed', 'canceled'].includes(t.status.state);
    const byId = (id: string): Task => all.find((t) => t.id === id)!;
    const d = new HeadlessDelivery(deps({
      tasks: { pending: () => all.filter(owed), remote: () => all, held: () => [], get: (id) => all.find((t) => t.id === id) },
      mark: async (input) => {
        const m = byId(input.taskId).metadata.remote as A2aRemoteTaskState;
        if (input.delivered) m.delivered = true;
        return { ok: true };
      },
      reply: async (input) => {
        replies.push(input);
        byId(input.taskId).history.push({ kind: 'message', messageId: `r${replies.length}`, role: 'agent', parts: [{ kind: 'text', text: input.text }] });
        return { ok: true };
      },
      transition: async ({ taskId, to }) => {
        const t = byId(taskId);
        if (!VALID_TRANSITIONS[t.status.state].includes(to)) return { ok: false, error: 'illegal' };
        t.status = { state: to, timestamp: '' };
        return { ok: true };
      },
    }));
    await d.tick();
    expect(delivered.map((x) => x.prompt)).toEqual([PROMPT]);
    // The open turn holds the follow-ups back.
    await d.tick();
    expect(delivered).toHaveLength(1);
    // The turn ends; in the same pass the older follow-up is offered (not the newer one listed
    // before it). Its agent busy at first: the newer one still waits behind it, even while the
    // older one waits for its retry.
    results = ['busy'];
    write(userLine(PROMPT), assistantLine('PONG'));
    await d.tick();
    expect(first.status.state).toBe('input-required');
    expect(delivered.map((x) => x.prompt)).toEqual([PROMPT]);
    await d.tick();
    expect(delivered.map((x) => x.prompt)).toEqual([PROMPT]);
    clock += 2_000;
    await d.tick();
    expect(delivered.map((x) => x.prompt)).toEqual([PROMPT, 'first follow-up']);
    write(userLine('first follow-up'), assistantLine('one'));
    await d.tick();
    await d.tick();
    expect(delivered.map((x) => x.prompt)).toEqual([PROMPT, 'first follow-up', 'second follow-up']);
    write(userLine('second follow-up'), assistantLine('two'));
    await d.tick();
    expect(replies.map((r) => [r.taskId, r.text])).toEqual([[TASK, 'PONG'], [next.id, 'one'], [later.id, 'two']]);
    expect(all.map((t) => t.status.state)).toEqual(['input-required', 'input-required', 'input-required']);
  });

  it('a follow-up held for a person (`ask`) is refused at once with the reason; nothing typed', async () => {
    task = inboundTask('a follow-up', 'm2');
    task.id = `rt-${'2'.padStart(32, '0')}`;
    (task.metadata.remote as A2aRemoteTaskState).held = 'awaiting-approval';
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(rejected).toEqual([{ taskId: task.id, reason: ASK_REASON }]);
    expect(delivered).toEqual([]);
    expect(marks).toEqual([]);
    // Once.
    await d.tick();
    expect(rejected).toHaveLength(1);
  });

  it('a hold on a pane that is not this run\'s live start is left alone', async () => {
    task = inboundTask('a follow-up', 'm2');
    (task.metadata.remote as A2aRemoteTaskState).held = 'awaiting-approval';
    rec = startRecord({ runId: 'an-earlier-run' });
    const d = new HeadlessDelivery(deps());
    await d.tick();
    rec = startRecord({ phase: 'ended' });
    await d.tick();
    rec = startRecord();
    active = false;
    await d.tick();
    expect(rejected).toEqual([]);
  });
});

describe('the reply, from the transcript', () => {
  async function delivering(): Promise<HeadlessDelivery> {
    write(userLine('an earlier session line'));
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(moves).toEqual([{ to: 'working' }]);
    return d;
  }

  it('the first turn end after the prompt\'s own entry: its last assistant text is the reply, then input-required', async () => {
    const d = await delivering();
    write(userLine(PROMPT), toolUseLine(), toolResultLine(), assistantLine('PONG\n```\nLinux\n```'));
    await d.tick();
    expect(replies).toEqual([{ taskId: TASK, workspaceId: WS, text: 'PONG\n```\nLinux\n```', ptyId: SESSION }]);
    expect(moves).toEqual([{ to: 'working' }, { to: 'input-required' }]);
  });

  it('text written before the last tool call is not part of the answer; thinking is left out', async () => {
    const d = await delivering();
    write(userLine(PROMPT), assistantLine('let me check', false), toolUseLine(), toolResultLine(),
      assistantLine('Linux', true, [{ type: 'thinking', thinking: 'hmm' }]));
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(['Linux']);
  });

  it('the prompt is recognized on the raw entry: a long one the parser shortens, one the parser reads as a command', async () => {
    for (const prompt of ['x'.repeat(9000), '/review the build log']) {
      task = inboundTask(prompt);
      moves = [];
      replies = [];
      const d = new HeadlessDelivery(deps());
      await d.tick();
      write(userLine(prompt), assistantLine('done'));
      await d.tick();
      expect(replies.map((r) => r.text)).toEqual(['done']);
      expect(moves.at(-1)).toEqual({ to: 'input-required' });
    }
  });

  it('a turn that stops for a reason other than a tool call ends it (max_tokens), with what it wrote', async () => {
    const d = await delivering();
    write(userLine(PROMPT), JSON.stringify({ type: 'assistant', uuid: 'mx', timestamp: stamp(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'PONG, cut short' }], stop_reason: 'max_tokens' } }));
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(['PONG, cut short']);
  });

  it('a session bound to another conversation after the write: not this turn, failed', async () => {
    const d = await delivering();
    write(userLine(PROMPT));
    await d.tick();
    transcript = path.join(dir, 'other.jsonl');
    write(userLine('something else'), assistantLine('not ours'));
    await d.tick();
    expect(replies).toEqual([]);
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's conversation was replaced on this PC" });
  });

  it('the turn may come over several passes; nothing is sent before it ends', async () => {
    const d = await delivering();
    write(userLine(PROMPT), toolUseLine());
    await d.tick();
    expect(replies).toEqual([]);
    write(toolResultLine(), assistantLine('done'));
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(['done']);
  });

  it('the conversation not bound yet: the episode waits for it and reads from where the file began', async () => {
    bound = false;
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(delivered).toHaveLength(1);
    write(userLine(PROMPT), assistantLine('PONG'));
    await d.tick();
    expect(replies).toEqual([]);
    bound = true;
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(['PONG']);
  });

  it('input from this PC before the prompt, or inside its turn: failed, no reply', async () => {
    let d = await delivering();
    write(userLine('something typed over ssh'));
    await d.tick();
    expect(replies).toEqual([]);
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: 'the agent was given other input on this PC before the task' });

    task = inboundTask();
    moves = [];
    d = await delivering();
    write(userLine(PROMPT), toolUseLine(), userLine('stop that'));
    await d.tick();
    expect(replies).toEqual([]);
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's turn was taken over by input on this PC" });
  });

  it('an interrupt or an API error fails it with the reason', async () => {
    let d = await delivering();
    write(userLine(PROMPT), interruptLine());
    await d.tick();
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's turn was interrupted on this PC" });

    task = inboundTask();
    moves = [];
    d = await delivering();
    write(userLine(PROMPT), apiErrorLine('authentication_failed', 'Invalid API key'));
    await d.tick();
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's turn ended on an error: Invalid API key" });
    expect(replies).toEqual([]);
  });

  it('a usage-limit stop and the daemon\'s own continue keep the episode open; the same words without the stop do not', async () => {
    let d = await delivering();
    write(userLine(PROMPT), apiErrorLine('rate_limit', "You've hit your usage limit · resets 5pm"));
    await d.tick();
    expect(moves).toEqual([{ to: 'working' }]);
    write(userLine(USAGE_LIMIT_CONTINUE_PROMPT), assistantLine('PONG'));
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(['PONG']);

    task = inboundTask();
    moves = [];
    replies = [];
    d = await delivering();
    write(userLine(PROMPT), userLine(USAGE_LIMIT_CONTINUE_PROMPT));
    await d.tick();
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's turn was taken over by input on this PC" });
  });

  it('an agent that answered through its own tools after the task was typed in gets no second reply', async () => {
    const d = await delivering();
    task.history.push({ kind: 'message', messageId: 'own', role: 'agent', parts: [{ kind: 'text', text: 'PONG (via a2a)' }] });
    write(userLine(PROMPT), assistantLine('sent it'));
    await d.tick();
    expect(replies).toEqual([]);
    expect(moves).toEqual([{ to: 'working' }, { to: 'input-required' }]);
  });

  it('a reply that cannot be sent fails the task with why', async () => {
    replyError = 'link-inactive';
    const d = await delivering();
    write(userLine(PROMPT), assistantLine('x'.repeat(10)));
    await d.tick();
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's answer could not be sent: link-inactive" });
  });

  it('an answer over the body limit is cut: its start, then a marker, within the limit', async () => {
    const d = await delivering();
    const long = `RESULT first\n${'y'.repeat(40 * 1024)}`;
    write(userLine(PROMPT), assistantLine(long));
    await d.tick();
    expect(replies).toHaveLength(1);
    const sent = replies[0].text;
    expect(Buffer.byteLength(sent, 'utf8')).toBeLessThanOrEqual(A2A_REMOTE_BODY_MAX);
    expect(sent.startsWith('RESULT first\n')).toBe(true);
    expect(sent).toMatch(/\n\n\[… cut: \d+ bytes not sent\]$/);
    expect(moves.at(-1)).toEqual({ to: 'input-required' });
  });

  it('a subagent\'s entries (sidechain) neither end the turn nor count as input; the lead\'s own end does', async () => {
    const d = await delivering();
    const side = (o: object): string => JSON.stringify({ ...o, isSidechain: true });
    write(userLine(PROMPT), toolUseLine(),
      side({ type: 'user', uuid: 's1', timestamp: stamp(), message: { role: 'user', content: 'the subagent\'s brief' } }),
      side({ type: 'assistant', uuid: 's2', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: 'sub done' }], stop_reason: 'end_turn' } }));
    await d.tick();
    expect(replies).toEqual([]);
    expect(moves).toEqual([{ to: 'working' }]);
    write(toolResultLine(), assistantLine('the lead\'s answer'));
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(["the lead's answer"]);
    expect(moves.at(-1)).toEqual({ to: 'input-required' });
  });

  it('a move to working that failed is tried again (never by typing again), and the answer still ends it', async () => {
    let failWorking = true;
    const base = deps();
    const d = new HeadlessDelivery({
      ...base,
      transition: async (input) => {
        if (input.to === 'working' && failWorking) {
          failWorking = false;
          return { ok: false, error: 'ledger busy' };
        }
        return base.transition(input);
      },
    });
    await d.tick();
    expect(task.status.state).toBe('submitted');
    // The next pass moves it, with the turn still under way.
    await d.tick();
    expect(task.status.state).toBe('working');
    write(userLine(PROMPT), assistantLine('PONG'));
    await d.tick();
    expect(delivered).toHaveLength(1);
    expect(moves).toEqual([{ to: 'working' }, { to: 'input-required' }]);
    expect(replies.map((r) => r.text)).toEqual(['PONG']);
  });

  it('a move to input-required that failed, or a reply that threw, is tried again; the reply is sent once', async () => {
    let failMove = true;
    let throwReply = true;
    const base = deps();
    const d = new HeadlessDelivery({
      ...base,
      reply: async (input) => {
        if (throwReply) {
          throwReply = false;
          throw new Error('pipe closed');
        }
        return base.reply(input);
      },
      transition: async (input) => {
        if (input.to === 'input-required' && failMove) {
          failMove = false;
          return { ok: false, error: 'ledger busy' };
        }
        return base.transition(input);
      },
    });
    await d.tick();
    write(userLine(PROMPT), assistantLine('PONG'));
    await d.tick();
    expect(replies).toEqual([]);
    await d.tick();
    expect(replies.map((r) => r.text)).toEqual(['PONG']);
    expect(task.status.state).toBe('working');
    await d.tick();
    expect(task.status.state).toBe('input-required');
    await d.tick();
    expect(replies).toHaveLength(1);
  });

  it('a transcript replaced under it fails the episode', async () => {
    const d = await delivering();
    write(userLine(PROMPT));
    await d.tick();
    fs.writeFileSync(transcript, '');
    await d.tick();
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: "the agent's conversation was replaced on this PC" });
  });

  it('a start that ends fails its open task with why (a restart: "the daemon restarted"), and cancels an answered one', async () => {
    let d = await delivering();
    await d.startEnding(rec, 'the daemon restarted');
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: 'the daemon restarted' });
    // The episode is gone with it: a later turn end sends nothing.
    write(userLine(PROMPT), assistantLine('late'));
    await d.tick();
    expect(replies).toEqual([]);

    // Answered, waiting for more: canceled, with why.
    task = inboundTask();
    moves = [];
    d = await delivering();
    write(userLine(PROMPT), assistantLine('PONG'));
    await d.tick();
    expect(moves.at(-1)).toEqual({ to: 'input-required' });
    await d.startEnding(rec, "the agent's session ended");
    expect(moves.at(-1)).toEqual({ to: 'canceled', summary: "the agent ended: the agent's session ended" });
  });
});

describe('a question on the agent\'s screen', () => {
  const advance = async (d: HeadlessDelivery, ms: number): Promise<void> => {
    clock += ms;
    await d.tick();
  };

  it('before the task is typed in: the asker is told once at about a minute, and at 10 minutes the task is canceled; the agent is left as it is', async () => {
    results = Array(200).fill('busy');
    screen = 'dialog';
    const d = new HeadlessDelivery(deps());
    await d.tick();
    await advance(d, QUESTION_NOTICE_MS - 10_000);
    expect(replies).toEqual([]);
    await advance(d, 10_000);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ taskId: TASK, workspaceId: WS, ptyId: SESSION });
    expect(replies[0].text).toContain('waits on a question');
    for (let t = QUESTION_NOTICE_MS; t < QUESTION_TIMEOUT_MS - 10_000; t += 10_000) await advance(d, 10_000);
    expect(task.status.state).toBe('submitted');
    await advance(d, 10_000);
    expect(moves.at(-1)).toEqual({ to: 'canceled', summary: QUESTION_REASON });
    expect(replies).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  it('a screen that could not be read neither starts the clock nor resets it', async () => {
    results = Array(400).fill('busy');
    screen = 'unknown';
    const d = new HeadlessDelivery(deps());
    await d.tick();
    await advance(d, QUESTION_TIMEOUT_MS);
    expect(task.status.state).toBe('submitted');
    screen = 'dialog';
    await advance(d, 10_000);
    await advance(d, 5 * 60_000);
    // Unread for a minute, then the question again: the clock kept its start.
    screen = 'unknown';
    await advance(d, 60_000);
    screen = 'dialog';
    await advance(d, QUESTION_TIMEOUT_MS - 6 * 60_000);
    expect(moves.at(-1)).toEqual({ to: 'canceled', summary: QUESTION_REASON });
  });

  it('a screen with no question resets the clock', async () => {
    results = Array(400).fill('busy');
    screen = 'dialog';
    const d = new HeadlessDelivery(deps());
    await d.tick();
    await advance(d, 5 * 60_000);
    screen = 'clear';
    await advance(d, 10_000);
    screen = 'dialog';
    await advance(d, 10_000);
    // 9 min 50 s after the question came back: still open; at 10 min it ends.
    await advance(d, QUESTION_TIMEOUT_MS - 10_000);
    expect(task.status.state).toBe('submitted');
    await advance(d, 10_000);
    expect(moves.at(-1)).toEqual({ to: 'canceled', summary: QUESTION_REASON });
  });

  it('inside the turn: failed at 10 minutes with the reason; the notice is not taken for the agent answering itself', async () => {
    const d = new HeadlessDelivery(deps());
    await d.tick();
    expect(moves).toEqual([{ to: 'working' }]);
    write(userLine(PROMPT));
    screen = 'dialog';
    await advance(d, 10_000);
    await advance(d, QUESTION_NOTICE_MS);
    expect(replies).toHaveLength(1);
    // Answered on this PC after all: the turn ends and its answer is still sent.
    screen = 'clear';
    write(assistantLine('PONG'));
    await advance(d, 10_000);
    expect(replies.map((r) => r.text).at(-1)).toBe('PONG');
    expect(moves.at(-1)).toEqual({ to: 'input-required' });

    // Another start, a question that stays.
    task = inboundTask();
    moves = [];
    replies = [];
    const d2 = new HeadlessDelivery(deps());
    await d2.tick();
    write(userLine(PROMPT));
    screen = 'dialog';
    await advance(d2, 10_000);
    for (let t = 0; t < QUESTION_TIMEOUT_MS; t += 10_000) await advance(d2, 10_000);
    expect(moves.at(-1)).toEqual({ to: 'failed', summary: QUESTION_REASON });
    // The episode is gone: a late turn end sends nothing more.
    write(assistantLine('late'));
    await advance(d2, 10_000);
    expect(replies.map((r) => r.text)).not.toContain('late');
  });
});

it('cutReply keeps the start, cuts on a code point, and counts the marker in the limit', () => {
  expect(cutReply('short')).toBe('short');
  const max = 64;
  // 3-byte characters: a straddling one is left out whole.
  const euros = '€'.repeat(40);
  const cut = cutReply(euros, max);
  expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(max);
  expect(cut).not.toContain('\uFFFD');
  const [kept, marker] = cut.split('\n\n');
  expect(/^€+$/.test(kept)).toBe(true);
  const left = Number(/cut: (\d+) bytes/.exec(marker)![1]);
  expect(Buffer.byteLength(kept, 'utf8') + left).toBe(Buffer.byteLength(euros, 'utf8'));
  // A pair of surrogates (4 bytes) is not split either.
  const faces = '😀'.repeat(40);
  const cut2 = cutReply(faces, max);
  expect(Buffer.byteLength(cut2, 'utf8')).toBeLessThanOrEqual(max);
  expect(/^(😀)+$/u.test(cut2.split('\n\n')[0])).toBe(true);
});

it('assistantTextOf reads the text blocks of a raw entry, code included', () => {
  expect(assistantTextOf(assistantLine('a\n```ts\nconst x = 1;\n```', true, [{ type: 'thinking', thinking: 'no' }]))).toBe('a\n```ts\nconst x = 1;\n```');
  expect(assistantTextOf(toolUseLine())).toBeNull();
  expect(assistantTextOf('not json')).toBeNull();
});
