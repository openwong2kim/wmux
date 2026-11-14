// Deliveries wait for a verified agent in plain input mode. Every caller that
// types on someone's behalf goes through main's gated submit, which asks the
// daemon (daemon.deliveryPresence) before anything is written and as the last
// step before the Enter. A pane whose agent is gone, or whose input box is not
// a plain prompt, gets zero bytes on every path.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { NO_BACKGROUND_SERVICE, registerInputRpc } from '../input.rpc';
import type { GatedSubmitOptions, GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import type { DeliveryCheck, DeliveryPresence } from '../../../../shared/deliveryPresence';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import { registerDeliveryCheck } from '../../deliveryGuards';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const FREE = '⏺ Done.\n\n──────────\n❯ ';
const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };
const ENDED: DeliveryPresence = { tier: 'none', reason: 'agent-ended' };
const BANG: DeliveryPresence = { tier: 'none', reason: 'composer-mode' };
const POINTER_ONLY: DeliveryPresence = { tier: 'process', slug: 'gemini', input: 'pointer', bracketedPaste: true };

let clock: number;
let writes: string[];
let logs: string[];
/** The daemon's answers, one per ask, the last repeated. */
let answers: Array<DeliveryPresence | undefined>;
let asked: Array<{ ptyId: string; expectAgent: string | undefined; check: DeliveryCheck }>;
/** The order of the presence asks, the approval-gate reads and the writes. */
let order: string[];

function harness() {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => {
      if (method === 'daemon.approvals.list') order.push('gate');
      return method === 'daemon.approvals.list' ? { pending: [] } : { ok: true };
    },
    writeToSession: (_id: string, data: string) => {
      writes.push(data);
      order.push(`write:${JSON.stringify(data)}`);
      return true;
    },
    getAgentState: async () => ({
      agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
      inputQuiet: true, inputRevision: 1, hasDraft: false, keyInputIdleMs: 60_000, keyInputRevision: writes.length,
    }),
  };
  return registerInputRpc(
    new RpcRouter(),
    { get: () => undefined } as unknown as PTYManager,
    () => ({}) as BrowserWindow,
    () => dc as never,
    undefined,
    undefined,
    {
      answerPolicy: async () => ({ allowed: false, reason: 'autonomy-off' }),
      deliveryPresence: async (ptyId, expectAgent, check) => {
        asked.push({ ptyId, expectAgent, check });
        order.push(`presence:${check.phase}`);
        return answers.length > 1 ? answers.shift() : answers[0];
      },
      readScreenText: async () => FREE,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: (line: string) => logs.push(line),
    },
  );
}

const deliver = (opts?: GatedSubmitOptions, agent: string | null = 'Claude Code', text = 'hello'): Promise<GatedSubmitResult> =>
  harness().gatedSubmit('pty-a', text, agent, opts);

beforeEach(() => {
  clock = 1_000_000;
  writes = [];
  logs = [];
  answers = [PROCESS];
  asked = [];
  order = [];
});

/** Every caller of the shared write path, by the options it sends. */
const PATHS: Array<[string, () => GatedSubmitOptions | undefined]> = [
  ['a local new task', () => ({ newTask: true, taskId: 't-1', senderSendKey: 'k' })],
  ['a local reply', () => ({ senderTaskIds: ['t-1'] })],
  ['a remote reply', () => ({ pointerTaskId: 'rt-1' })],
  ['a remote new task', () => ({ newTask: true, taskId: 't-r', waitQuiet: true, deadlineAt: clock + 42_000 })],
  ['a mention nudge, pane-pinned', () => ({ senderMentions: [{ channelId: 'c', seq: 3 }] })],
  ['a Git page hand-off', () => ({ newTask: true, taskId: 't-h', waitQuiet: true, expectAgent: 'Claude Code', deadlineAt: clock + 42_000 })],
  ['a worker report nudge (Moa)', () => ({ waitQuiet: true, deadlineAt: clock + 120_000, guardKey: 'moa-1' })],
];

