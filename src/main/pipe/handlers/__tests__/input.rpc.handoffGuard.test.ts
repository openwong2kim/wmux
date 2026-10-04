// The Git page's hand-off delivery in main's gated submit: it waits for the
// person to stop typing, and right before the paste and the Enter checks that
// the same agent is in the pane and nobody typed, under a deadline. Our own
// paste counts as key input to the daemon, so the check before the Enter
// tells it apart from a person's keys by the daemon's key counter. Driven
// against registerInputRpc with a fake daemon whose key clock and key counter
// move with every write.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { GatedSubmitOptions, GatedSubmitResult } from '../../../../shared/ptyMessageDelivery';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const FREE = '⏺ Done.\n\n──────────\n❯ ';
const PASTE = '\x1b[200~ref\x1b[201~';

let clock: number;
let writes: string[];
/** The pane as the daemon sees it; `lastKeyAt` drives keyInputIdleMs, `keys` keyInputRevision. */
let pane: { agentName: string | null; agentStatus: string; incarnationId: string; agentVerified: boolean; hasDraft: boolean; lastKeyAt: number; keys: number };
/** Runs on every state read, before it answers (tests change the pane in it). */
let onRead: ((n: number) => void) | null;
let readFails: boolean;
let local: boolean;
let reads: number;

function harness() {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (_id: string, data: string) => {
      writes.push(data);
      // The daemon sees every write as key input; text leaves a draft, Enter submits it.
      pane.lastKeyAt = clock;
      pane.keys += 1;
      pane.hasDraft = data !== '\r' && data !== '\x15';
      return true;
    },
    getAgentState: async () => {
      reads += 1;
      onRead?.(reads);
      if (readFails) throw new Error('daemon read timed out');
      return {
        agentName: pane.agentName,
        agentStatus: pane.agentStatus,
        agentVerified: pane.agentVerified,
        incarnationId: pane.incarnationId,
        inputQuiet: true,
        inputRevision: 1,
        hasDraft: pane.hasDraft,
        keyInputIdleMs: clock - pane.lastKeyAt,
        keyInputRevision: pane.keys,
      };
    },
  };
  return registerInputRpc(
    new RpcRouter(),
    { get: () => (local ? {} : undefined), write: (_id: string, d: string) => writes.push(d) } as unknown as PTYManager,
    () => ({}) as BrowserWindow,
    () => dc as never,
    undefined,
    undefined,
    {
      answerPolicy: async () => ({ allowed: true }),
      readScreenText: async () => FREE,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
    },
  );
}

const send = (opts: Partial<GatedSubmitOptions> = {}): Promise<GatedSubmitResult> =>
  harness().gatedSubmit('pty-a', 'ref', 'Claude Code', {
    waitQuiet: true,
    expectAgent: 'Claude Code',
    deadlineAt: clock + 42_000,
    ...opts,
  });

beforeEach(() => {
  clock = 1_000_000;
  writes = [];
  pane = { agentName: 'Claude Code', agentStatus: 'waiting', incarnationId: 'inc-1', agentVerified: false, hasDraft: false, lastKeyAt: clock - 60_000, keys: 7 };
  onRead = null;
  readFails = false;
  local = false;
  reads = 0;
});

