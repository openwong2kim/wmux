// #3390: a delivery's paste left unsent in an agent's input box keeps every
// later delivery out of that pane, nothing written, until the box is clear
// again: a turn started after it, the agent's session ended, or the composer
// reads empty and the daemon's draft flag agrees. A turn's end does not clear
// it (the turn-end reminder fires right then).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { DeliveryPresence } from '../../../../shared/deliveryPresence';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import { sendToRenderer } from '../_bridge';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const FREE = '⏺ Done.\n\n──────────\n❯ ';
const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };
/** At the Enter: the box does not show this paste (Claude collapsed or scrolled it), so it is left there. */
const NOT_SHOWN: DeliveryPresence = { tier: 'none', reason: 'composer-busy', pasteShown: false };
const REMINDER = '[wmux] 1 A2A task still waiting for you — a2a_task_query';

let clock: number;
let writes: Array<{ id: string; data: string }>;
let answers: DeliveryPresence[];
/** The daemon's draft flag per pane. */
let draft: Record<string, boolean>;
let turnStartedAt: number | undefined;
let stops: (ptyId: string) => void = () => undefined;
let dropped: (ptyId: string) => void = () => undefined;

function harness() {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (id: string, data: string) => {
      writes.push({ id, data });
      return true;
    },
    getAgentState: async (id: string) => ({
      agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
      inputQuiet: true, inputRevision: 1, hasDraft: draft[id] ?? false, keyInputIdleMs: 60_000, keyInputRevision: writes.length,
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
      deliveryPresence: async () => (answers.length > 1 ? answers.shift() : answers[0]),
      readScreenText: async () => FREE,
      readTurnStartedAt: () => turnStartedAt,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: () => undefined,
      readTaskState: async () => 'open',
      subscribeAgentStops: (onStop) => {
        stops = onStop;
        return () => undefined;
      },
      subscribeAgentNamed: () => () => undefined,
      pendingSetOnce: () => undefined,
      subscribeAgentRecordDropped: (onDropped) => {
        dropped = onDropped;
        return () => undefined;
      },
    },
  );
}

const written = (id = 'pty-a'): string[] => writes.filter((w) => w.id === id).map((w) => w.data);

/** A pointer pasted into pty-a and left there: the box never showed it at the Enter. */
async function leaveUnsent(wiring: ReturnType<typeof harness>): Promise<void> {
  answers = [PROCESS, PROCESS, NOT_SHOWN];
  const res = await wiring.gatedSubmit('pty-a', 'pointer', 'Claude Code');
  expect(res).toMatchObject({ ok: false, pasted: true, cleared: false, pasteShown: false });
  expect(written()).toEqual(['\x1b[200~pointer\x1b[201~']);
}

/** As leaveUnsent, on a pane that has had writes before. */
async function leaveUnsentAgain(wiring: ReturnType<typeof harness>): Promise<void> {
  answers = [PROCESS, PROCESS, NOT_SHOWN];
  expect(await wiring.gatedSubmit('pty-a', 'pointer again', 'Claude Code')).toMatchObject({ ok: false, pasted: true, cleared: false });
}

beforeEach(() => {
  clock = 1_000_000;
  writes = [];
  answers = [PROCESS];
  draft = {};
  turnStartedAt = undefined;
  vi.mocked(sendToRenderer).mockImplementation(async (_w, method) => (method === 'input.findOwnerWorkspace' ? { workspaceId: 'ws-a' } : null));
});

describe('a paste left unsent in the input box (#3390)', () => {
  it('a paste left during a running turn: after that turn ends, the reminder is refused with nothing written', async () => {
    const wiring = harness();
    turnStartedAt = clock - 5_000;
    await leaveUnsent(wiring);
    clock += 60_000;
    stops('pty-a');
    // The screen read even calls the box empty (a frame caught mid-redraw); the draft flag does not.
    answers = [PROCESS];
    draft['pty-a'] = true;
    const res = await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code');
    expect(res).toMatchObject({ ok: false, reason: 'input_mode' });
    expect((res as { detail: string }).detail).toContain('still holds an earlier message wmux pasted and did not submit');
    expect(written()).toEqual(['\x1b[200~pointer\x1b[201~']);
  });

  it('a turn started after it clears the pane, and the task stored meanwhile is then typed', async () => {
    const wiring = harness();
    await leaveUnsent(wiring);
    answers = [NOT_SHOWN];
    expect(await wiring.gatedSubmit('pty-a', 'second', 'Claude Code', { senderTaskIds: ['t-2'] })).toMatchObject({ ok: false, stored: true });
    expect(written()).toHaveLength(1);
    // Someone pressed Enter on the stuck paste: a turn starts. That alone clears the memory: with the draft flag
    // still set, what refuses a delivery now is the flag, not the memory.
    clock += 1_000;
    turnStartedAt = clock;
    answers = [PROCESS];
    draft['pty-a'] = true;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(/already holds a draft/) });
    // The turn ends with the box empty: the stored task is typed.
    draft['pty-a'] = false;
    stops('pty-a');
    await vi.waitFor(() => expect(written()).toEqual(['\x1b[200~pointer\x1b[201~', '\x1b[200~second\x1b[201~', '\r']), { timeout: 5_000 });
  });

  it('clear again when the composer reads empty and the draft flag agrees, and only then', async () => {
    const wiring = harness();
    await leaveUnsent(wiring);
    // Screen empty, draft flag set: still held.
    answers = [PROCESS];
    draft['pty-a'] = true;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, reason: 'input_mode' });
    // Both say empty: typed.
    draft['pty-a'] = false;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: true });
    expect(written()).toEqual(['\x1b[200~pointer\x1b[201~', `\x1b[200~${REMINDER}\x1b[201~`, '\r']);
  });

  it("another pane is never held by it; the agent's session ending, or the pane torn down, clears it", async () => {
    const wiring = harness();
    await leaveUnsent(wiring);
    // pty-a's box reads empty on screen but its draft flag is set: held. pty-b is not.
    answers = [PROCESS];
    draft['pty-a'] = true;
    expect(await wiring.gatedSubmit('pty-b', 'other pane', 'Claude Code')).toMatchObject({ ok: true });
    expect(written('pty-b')).toEqual(['\x1b[200~other pane\x1b[201~', '\r']);
    const UNSENT = /still holds an earlier message wmux pasted/;
    const DRAFT = /already holds a draft/;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, reason: 'input_mode', detail: expect.stringMatching(UNSENT) });
    // The agent ended: the memory goes. With the draft flag still set, what refuses now is the flag, not the memory.
    wiring.agentEnded('pty-a');
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(DRAFT) });
    draft['pty-a'] = false;
    expect(await wiring.gatedSubmit('pty-a', 'after restart', 'Claude Code')).toMatchObject({ ok: true });
    // Left unsent again, then the pane is torn down: the memory goes the same way.
    await leaveUnsentAgain(wiring);
    draft['pty-a'] = true;
    answers = [PROCESS];
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ detail: expect.stringMatching(UNSENT) });
    dropped('pty-a');
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(DRAFT) });
  });

  it('a plain delivery is refused before the paste while the draft flag says the box holds a draft', async () => {
    const wiring = harness();
    draft['pty-a'] = true;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, reason: 'input_mode', composerNotPlain: true });
    expect(writes).toEqual([]);
  });

  it("another agent's draft flag is not read there: it stays set until a key submits or clears the box", async () => {
    const wiring = harness();
    answers = [{ tier: 'process', slug: 'codex', input: 'full', bracketedPaste: true }];
    draft['pty-a'] = true;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Codex')).toMatchObject({ ok: true });
  });
});
