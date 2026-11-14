// One delivery at a time into a pane. Two deliveries that arrived together
// both found the agent's input box empty, both pasted, and each then refused
// its Enter because the box held more than its own text, so neither was ever
// submitted. Every gated delivery now holds its pane from its first check
// before the paste through its Enter (or its refusal and take-back).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import type { DeliveryCheck, DeliveryPresence } from '../../../../shared/deliveryPresence';
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

function harness(lockWaitMs?: number) {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (ptyId: string, data: string) => {
      if (!writeOk(ptyId)) return false;
      writes.push({ ptyId, data });
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
      deliveryPresence: async (ptyId, _expect, check) => {
        asked.push({ ptyId, phase: check.phase });
        return answer(ptyId, check);
      },
      readScreenText: async () => FREE,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: () => undefined,
      ...(lockWaitMs !== undefined ? { freshContextLockWaitMs: lockWaitMs } : {}),
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
