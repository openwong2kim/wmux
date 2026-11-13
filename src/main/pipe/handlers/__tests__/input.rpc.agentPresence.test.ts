// Deliveries wait for a verified agent process. Every caller that types on
// someone's behalf goes through main's gated submit, which asks the daemon
// (daemon.deliveryPresence) before anything is written, after a fresh-context
// step, and right before the Enter, ahead of the faster checks at each point. A pane whose agent is gone, whatever its
// title still says, gets zero bytes on every path.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { GatedSubmitOptions, GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import type { DeliveryPresence } from '../../../../shared/deliveryPresence';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import { registerDeliveryCheck } from '../../deliveryGuards';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const FREE = '⏺ Done.\n\n──────────\n❯ ';
const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude' };
const ENDED: DeliveryPresence = { tier: 'none', reason: 'agent-ended' };

let clock: number;
let writes: string[];
let logs: string[];
/** The daemon's answers, one per ask, the last repeated. */
let answers: Array<DeliveryPresence | undefined>;
let asked: Array<{ ptyId: string; expectAgent: string | undefined }>;
/** The order of the presence asks and the approval-gate reads. */
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
      deliveryPresence: async (ptyId, expectAgent) => {
        asked.push({ ptyId, expectAgent });
        order.push('presence');
        return answers.length > 1 ? answers.shift() : answers[0];
      },
      readScreenText: async () => FREE,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: (line: string) => logs.push(line),
    },
  );
}

const deliver = (opts?: GatedSubmitOptions, agent: string | null = 'Claude Code'): Promise<GatedSubmitResult> =>
  harness().gatedSubmit('pty-a', 'hello', agent, opts);

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
  ['a remote reply (no sender record, no wait)', () => undefined],
  ['a remote new task', () => ({ newTask: true, taskId: 't-r', waitQuiet: true, deadlineAt: clock + 42_000 })],
  ['a mention nudge, pane-pinned', () => ({ senderMentions: [{ channelId: 'c', seq: 3 }] })],
  ['a Git page hand-off', () => ({ newTask: true, taskId: 't-h', waitQuiet: true, expectAgent: 'Claude Code', deadlineAt: clock + 42_000 })],
  ['a worker report nudge (Moa)', () => ({ waitQuiet: true, deadlineAt: clock + 120_000, guardKey: 'moa-1' })],
];

describe('deliveries wait for a verified agent process', () => {
  for (const [name, opts] of PATHS) {
    it(`${name}: a pane whose agent ended gets zero bytes`, async () => {
      const unregister = registerDeliveryCheck('moa-1', { beforePaste: () => null, beforeEnter: () => null });
      answers = [ENDED];
      const res = await deliver(opts());
      unregister();
      expect(res).toMatchObject({ ok: false, reason: 'agent_unverified' });
      expect(writes).toEqual([]);
    });
  }

  it('a tracked agent process gets the paste and the Enter, asked before the paste and before the Enter', async () => {
    expect(await deliver({ senderTaskIds: ['t-1'] })).toEqual({ ok: true });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toEqual({ ptyId: 'pty-a', expectAgent: 'claude' });
  });

  it('asks before the approval gate at each point, so the fast checks are the fresh ones', async () => {
    await deliver({ senderTaskIds: ['t-1'] });
    const lastPresence = order.lastIndexOf('presence');
    expect(lastPresence).toBeGreaterThan(0);
    expect(order.slice(lastPresence + 1)).toContain('gate');
    expect(order[0]).toBe('presence');
  });

  it('an agent that dies between the paste and the Enter gets no Enter, and the paste is taken back', async () => {
    answers = [PROCESS, ENDED];
    const res = await deliver({ senderTaskIds: ['t-1'] });
    expect(res).toMatchObject({ ok: false, reason: 'agent_unverified', pasted: true, cleared: true });
    expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\x15']);
  });

  it('a new task to a pane at a shell: no fresh-context command either', async () => {
    answers = [{ tier: 'none', reason: 'shell-at-prompt' }];
    await deliver({ newTask: true, taskId: 't-1' });
    expect(writes).toEqual([]);
  });

  it('an unanswerable daemon, or a malformed answer, writes nothing', async () => {
    answers = [undefined];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ reason: 'agent_unverified' });
    answers = [{ tier: 'screen' } as unknown as DeliveryPresence];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ reason: 'agent_unverified' });
    expect(writes).toEqual([]);
  });

  it('a pane verified from its screen (no process attributed) is typed into, and logged as such', async () => {
    answers = [{ tier: 'screen', slug: 'claude' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toEqual({ ok: true });
    expect(logs.some((l) => l.includes('verified from its screen'))).toBe(true);
  });

  it('the refusal says why in plain words', async () => {
    answers = [{ tier: 'none', reason: 'not-foreground' }];
    const res = await deliver({ senderTaskIds: ['t-1'] });
    expect(res).toMatchObject({ detail: expect.stringContaining('not in the foreground') });
  });

  it('another agent than the one addressed is a replaced occupant (agent_changed), not a missing one', async () => {
    answers = [{ tier: 'none', reason: 'other-agent' }];
    expect(await deliver({ senderTaskIds: ['t-1'] })).toMatchObject({ ok: false, reason: 'agent_changed' });
    expect(writes).toEqual([]);
  });

  it('asks for the agent the delivery was addressed to', async () => {
    await deliver({ senderTaskIds: ['t-1'] }, 'Codex CLI');
    expect(asked[0].expectAgent).toBe('codex');
    await deliver(undefined, null);
    expect(asked.at(-1)?.expectAgent).toBeUndefined();
  });
});
