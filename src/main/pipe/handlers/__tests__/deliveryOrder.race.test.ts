// Two writers on one pane, as main has them today: main's gated delivery
// (input.rpc.ts, which holds a pane lock only main's own deliveries take) and
// a daemon writer (a scheduled prompt, sessionPromptDelivery.ts), which takes
// no lock. Both guard on the pane's key revision, so neither submits the
// other's text; but each checks and then writes, and a write by the other in
// between leaves a paste in the input box with its Enter withheld.
//
// This pins today's outcome on a real DaemonPTYBridge. It is the baseline for
// one per-pane delivery lock shared by both processes.
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

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const PROCESS: DeliveryPresence = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };
const FREE = '⏺ Done.\n\n──────────\n❯ ';
const MAIN_TEXT = '[wmux] new A2A task t-1 — a2a_task_query';
const DAEMON_TEXT = 'scheduled: run the nightly check';

function pane() {
  const bridge = new DaemonPTYBridge();
  bridge.setupDataForwarding({ onData: () => ({ dispose: () => undefined }), onExit: () => ({ dispose: () => undefined }) } as unknown as IPty, new RingBuffer(65536), 'sess-1');
  /** Every byte that reached the pane, by writer, in order. */
  const writes: Array<[who: 'main' | 'daemon', data: string]> = [];
  /** The agent's input box: a paste adds to it, an Enter submits and empties it. */
  const box = { text: '', submitted: [] as string[] };
  const type = (who: 'main' | 'daemon', data: string) => {
    writes.push([who, data]);
    bridge.noteInput(data);
    if (data.startsWith('\r')) {
      box.submitted.push(box.text);
      box.text = '';
    } else box.text += data.split('\x1b[200~').join('').split('\x1b[201~').join('');
  };
  return { bridge, writes, box, type };
}

/** Main's gated delivery into `bridge`, as the daemon's session write path notes it. */
function mainDelivery(p: ReturnType<typeof pane>) {
  const dc = {
    isConnected: true,
    rpc: async (method: string) => (method === 'daemon.approvals.list' ? { pending: [] } : { ok: true }),
    writeToSession: (_id: string, data: string) => {
      p.type('main', data);
      return true;
    },
    getAgentState: async () => ({
      agentName: 'Claude Code', agentStatus: 'waiting', agentVerified: true, incarnationId: 'inc-1',
      inputQuiet: p.bridge.isKeyInputQuiet(), inputRevision: p.bridge.getInputRevision(), hasDraft: p.bridge.hasDraft(),
      keyInputIdleMs: p.bridge.isKeyInputQuiet() ? 60_000 : 0,
      keyInputRevision: p.bridge.getKeyInputRevision(),
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
 * The daemon's scheduled prompt into the same pane. `between` runs after its
 * checks and before its paste; `afterPaste` runs in its submit delay.
 */
function daemonPrompt(p: ReturnType<typeof pane>, hooks: { between?: () => Promise<void>; afterPaste?: () => Promise<void> }) {
  let raced = false;
  let delayed = false;
  return deliverScheduledPrompt('claude', 'inc-1', DAEMON_TEXT, {
    getAgentState: () => ({ slug: 'claude', incarnationId: 'inc-1', status: 'idle', inputQuiet: true, inputRevision: p.bridge.getKeyInputRevision() }),
    isAgentProcessAlive: async () => {
      if (!raced) {
        raced = true;
        await hooks.between?.();
      }
      return true;
    },
    write: (data) => {
      p.type('daemon', data);
      return true;
    },
    delay: async () => {
      if (delayed) return;
      delayed = true;
      await hooks.afterPaste?.();
    },
  });
}

describe('delivery order: main and a daemon writer on one pane (no shared lock)', () => {
  it("main's delivery lands inside the daemon's check-to-write gap: the daemon pastes after it and withholds its Enter", async () => {
    const p = pane();
    const main = mainDelivery(p);
    let mainResult: unknown;
    const daemonResult = await daemonPrompt(p, {
      between: async () => {
        mainResult = await main.gatedSubmit('sess-1', MAIN_TEXT, 'Claude Code', { senderTaskIds: ['t-1'] });
      },
    });
    // Main's text went in whole and was submitted.
    expect(mainResult).toEqual({ ok: true });
    // The daemon then pasted into the box and, its revision proof broken, kept its Enter back.
    expect(daemonResult).toBe('error');
    expect(p.writes.map(([who, data]) => [who, data.includes(MAIN_TEXT) ? 'MAIN' : data.includes(DAEMON_TEXT) ? 'DAEMON' : JSON.stringify(data)])).toEqual([
      ['main', 'MAIN'],
      ['main', '"\\r"'],
      ['daemon', 'DAEMON'],
    ]);
    // What is left: the scheduled prompt sits unsent in the input box.
    expect(p.box).toEqual({ text: DAEMON_TEXT, submitted: [MAIN_TEXT] });
    p.bridge.cleanup();
  });

  it("main's delivery arrives while the daemon's paste waits for its Enter: main sees the box taken and writes nothing; the daemon submits", async () => {
    const p = pane();
    const main = mainDelivery(p);
    let mainResult: { ok: boolean; reason?: string; pasted?: boolean } | undefined;
    const daemonResult = await daemonPrompt(p, {
      afterPaste: async () => {
        mainResult = await main.gatedSubmit('sess-1', MAIN_TEXT, 'Claude Code', { senderTaskIds: ['t-1'] }) as typeof mainResult;
      },
    });
    expect(mainResult).toMatchObject({ ok: false, reason: 'input_mode' });
    expect(mainResult?.pasted).not.toBe(true);
    expect(daemonResult).toBe('sent');
    expect(p.box).toEqual({ text: '', submitted: [DAEMON_TEXT] });
    p.bridge.cleanup();
  });
});
