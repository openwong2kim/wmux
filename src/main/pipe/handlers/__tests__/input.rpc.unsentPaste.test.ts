// #3390: a delivery's paste left unsent in an agent's input box keeps every
// later delivery out of that pane, nothing written, until the box may be clear
// again: a turn started after it, the agent's session ended, or input reached
// the pane after it (the daemon's input count). No screen read clears it, and
// a turn's end does not (the turn-end reminder fires right then).

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
/** Input on each pane's pipe that is not a delivery's write (a person's key, an agent's terminal_send). */
let keys: Record<string, number>;
/** Reads of a pane's input count still to come back one short: a write of ours counted late. */
let lagReads: Record<string, number>;
/** How many reads each write to a pane stays uncounted for. */
let lagAfterWrite: Record<string, number>;
let logs: string[];
/** The daemon reports no input count (an older daemon). */
let noCount: boolean;
let turnStartedAt: number | undefined;
/**
 * #3393 — a daemon with the pane delivery lock: it holds an unsent paste itself. `held` is what it reports per pane,
 * `reports` what main told it, `accept` whether it takes a report. Null: an older daemon (main's own record).
 */
let daemonHold: { held: Record<string, boolean>; reports: Array<{ id: string; token: string }>; accept: boolean } | null;
/** How many of the daemon's next agent-state reads fail (a timeout). */
let unreadable: number;
let stops: (ptyId: string) => void = () => undefined;
let dropped: (ptyId: string) => void = () => undefined;