describe('deliveries wait for a verified agent in plain input mode', () => {
  for (const [name, opts] of PATHS) {
    it(`${name}: a pane whose agent ended gets zero bytes`, async () => {
      const unregister = registerDeliveryCheck('moa-1', { beforePaste: () => null, beforeEnter: () => null });
      answers = [ENDED];
      const res = await deliver(opts());
      unregister();
      expect(res).toMatchObject({ ok: false, reason: 'agent_unverified' });
      expect(writes).toEqual([]);
    });

    it(`${name}: an agent whose input box is in shell mode gets zero bytes`, async () => {
      const unregister = registerDeliveryCheck('moa-1', { beforePaste: () => null, beforeEnter: () => null });
      answers = [BANG];
      const res = await deliver(opts());
      unregister();
      expect(res).toMatchObject({ ok: false, reason: 'input_mode' });
      expect(writes).toEqual([]);
    });
  }

  it('a verified agent in plain input mode gets the paste and the Enter, asked before the paste and before the Enter', async () => {
    expect(await deliver({ senderTaskIds: ['t-1'] })).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
    expect(asked.map((a) => a.check.phase)).toEqual(['paste', 'paste', 'enter']);
    expect(asked[0].expectAgent).toBe('claude');
    expect(asked[2].check.shownProbe).toBe('hello');
    // The whole text too: an uncollapsed paste must be the box's entire input.
    expect(asked[2].check.shownText).toBe('hello');
  });

  it('the ask is the first step, the last one before the paste, and the last one before the Enter', async () => {
    const unregister = registerDeliveryCheck('moa-1', { beforePaste: () => null, beforeEnter: () => null });
    await deliver({ waitQuiet: true, deadlineAt: clock + 120_000, guardKey: 'moa-1' });
    unregister();
    expect(order[0]).toBe('presence:paste');
    const paste = order.findIndex((step) => step.startsWith('write:"\\u001b[200~'));
    expect(order[paste - 1]).toBe('presence:paste');
    expect(order.slice(-2)).toEqual(['presence:enter', 'write:"\\r"']);
  });

  it('what is typed, and how, comes from the answer right before the paste', async () => {
    // Bracketed paste on at the first ask; the pane turned it off by the paste.
    answers = [PROCESS, { ...PROCESS, bracketedPaste: false }];
    expect(await deliver({ senderTaskIds: ['t-1'] }, 'Claude Code', 'line one\nline two')).toMatchObject({ ok: false, reason: 'input_mode' });
    expect(writes).toEqual([]);
    // The agent died during the slower checks before the paste.
    answers = [PROCESS, ENDED];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'agent_unverified' });
    expect(writes).toEqual([]);
  });

  it('a check that has no answer yet (a probe running, an unread foreground) is held for a retry, not "no agent"', async () => {
    answers = [{ tier: 'none', reason: 'attribution-pending' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'gate_unavailable' });
    answers = [{ tier: 'none', reason: 'foreground-unknown' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'gate_unavailable' });
    expect(writes).toEqual([]);
  });

  it('waiting for quiet while the agent dies: the screen is a prompt, nothing is written', async () => {
    // The daemon's cached name still says claude; its fresh answer does not.
    answers = [ENDED];
    const res = await deliver({ newTask: true, taskId: 't-h', waitQuiet: true, expectAgent: 'Claude Code', deadlineAt: clock + 42_000 });
    expect(res).toMatchObject({ ok: false });
    expect(writes).toEqual([]);
  });

  it('an agent that dies between the paste and the Enter: no Enter, and the paste is taken back only while the pane shows it', async () => {
    answers = [PROCESS, PROCESS, { tier: 'none', reason: 'agent-ended', pasteShown: true }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'agent_unverified', pasted: true, cleared: true });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\x15']);

    writes = [];
    answers = [PROCESS, PROCESS, { tier: 'none', reason: 'agent-ended' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, pasted: true, cleared: false });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~']);
  });

  it('a leftover draft holds; nothing of it is touched', async () => {
    answers = [{ tier: 'none', reason: 'composer-busy' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'input_mode' });
    expect(writes).toEqual([]);
  });

  it('a new task to a pane with no agent: no fresh-context command either', async () => {
    answers = [{ tier: 'none', reason: 'shell-at-prompt' }];
    await deliver({ newTask: true, taskId: 't-1' });
    expect(writes).toEqual([]);
  });

  it('a daemon that cannot answer (none, an older one, a timeout) or a malformed answer: held for a retry, nothing written', async () => {
    answers = [undefined];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ reason: 'gate_unavailable' });
    answers = [{ tier: 'screen' } as unknown as DeliveryPresence];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ reason: 'gate_unavailable' });
    expect(writes).toEqual([]);
  });

  it('no background service to ask: held, and the sender is told so in plain words', async () => {
    answers = [NO_BACKGROUND_SERVICE as unknown as DeliveryPresence];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({
      ok: false, reason: 'gate_unavailable', detail: expect.stringContaining("this PC's wmux is running without its background service"),
    });
    expect(writes).toEqual([]);
  });

  it('a pane verified from its screen (no process attributed) is typed into, and logged as such', async () => {
    answers = [{ ...PROCESS, tier: 'screen' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toEqual({ ok: true });
    expect(logs.some((l) => l.includes('verified from its screen'))).toBe(true);
  });

  it('the refusal says why in plain words', async () => {
    answers = [{ tier: 'none', reason: 'not-foreground' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ detail: expect.stringContaining('not in the foreground') });
  });

  it('asks for the agent the delivery was addressed to', async () => {
    await deliver({ senderTaskIds: ['t-1'] }, 'Codex CLI');
    expect(asked[0].expectAgent).toBe('codex');
    await deliver(undefined, null);
    expect(asked.at(-1)?.expectAgent).toBeUndefined();
  });

  it('another agent than the one addressed is a replaced occupant (agent_changed), not a missing one', async () => {
    answers = [{ tier: 'none', reason: 'other-agent' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'agent_changed' });
    expect(writes).toEqual([]);
  });
});