describe('hand-off delivery guard', () => {
  it('a quiet pane with the expected agent gets the paste and the Enter', async () => {
    expect(await send()).toEqual({ ok: true });
    expect(writes).toEqual([PASTE, '\r']);
  });

  it('waits while someone types, then delivers once they stop', async () => {
    pane.hasDraft = true;
    pane.lastKeyAt = clock;
    // They stop and submit their own line two seconds in.
    const stopAt = clock + 2_000;
    onRead = () => { if (clock >= stopAt && pane.hasDraft) { pane.hasDraft = false; pane.lastKeyAt = stopAt; } };
    expect(await send()).toEqual({ ok: true });
    expect(clock - stopAt).toBeGreaterThanOrEqual(10_000);
    expect(writes).toEqual([PASTE, '\r']);
  });

  it('someone who keeps typing gets nothing written, within the wait', async () => {
    onRead = () => { pane.lastKeyAt = clock; pane.hasDraft = true; };
    const start = clock;
    expect(await send()).toMatchObject({ ok: false, reason: 'user_typing' });
    expect(writes).toEqual([]);
    expect(clock - start).toBeLessThanOrEqual(20_500);
  });

  it('the agent exiting during the wait is refused, nothing written', async () => {
    pane.hasDraft = true;
    onRead = (n) => { if (n >= 3) { pane.agentName = null; pane.agentStatus = 'idle'; } };
    expect(await send()).toMatchObject({ ok: false, reason: 'agent_changed' });
    expect(writes).toEqual([]);
  });

  it('another agent than the one the person picked is refused', async () => {
    pane.agentName = 'Codex CLI';
    expect(await send()).toMatchObject({ ok: false, reason: 'agent_changed' });
    expect(writes).toEqual([]);
  });

  it('the agent replaced between the paste and the Enter: no Enter, the paste is cleared', async () => {
    onRead = () => { if (writes.length === 1) pane.incarnationId = 'inc-2'; };
    expect(await send()).toMatchObject({ ok: false, reason: 'agent_changed', pasted: true, cleared: true });
    expect(writes).toEqual([PASTE, '\x15']);
  });

  it('a key pressed after our paste: no Enter, the paste is cleared', async () => {
    // A second after our paste, the person presses a key.
    onRead = () => { if (writes.length === 1) { clock += 1_000; pane.lastKeyAt = clock; pane.keys += 1; } };
    expect(await send()).toMatchObject({ ok: false, reason: 'user_typing', pasted: true, cleared: true });
    expect(writes).toEqual([PASTE, '\x15']);
  });

  it('a key 50 ms after our paste, inside the 100 ms Enter delay: no Enter, the paste is cleared', async () => {
    // The Enter check reads 100 ms after the paste (Claude Code's delay); the
    // person's key landed at 50 ms. Idle time alone cannot tell it from our paste.
    onRead = () => { if (writes.length === 1 && pane.lastKeyAt === clock - 100) { pane.lastKeyAt = clock - 50; pane.keys += 1; } };
    expect(await send()).toMatchObject({ ok: false, reason: 'user_typing', pasted: true, cleared: true });
    expect(writes).toEqual([PASTE, '\x15']);
  });

  it('a process-backed agent whose process went away is refused before the Enter', async () => {
    pane.agentVerified = true;
    onRead = () => { if (writes.length === 1) pane.agentVerified = false; };
    expect(await send()).toMatchObject({ ok: false, reason: 'agent_changed', pasted: true });
    expect(writes).not.toContain('\r');
  });

  it('reads that fail are not quiet: retried, then refused at the deadline', async () => {
    readFails = true;
    expect(await send()).toMatchObject({ ok: false, reason: 'user_typing' });
    expect(reads).toBeGreaterThan(5);
    expect(writes).toEqual([]);
  });

  it('a local pane (no daemon state) cannot be verified and is refused', async () => {
    local = true;
    expect(await send()).toMatchObject({ ok: false, reason: 'agent_unverified' });
    expect(writes).toEqual([]);
  });

  it('past the deadline nothing is written', async () => {
    expect(await send({ deadlineAt: clock - 1 })).toMatchObject({ ok: false, reason: 'deadline' });
    expect(writes).toEqual([]);
  });

  it('the wait is cut to what the deadline leaves after the rest of the delivery', async () => {
    onRead = () => { pane.lastKeyAt = clock; };
    const start = clock;
    expect(await send({ deadlineAt: clock + 25_000 })).toMatchObject({ ok: false, reason: 'user_typing' });
    expect(clock - start).toBeLessThanOrEqual(4_500);
  });
});
