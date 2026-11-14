// One delivery at a time into a pane. Two deliveries that arrived together
// both found the agent's input box empty, both pasted, and each then refused
// its Enter because the box held more than its own text, so neither was ever
// submitted. Every gated delivery now holds its pane from its first check
// before the paste through its Enter (or its refusal and take-back).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import { paneDeliveryLocksForTest } from '../freshContext';
import type { GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import type { DeliveryCheck, DeliveryPresence } from '../../../../shared/deliveryPresence';
import type { RoleBinding } from '../../../../shared/orchestratorRole';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const FREE = '⏺ Done.\n\n──────────\n❯ ';
const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };

let clock: number;
/** Every write, with its pane. */
let writes: Array<{ ptyId: string; data: string }>;
/** Every presence ask, with its pane, in the order asked. */
let asked: Array<{ ptyId: string; phase: DeliveryCheck['phase'] }>;
/** The answer for each ask; a test may hold an ask until it is let go. */
let answer: (ptyId: string, check: DeliveryCheck) => Promise<DeliveryPresence | undefined>;
let writeOk: (ptyId: string) => boolean;
/** Reads of the pane's agent state (a hand-off reads its key count first). */
let agentReads: number;
/** Keys a person typed into the pane, on top of the deliveries' own writes. */
let personKeys: number;
/** The next agent-state read shows a draft in the input box (one read only). */
let draftOnNextRead: boolean;
/** Runs after each write that went through. */
let afterWrite: (data: string) => void;

function harness(lockWaitMs?: number, binding?: RoleBinding) {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (ptyId: string, data: string) => {
      if (!writeOk(ptyId)) return false;
      writes.push({ ptyId, data });
      afterWrite(data);
      return true;
    },
    getAgentState: async () => {
      agentReads++;
      const hasDraft = draftOnNextRead;
      draftOnNextRead = false;
      return {
        agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
        inputQuiet: true, inputRevision: 1, hasDraft, keyInputIdleMs: 60_000, keyInputRevision: writes.length + personKeys,
      };
    },
  };
  return registerInputRpc(
    new RpcRouter(),
    { get: () => undefined } as unknown as PTYManager,
    () => ({}) as BrowserWindow,
    () => dc as never,
    binding ? async () => binding : undefined,
    undefined,
    {
      answerPolicy: async () => ({ allowed: false, reason: 'autonomy-off' }),
      deliveryPresence: async (ptyId, _expect, check) => {
        asked.push({ ptyId, phase: check.phase });
        return answer(ptyId, check);
      },
      readScreenText: async () => FREE,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: () => undefined,
      ...(lockWaitMs !== undefined ? { freshContextLockWaitMs: lockWaitMs } : {}),
      ...(binding ? { queryDaemonTasks: async () => [] } : {}),
    },
  );
}

const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;
const on = (ptyId: string): string[] => writes.filter((w) => w.ptyId === ptyId).map((w) => w.data);

beforeEach(() => {
  clock = 1_000_000;
  writes = [];
  asked = [];
  answer = async () => PROCESS;
  writeOk = () => true;
  agentReads = 0;
  personKeys = 0;
  draftOnNextRead = false;
  afterWrite = () => undefined;
});

