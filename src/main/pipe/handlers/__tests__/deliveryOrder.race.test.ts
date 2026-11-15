// Two writers on one pane: main's gated delivery (input.rpc.ts) and a daemon
// writer (a scheduled prompt, sessionPromptDelivery.ts). Both guard on the
// pane's key revision, so neither submits the other's text; but each checks
// and then writes. Without a lock both take, a write by the other in between
// leaves a paste in the input box with its Enter withheld.
//
// With the daemon's per-pane delivery lock (daemon/paneDeliveryLock.ts) the
// daemon writer holds the pane from its first look through its Enter, and
// main holds it over RPC and writes only through writeHeld: one delivery
// waits for the other. Run on a real DaemonPTYBridge, with the agent's input
// box modelled: main's presence answers from it, as the daemon's composer
// read does.
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';
import type { DeliveryPresence } from '../../../../shared/deliveryPresence';
import { DaemonPTYBridge } from '../../../../daemon/DaemonPTYBridge';
import { RingBuffer } from '../../../../daemon/RingBuffer';
import { deliverScheduledPrompt } from '../../../../daemon/sessionPromptDelivery';
import { PANE_LOCK_DAEMON_WAIT_MS, PaneDeliveryLocks, writeUnderLock } from '../../../../daemon/paneDeliveryLock';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };
const FREE = '⏺ Done.\n\n──────────\n❯ ';
const MAIN_TEXT = '[wmux] new A2A task t-1 — a2a_task_query';
const DAEMON_TEXT = 'scheduled: run the nightly check';
const CLIENT = 'c1';

function pane() {
  const bridge = new DaemonPTYBridge();
  bridge.setupDataForwarding({ onData: () => ({ dispose: () => undefined }), onExit: () => ({ dispose: () => undefined }) } as unknown as IPty, new RingBuffer(65536), 'sess-1');
  /** Every byte that reached the pane, by writer and route, in order. */
  const writes: Array<[who: 'main' | 'main-held' | 'daemon', data: string]> = [];
  /** The agent's input box: a paste adds to it, an Enter submits and empties it. */
  const box = { text: '', submitted: [] as string[] };
  /** Bytes reaching the PTY; the bridge notes them on its own path. */
  const land = (who: 'main' | 'main-held' | 'daemon', data: string) => {
    writes.push([who, data]);
    if (data.startsWith('\r')) {
      box.submitted.push(box.text);
      box.text = '';
    } else box.text += data.split('\x1b[200~').join('').split('\x1b[201~').join('');
  };
  return { bridge, writes, box, land, locks: new PaneDeliveryLocks() };
}

type MainLock =
  /** The daemon's lock, over the RPCs main uses (DaemonClient). */
  | 'shared'
  /** A client with no lock methods: main's own lock only. */
  | 'none'
  | { held: false; why: 'unsupported' | 'busy' | 'unavailable'; detail: string };

/** Main's gated delivery into `bridge`, written as the daemon notes it. */
function mainDelivery(p: ReturnType<typeof pane>, lock: MainLock) {
  const lockMethods = lock === 'none' ? {} : lock === 'shared' ? {
    acquirePaneLock: async (id: string, nonce: string, waitMs: number) => {
      const token = await p.locks.acquire(id, { key: `main:${CLIENT}`, clientId: CLIENT, nonce }, waitMs);
      return token ? { held: true as const, token } : { held: false as const, why: 'busy' as const, detail: 'held' };
    },
    releasePaneLock: (id: string, by: { token?: string; nonce?: string }) => {
      if (by.token && p.locks.holds(id, by.token, CLIENT)) p.locks.release(id, by.token);
      if (by.nonce) p.locks.releaseNonce(id, CLIENT, by.nonce);
    },
    writeHeld: async (id: string, token: string, data: string) => {
      const r = writeUnderLock(p.locks, id, token, CLIENT, { write: (d) => p.land('main-held', d), noteInput: (d) => p.bridge.noteInput(d) }, data);
      return r.ok ? r : { ok: false as const, uncertain: false, detail: r.error };
    },
  } : {
    acquirePaneLock: async () => lock,
    releasePaneLock: () => undefined,
    writeHeld: async () => ({ ok: false as const, uncertain: false, detail: 'not held' }),
  };
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (_id: string, data: string) => {
      p.land('main', data);
      p.bridge.noteInput(data);
      return true;
    },
    getAgentState: async () => ({
      agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
      inputQuiet: p.bridge.isKeyInputQuiet(), inputRevision: p.bridge.getInputRevision(), hasDraft: p.bridge.hasDraft(),
      keyInputIdleMs: p.bridge.isKeyInputQuiet() ? 60_000 : 0,
      keyInputRevision: p.bridge.getKeyInputRevision(),
    }),
    ...lockMethods,
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
      // As the daemon's composer read answers: a plain prompt only while the
      // box is empty (before the paste) or holds this paste alone (at the Enter).
      deliveryPresence: async (_id, _agent, check) => {
        const plain = check.phase === 'paste' ? p.box.text === '' : p.box.text === MAIN_TEXT;
        return plain ? PROCESS : { tier: 'none', reason: 'composer-busy', ...(check.phase === 'enter' ? { pasteShown: p.box.text.includes(MAIN_TEXT) } : {}) };
      },
      readScreenText: async () => FREE,
      sleep: async () => undefined,
      subscribeAgentStops: () => () => undefined,
      subscribeAgentNamed: () => () => undefined,
      subscribeAgentRecordDropped: () => () => undefined,
      pendingSetOnce: () => undefined,
    },
  );
}