function harness() {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (id: string, data: string) => {
      writes.push({ id, data });
      if (lagAfterWrite[id]) lagReads[id] = lagAfterWrite[id];
      return true;
    },
    getAgentState: async (id: string) => {
      if (unreadable > 0) {
        unreadable -= 1;
        throw new Error('timeout');
      }
      const lag = (lagReads[id] ?? 0) > 0 ? 1 : 0;
      if (lag) lagReads[id] -= 1;
      const count = writes.filter((w) => w.id === id).length + (keys[id] ?? 0) - lag;
      return {
        agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
        inputQuiet: true, inputRevision: 1, hasDraft: draft[id] ?? false, keyInputIdleMs: 60_000,
        ...(noCount ? {} : { keyInputRevision: count }),
        ...(daemonHold ? { unsentPasteHeld: daemonHold.held[id] ?? false } : {}),
      };
    },
    ...(daemonHold ? {
      acquirePaneLock: async () => ({ held: true as const, token: 'tok-1' }),
      releasePaneLock: () => undefined,
      writeHeld: async (id: string, _token: string, data: string) => {
        writes.push({ id, data });
        return { ok: true as const, written: 1 };
      },
      reportUnsentPaste: async (id: string, token: string) => {
        daemonHold?.reports.push({ id, token });
        if (daemonHold?.accept) daemonHold.held[id] = true;
        return daemonHold?.accept === true;
      },
    } : {}),
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
      log: (line: string) => { logs.push(line); },
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
  keys = {};
  lagReads = {};
  lagAfterWrite = {};
  logs = [];
  noCount = false;
  daemonHold = null;
  unreadable = 0;
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

  it('no screen read clears it; input reaching the pane after it does, and then the usual checks decide', async () => {
    const wiring = harness();
    await leaveUnsent(wiring);
    // The composer reads empty and the draft flag is clear: still held (both come from screen reads).
    answers = [PROCESS];
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(/still holds an earlier message/) });
    // The person pressed a key in the pane (Ctrl+U): touched. The box reads empty, so the reminder is typed.
    keys['pty-a'] = 1;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: true });
    expect(written()).toEqual(['\x1b[200~pointer\x1b[201~', `\x1b[200~${REMINDER}\x1b[201~`, '\r']);
  });

  it("the delivery's own write counted after the record is not a touch: still held", async () => {
    const wiring = harness();
    // The paste reaches the daemon's count only after the first read of it.
    lagAfterWrite['pty-a'] = 1;
    await leaveUnsent(wiring);
    answers = [PROCESS];
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(/still holds an earlier message/) });
    expect(written()).toEqual(['\x1b[200~pointer\x1b[201~']);
  });

  it('a paste not yet counted when it is recorded: held, logged once, and counting it later does not clear it', async () => {
    const wiring = harness();
    // Uncounted through every settle read.
    lagAfterWrite['pty-a'] = 100;
    await leaveUnsent(wiring);
    expect(logs.filter((line) => line.includes('recorded before its writes were counted'))).toHaveLength(1);
    // The daemon counts it now: still held.
    lagReads['pty-a'] = 0;
    answers = [PROCESS];
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(/still holds an earlier message/) });
    expect(written()).toEqual(['\x1b[200~pointer\x1b[201~']);
    // A key after it still clears it.
    keys['pty-a'] = 1;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: true });
  });

  it('with no input count from the daemon it stays held until a turn starts; a task meanwhile is stored', async () => {
    const wiring = harness();
    noCount = true;
    await leaveUnsent(wiring);
    keys['pty-a'] = 5;
    answers = [PROCESS];
    expect(await wiring.gatedSubmit('pty-a', 'later', 'Claude Code', { senderTaskIds: ['t-3'] })).toMatchObject({ ok: false, stored: true });
    clock += 1_000;
    turnStartedAt = clock;
    expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: true });
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

  describe('with a daemon that holds it (#3393)', () => {
    it("main reports the paste it left, under the pane's lock, and keeps no record of its own", async () => {
      daemonHold = { held: {}, reports: [], accept: true };
      const wiring = harness();
      await leaveUnsent(wiring);
      expect(daemonHold.reports).toEqual([{ id: 'pty-a', token: 'tok-1' }]);
      expect(logs.some((line) => line.includes('recorded before its writes were counted'))).toBe(false);
      // Held by the daemon: refused, nothing written.
      answers = [PROCESS];
      expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, reason: 'input_mode', detail: expect.stringMatching(/still holds an earlier message/) });
      expect(written()).toEqual(['\x1b[200~pointer\x1b[201~']);
      // The daemon cleared it (a key, a turn, an exit): typed, as main has no record that would hold it.
      daemonHold.held['pty-a'] = false;
      expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: true });
    });

    it("a paste the daemon's own writer left holds main's delivery too", async () => {
      daemonHold = { held: { 'pty-a': true }, reports: [], accept: true };
      const wiring = harness();
      answers = [PROCESS];
      expect(await wiring.gatedSubmit('pty-a', 'later', 'Claude Code', { senderTaskIds: ['t-9'] })).toMatchObject({ ok: false, stored: true, composerNotPlain: true });
      expect(writes).toEqual([]);
    });

    it("the daemon's answer missing: whether the box is held is unknown, so nothing is typed", async () => {
      daemonHold = { held: {}, reports: [], accept: true };
      const wiring = harness();
      unreadable = Infinity;
      answers = [PROCESS];
      expect(await wiring.gatedSubmit('pty-a', 'later', 'Claude Code', { senderTaskIds: ['t-4'] })).toMatchObject({ ok: false, reason: 'gate_unavailable', detail: expect.stringMatching(/input state could not be read/) });
      expect(writes).toEqual([]);
    });

    it("one missed answer from a stalled daemon is asked again, and the delivery goes on", async () => {
      daemonHold = { held: {}, reports: [], accept: true };
      const wiring = harness();
      unreadable = 1;
      answers = [PROCESS];
      expect(await wiring.gatedSubmit('pty-a', 'later', 'Claude Code', { senderTaskIds: ['t-5'] })).toMatchObject({ ok: true });
      expect(writes.length).toBeGreaterThan(0);
    });

    it('a report the daemon did not take falls back to main\'s own record', async () => {
      daemonHold = { held: {}, reports: [], accept: false };
      const wiring = harness();
      await leaveUnsent(wiring);
      answers = [PROCESS];
      expect(await wiring.gatedSubmit('pty-a', REMINDER, 'Claude Code')).toMatchObject({ ok: false, detail: expect.stringMatching(/still holds an earlier message/) });
    });
  });
});