describe('one delivery at a time into a pane', () => {
  it('two deliveries fired together: the first pastes and submits, then the second, in order, nothing left over', async () => {
    const rpc = harness();
    const [a, b] = await Promise.all([
      rpc.gatedSubmit('pty-a', 'first', 'Claude Code', { senderTaskIds: ['t-1'] }),
      rpc.gatedSubmit('pty-a', 'second', 'Claude Code', { senderTaskIds: ['t-1'] }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(on('pty-a')).toEqual([paste('first'), '\r', paste('second'), '\r']);
  });

  it('three deliveries fired together all submit, in the order they arrived', async () => {
    const rpc = harness();
    const results = await Promise.all(['one', 'two', 'three'].map((text) =>
      rpc.gatedSubmit('pty-a', text, 'Claude Code', { senderMentions: [{ channelId: 'c', seq: 1 }] })));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(on('pty-a')).toEqual([paste('one'), '\r', paste('two'), '\r', paste('three'), '\r']);
  });

  it("the second delivery's first check runs only after the first one's Enter", async () => {
    const rpc = harness();
    await Promise.all([
      rpc.gatedSubmit('pty-a', 'first', 'Claude Code'),
      rpc.gatedSubmit('pty-a', 'second', 'Claude Code'),
    ]);
    // Each delivery asks before the paste (twice) and before the Enter.
    expect(asked.map((x) => x.phase)).toEqual(['paste', 'paste', 'enter', 'paste', 'paste', 'enter']);
  });

  it('a first delivery refused at the Enter and taken back: the second then finds an empty box and submits', async () => {
    let n = 0;
    answer = async () => (++n === 3 ? { tier: 'none', reason: 'agent-ended', pasteShown: true } : PROCESS);
    const rpc = harness();
    const [a, b] = await Promise.all([
      rpc.gatedSubmit('pty-a', 'first', 'Claude Code'),
      rpc.gatedSubmit('pty-a', 'second', 'Claude Code'),
    ]);
    expect(a).toMatchObject({ ok: false, reason: 'agent_unverified', pasted: true, cleared: true });
    expect(b).toEqual({ ok: true });
    // The take-back (Ctrl+U) comes before the second paste.
    expect(on('pty-a')).toEqual([paste('first'), '\x15', paste('second'), '\r']);
  });

  it('different panes do not wait for each other', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    answer = async (ptyId) => {
      if (ptyId === 'pty-a') await held;
      return PROCESS;
    };
    const rpc = harness();
    const a = rpc.gatedSubmit('pty-a', 'slow', 'Claude Code');
    const b = await rpc.gatedSubmit('pty-b', 'fast', 'Claude Code');
    expect(b).toEqual({ ok: true });
    expect(on('pty-b')).toEqual([paste('fast'), '\r']);
    expect(on('pty-a')).toEqual([]);
    letGo();
    expect(await a).toEqual({ ok: true });
  });

  it('a waiter past the wait writes nothing and answers fresh_context_busy; the pane is free again afterwards', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    const rpc = harness(20);
    const a = rpc.gatedSubmit('pty-a', 'first', 'Claude Code');
    const b: GatedSubmitResult = await rpc.gatedSubmit('pty-a', 'second', 'Claude Code');
    expect(b).toMatchObject({ ok: false, reason: 'fresh_context_busy' });
    expect(b.ok === false && b.detail).toMatch(/another delivery is still running on this pane/);
    expect(on('pty-a')).toEqual([]);
    letGo();
    expect(await a).toEqual({ ok: true });
    // The timed-out waiter gave up its place: the next delivery runs.
    expect(await rpc.gatedSubmit('pty-a', 'third', 'Claude Code')).toEqual({ ok: true });
    expect(on('pty-a')).toEqual([paste('first'), '\r', paste('third'), '\r']);
  });

  it('the pane is released when a delivery throws', async () => {
    let n = 0;
    answer = async () => {
      if (++n === 1) throw new Error('daemon gone mid-check');
      return PROCESS;
    };
    const rpc = harness(50);
    const a = await rpc.gatedSubmit('pty-a', 'first', 'Claude Code').catch((err: unknown) => err);
    expect(a).toBeDefined();
    expect(await rpc.gatedSubmit('pty-a', 'second', 'Claude Code')).toEqual({ ok: true });
  });

  it("a hand-off that waited behind another delivery does not read that delivery's keys as a person typing", async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    const rpc = harness();
    const mention = rpc.gatedSubmit('pty-a', 'nudge', 'Claude Code', { senderMentions: [{ channelId: 'c', seq: 1 }] });
    // The hand-off reads its key count before it queues for the pane.
    const handOff = rpc.gatedSubmit('pty-a', 'hand-off', 'Claude Code', { waitQuiet: true, deadlineAt: clock + 120_000 });
    await vi.waitFor(() => expect(agentReads).toBeGreaterThan(0), { timeout: 5_000 });
    letGo();
    expect(await mention).toEqual({ ok: true });
    expect(await handOff).toEqual({ ok: true });
    expect(on('pty-a')).toEqual([paste('nudge'), '\r', paste('hand-off'), '\r']);
  });

  it('a hand-off that waited behind another delivery still refuses a draft a person started meanwhile', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    // Right after the mention's Enter a person types one key: the next read
    // (the hand-off's, once it holds the pane) shows their draft. The read
    // after it no longer does, so only the kept key count can refuse.
    afterWrite = (data) => {
      if (data !== '\r' || personKeys > 0) return;
      personKeys = 1;
      draftOnNextRead = true;
    };
    const rpc = harness();
    const mention = rpc.gatedSubmit('pty-a', 'nudge', 'Claude Code', { senderMentions: [{ channelId: 'c', seq: 1 }] });
    const handOff = rpc.gatedSubmit('pty-a', 'hand-off', 'Claude Code', { waitQuiet: true, deadlineAt: clock + 120_000 });
    await vi.waitFor(() => expect(agentReads).toBeGreaterThan(0), { timeout: 5_000 });
    letGo();
    expect(await mention).toEqual({ ok: true });
    expect(await handOff).toMatchObject({ ok: false, reason: 'user_typing' });
    expect(on('pty-a')).toEqual([paste('nudge'), '\r']);
  });

  it('a new-task hand-off that gets the pane past its deadline stops before its fresh-context step', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    // The pane's role asks for a fresh conversation per task: a step that ran
    // would type `/clear`.
    const rpc = harness(50, { agent: 'claude', freshContext: true });
    const holder = rpc.gatedSubmit('pty-d', 'first', 'Claude Code');
    const handOff = rpc.gatedSubmit('pty-d', 'task', 'Claude Code', { waitQuiet: true, newTask: true, deadlineAt: clock + 30_000 });
    await vi.waitFor(() => expect(agentReads).toBeGreaterThan(0), { timeout: 5_000 });
    // The holder outlasts the hand-off's deadline.
    clock += 60_000;
    letGo();
    expect(await holder).toEqual({ ok: true });
    expect(await handOff).toMatchObject({ ok: false, reason: 'deadline' });
    // Only the holder's three checks: the hand-off asked nothing and wrote
    // nothing, `/clear` included.
    expect(asked).toHaveLength(3);
    expect(on('pty-d')).toEqual([paste('first'), '\r']);
    expect(on('pty-d')).not.toContain('/clear');
  });

  it('a hand-off never waits for the pane past its deadline, even when the plain wait is longer', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    const rpc = harness(60_000);
    const holder = rpc.gatedSubmit('pty-e', 'first', 'Claude Code');
    const handOff = await rpc.gatedSubmit('pty-e', 'task', 'Claude Code', { waitQuiet: true, deadlineAt: clock + 30 });
    expect(handOff).toMatchObject({ ok: false, reason: 'fresh_context_busy' });
    expect(on('pty-e')).toEqual([]);
    letGo();
    expect(await holder).toEqual({ ok: true });
  });

  it('a plain delivery and a new task on one pane go one after the other, whichever came first', async () => {
    for (const order of [['plain', 'new'], ['new', 'plain']] as const) {
      writes = [];
      const rpc = harness();
      const send = (kind: 'plain' | 'new') => (kind === 'new'
        ? rpc.gatedSubmit('pty-n', 'task', 'Claude Code', { newTask: true })
        : rpc.gatedSubmit('pty-n', 'reply', 'Claude Code', { senderTaskIds: ['t-1'] }));
      const [a, b] = await Promise.all(order.map(send));
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      const text = (kind: 'plain' | 'new') => (kind === 'new' ? 'task' : 'reply');
      expect(on('pty-n')).toEqual([paste(text(order[0])), '\r', paste(text(order[1])), '\r']);
    }
    expect(paneDeliveryLocksForTest()).not.toContain('pty-n');
  });

  it('a hand-off with a deadline of its own waits for the pane past the plain wait', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    const rpc = harness(20);
    const a = rpc.gatedSubmit('pty-a', 'first', 'Claude Code');
    const handOff = rpc.gatedSubmit('pty-a', 'hand-off', 'Claude Code', { waitQuiet: true, deadlineAt: clock + 120_000 });
    // A plain delivery keeps the plain wait and gives up first.
    expect(await rpc.gatedSubmit('pty-a', 'plain', 'Claude Code')).toMatchObject({ ok: false, reason: 'fresh_context_busy' });
    letGo();
    expect(await a).toEqual({ ok: true });
    expect(await handOff).toEqual({ ok: true });
  });

  it('a waiter that timed out leaves no lock entry behind once the holder is done', async () => {
    let letGo: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let first = true;
    answer = async () => {
      if (first) { first = false; await held; }
      return PROCESS;
    };
    const rpc = harness(20);
    const a = rpc.gatedSubmit('pty-z', 'first', 'Claude Code');
    expect(await rpc.gatedSubmit('pty-z', 'second', 'Claude Code')).toMatchObject({ ok: false, reason: 'fresh_context_busy' });
    letGo();
    await a;
    expect(paneDeliveryLocksForTest()).not.toContain('pty-z');
  });

  it('the pane is released when its write fails (the pane went away)', async () => {
    writeOk = () => false;
    const rpc = harness(50);
    const a = await rpc.gatedSubmit('pty-a', 'first', 'Claude Code');
    expect(a.ok).toBe(false);
    writeOk = () => true;
    expect(await rpc.gatedSubmit('pty-a', 'second', 'Claude Code')).toEqual({ ok: true });
    expect(on('pty-a')).toEqual([paste('second'), '\r']);
  });
});