/**
 * The daemon's scheduled prompt into the same pane, under the pane's lock as
 * the daemon's writer funnel takes it (`locked`), or with none. `between` runs
 * after its checks and before its paste; `afterPaste` in its submit delay.
 */
function daemonPrompt(p: ReturnType<typeof pane>, locked: boolean, hooks: { between?: () => Promise<void>; afterPaste?: () => Promise<void> }) {
  let raced = false;
  let delayed = false;
  const run = () => deliverScheduledPrompt('claude', 'inc-1', DAEMON_TEXT, {
    getAgentState: () => ({ slug: 'claude', incarnationId: 'inc-1', status: 'idle', inputQuiet: true, inputRevision: p.bridge.getKeyInputRevision() }),
    isAgentProcessAlive: async () => {
      if (!raced) {
        raced = true;
        await hooks.between?.();
      }
      return true;
    },
    write: (data) => {
      p.land('daemon', data);
      p.bridge.noteInput(data);
      return true;
    },
    delay: async () => {
      if (delayed) return;
      delayed = true;
      await hooks.afterPaste?.();
    },
  });
  return locked ? p.locks.runLocked('sess-1', 'daemon:scheduled prompt', PANE_LOCK_DAEMON_WAIT_MS, run).then((r) => r ?? 'busy') : run();
}

/** Let the other delivery reach its wait for the lock. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Main's gated delivery of MAIN_TEXT into the pane. */
const mainSend = (main: ReturnType<typeof mainDelivery>) => main.gatedSubmit('sess-1', MAIN_TEXT, 'Claude Code', { senderTaskIds: ['t-1'] });

describe('delivery order with no lock both take (an older daemon)', () => {
  it("main's delivery lands inside the daemon's check-to-write gap: the daemon pastes after it and withholds its Enter", async () => {
    const p = pane();
    const main = mainDelivery(p, { held: false, why: 'unsupported', detail: 'Unknown method' });
    let mainResult: unknown;
    const daemonResult = await daemonPrompt(p, false, {
      between: async () => {
        mainResult = await mainSend(main);
      },
    });
    expect(mainResult).toEqual({ ok: true });
    expect(daemonResult).toBe('error');
    // What is left: the scheduled prompt sits unsent in the input box.
    expect(p.box).toEqual({ text: DAEMON_TEXT, submitted: [MAIN_TEXT] });
    p.bridge.cleanup();
  });

  it("main's delivery arrives while the daemon's paste waits for its Enter: main sees the box taken and writes nothing; the daemon submits", async () => {
    const p = pane();
    const main = mainDelivery(p, 'none');
    let mainResult: { ok: boolean; reason?: string; pasted?: boolean } | undefined;
    const daemonResult = await daemonPrompt(p, false, {
      afterPaste: async () => {
        mainResult = await mainSend(main) as typeof mainResult;
      },
    });
    expect(mainResult).toMatchObject({ ok: false, reason: 'input_mode' });
    expect(mainResult?.pasted).not.toBe(true);
    expect(daemonResult).toBe('sent');
    expect(p.box).toEqual({ text: '', submitted: [DAEMON_TEXT] });
    p.bridge.cleanup();
  });
});