describe('an agent whose plain prompt wmux does not know: its pointer line only', () => {
  const BODY = '━━━ WMUX A2A ━━━\nFrom: x(claude)\n│ $(rm -rf ~)\n━━━ END ━━━';

  it('a task: the pointer, never the body or the envelope', async () => {
    answers = [POINTER_ONLY];
    expect(await deliver({ senderTaskIds: ['task-1'] }, 'Gemini CLI', BODY)).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~wmux: A2A task task-1 is waiting for you. Read it with a2a_task_query task_id task-1\x1b[201~', '\r']);
  });

  it('a mention: the channel pointer', async () => {
    answers = [POINTER_ONLY];
    await deliver({ senderMentions: [{ channelId: 'ch-1', seq: 7 }] }, null, BODY);
    expect(writes[0]).toContain('wmux: channel ch-1 has a mention for you. Read it with wmux channel read ch-1 --since 7');
  });

  it('a batch: the earliest mention of one channel, or the command that lists every channel', async () => {
    answers = [POINTER_ONLY];
    await deliver({ senderMentions: [{ channelId: 'ch-1', seq: 9 }, { channelId: 'ch-1', seq: 5 }] }, null, BODY);
    expect(writes[0]).toContain('wmux channel read ch-1 --since 5');
    writes = [];
    await deliver({ senderMentions: [{ channelId: 'ch-1', seq: 5 }, { channelId: 'ch-2', seq: 3 }] }, null, BODY);
    expect(writes[0]).toContain('wmux: channels have mentions for you. List them with wmux channel unread');
    writes = [];
    await deliver({ senderTaskIds: ['t-1', 't-2'] }, null, BODY);
    expect(writes[0]).toContain('wmux: A2A tasks are waiting for you. Read them with a2a_task_query');
  });

  it('nothing to point at: held, zero bytes', async () => {
    answers = [POINTER_ONLY];
    expect(await deliver(undefined, null, BODY)).toMatchObject({ ok: false, reason: 'input_mode' });
    expect(writes).toEqual([]);
  });

  // A blank text pastes nothing the Enter could be checked against, and a
  // bare Enter would send whatever the box already holds.
  it('a blank text is refused before anything is asked or written', async () => {
    for (const text of ['', '   ', '\n\n', '\t \x1b\x03']) {
      asked = [];
      expect(await deliver({ newTask: true, taskId: 't-1', senderSendKey: 'k' }, 'Claude Code', text)).toMatchObject({ ok: false, reason: 'input_mode' });
      expect(asked).toEqual([]);
      expect(writes).toEqual([]);
    }
  });

  // A paste keeps a tab (only ESC is made visible); as plain keys a tab would
  // be a key press (completion in most prompts), so it goes as a space.
  it('a tab stays a tab in a bracketed paste and goes as a space in plain keys', async () => {
    await deliver({ senderTaskIds: ['task-1'] }, 'Claude Code', 'a\tb');
    expect(writes[0]).toBe('\x1b[200~a\tb\x1b[201~');
    writes = [];
    answers = [{ ...PROCESS, bracketedPaste: false }];
    await deliver({ senderTaskIds: ['task-1'] }, 'Claude Code', 'a\tb');
    expect(writes[0]).toBe('a b');
  });

  it('plain keys (no bracketed paste) carry printable text only', async () => {
    answers = [{ ...PROCESS, bracketedPaste: false }];
    await deliver({ senderTaskIds: ['task-1'] }, 'Claude Code', 'hi\x03there\x1b[2J\tx\x7f\x9b\x04!');
    expect(writes[0]).toBe('hithere[2J x!');
    // eslint-disable-next-line no-control-regex -- checking control characters are gone
    expect(writes[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it('plain keys keep printable text in any script (Hangul, CJK, emoji)', async () => {
    answers = [{ ...PROCESS, bracketedPaste: false }];
    await deliver({ senderTaskIds: ['task-1'] }, 'Claude Code', '작업 완료\x07 — 検証 ✅ 다음 단계');
    expect(writes[0]).toBe('작업 완료 — 検証 ✅ 다음 단계');
  });

  it('the Enter goes only to the grant the paste had: another agent or another way of taking text gets none', async () => {
    answers = [PROCESS, PROCESS, POINTER_ONLY];
    expect(await deliver({ senderTaskIds: ['task-1'] }, null, BODY)).toMatchObject({ ok: false, reason: 'agent_changed', pasted: true, cleared: false });
    expect(writes).toHaveLength(1);
  });

  it('how the pane takes a paste is not part of the grant at the Enter: the paste is written, the Enter is a bare \\r', async () => {
    answers = [PROCESS, PROCESS, { ...PROCESS, bracketedPaste: false }];
    expect(await deliver({ senderTaskIds: ['task-1'] })).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
  });

  it('an agent just starting: an Enter-time answer that may be a moment is asked again before the Enter is refused', async () => {
    // The input box does not show the paste yet, then does.
    answers = [PROCESS, PROCESS, { tier: 'none', reason: 'composer-busy' }, { tier: 'none', reason: 'composer-busy' }, PROCESS];
    expect(await deliver({ senderTaskIds: ['task-1'] })).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
    expect(asked.filter((a) => a.check.phase === 'enter')).toHaveLength(3);
  });

  it('the grace is bounded: four more asks, then the refusal stands, logged once', async () => {
    const start = clock;
    answers = [PROCESS, PROCESS, { tier: 'none', reason: 'attribution-pending' }];
    expect(await deliver({ senderTaskIds: ['task-1'] })).toMatchObject({ ok: false, reason: 'gate_unavailable', pasted: true, cleared: false, pasteShown: false });
    expect(asked.filter((a) => a.check.phase === 'enter')).toHaveLength(5);
    expect(clock - start).toBeGreaterThanOrEqual(4 * 150);
    expect(writes).not.toContain('\r');
    expect(logs.filter((l) => l.includes('pasted, not submitted'))).toHaveLength(1);
  });

  it('a verdict is not a moment: no grace for an ended agent, and the paste is taken back while it shows', async () => {
    answers = [PROCESS, PROCESS, { tier: 'none', reason: 'agent-ended', pasteShown: true }];
    expect(await deliver({ senderTaskIds: ['task-1'] })).toMatchObject({ ok: false, pasted: true, cleared: true, pasteShown: true });
    expect(asked.filter((a) => a.check.phase === 'enter')).toHaveLength(1);
  });

  it('a pane without bracketed paste gets the line as plain keys (no markers); a text of several lines is held', async () => {
    answers = [{ ...POINTER_ONLY, bracketedPaste: false }];
    await deliver({ senderTaskIds: ['task-1'] }, null, BODY);
    expect(writes[0]).toBe('wmux: A2A task task-1 is waiting for you. Read it with a2a_task_query task_id task-1');

    writes = [];
    answers = [{ ...PROCESS, bracketedPaste: false }];
    expect(await deliver({ senderTaskIds: ['task-1'] }, 'Claude Code', BODY)).toMatchObject({ ok: false, reason: 'input_mode' });
    expect(writes).toEqual([]);
  });
});