describe("delivery order under the daemon's per-pane lock", () => {
  it("main's delivery in the daemon writer's check-to-write gap waits for it: both are submitted, one after the other", async () => {
    const p = pane();
    const main = mainDelivery(p, 'shared');
    let mainRun: Promise<unknown> | undefined;
    const daemonResult = await daemonPrompt(p, true, {
      between: async () => {
        mainRun = mainSend(main);
        await settle();
      },
    });
    expect(daemonResult).toBe('sent');
    expect(await mainRun).toEqual({ ok: true });
    expect(p.box).toEqual({ text: '', submitted: [DAEMON_TEXT, MAIN_TEXT] });
    // Main wrote only under the lock, never through the session pipe.
    expect(p.writes.filter(([who]) => who === 'main')).toEqual([]);
    p.bridge.cleanup();
  });

  it("main's delivery during the daemon's submit delay waits too", async () => {
    const p = pane();
    const main = mainDelivery(p, 'shared');
    let mainRun: Promise<unknown> | undefined;
    const daemonResult = await daemonPrompt(p, true, {
      afterPaste: async () => {
        mainRun = mainSend(main);
        await settle();
      },
    });
    expect(daemonResult).toBe('sent');
    expect(await mainRun).toEqual({ ok: true });
    expect(p.box).toEqual({ text: '', submitted: [DAEMON_TEXT, MAIN_TEXT] });
    p.bridge.cleanup();
  });

  it('a daemon writer arriving while main holds the pane waits for main, then goes', async () => {
    const p = pane();
    const main = mainDelivery(p, 'shared');
    const token = await p.locks.acquire('sess-1', { key: `main:${CLIENT}`, clientId: CLIENT, nonce: 'held' }, 0);
    const daemonRun = daemonPrompt(p, true, {});
    await settle();
    expect(p.writes).toEqual([]);
    p.locks.release('sess-1', token as string);
    expect(await daemonRun).toBe('sent');
    expect(await mainSend(main)).toEqual({ ok: true });
    expect(p.box.submitted).toEqual([DAEMON_TEXT, MAIN_TEXT]);
    p.bridge.cleanup();
  });

  it("two of main's deliveries to one pane: main's own chain lets the second ask the daemon only after the first released, so it never takes over a hold still writing", async () => {
    const p = pane();
    const main = mainDelivery(p, 'shared');
    // Same connection: an acquire while that connection holds the pane would
    // end the hold (a lost release). The second must not reach it mid-delivery.
    expect(await Promise.all([mainSend(main), mainSend(main)])).toEqual([{ ok: true }, { ok: true }]);
    expect(p.box.submitted).toEqual([MAIN_TEXT, MAIN_TEXT]);
    // Paste, Enter, paste, Enter: each delivery whole, all under the lock.
    expect(p.writes.map(([who, data]) => [who, data.startsWith('\r') ? 'enter' : 'paste'])).toEqual([
      ['main-held', 'paste'], ['main-held', 'enter'], ['main-held', 'paste'], ['main-held', 'enter'],
    ]);
    p.bridge.cleanup();
  });
});

describe("main when the daemon's lock cannot be taken", () => {
  it('an older daemon (Unknown method): delivered on main\'s own lock, through the session pipe', async () => {
    const p = pane();
    const main = mainDelivery(p, { held: false, why: 'unsupported', detail: 'Unknown method: daemon.session.deliveryLockV1' });
    expect(await mainSend(main)).toEqual({ ok: true });
    expect(p.writes.every(([who]) => who === 'main')).toBe(true);
    p.bridge.cleanup();
  });

  it('a lock that answered busy, or did not answer in time: nothing written, never a silent run on main\'s lock alone', async () => {
    for (const [why, reason] of [['busy', 'fresh_context_busy'], ['unavailable', 'gate_unavailable']] as const) {
      const p = pane();
      const main = mainDelivery(p, { held: false, why, detail: 'x' });
      expect(await mainSend(main)).toMatchObject({ ok: false, reason });
      expect(p.writes).toEqual([]);
      p.bridge.cleanup();
    }
  });
});
