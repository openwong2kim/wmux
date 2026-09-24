/**
 * #1464 — the recovery replay decision against a REAL ConPTY.
 *
 * DaemonSessionManager.test.ts covers the same decision with a mocked PTY;
 * the Windows branch (keep ConPTY's stale-geometry discard) only means
 * something against the real thing, and nobody on the team runs Windows. This
 * suite is that dogfood: it runs on the CI windows-latest runner and is
 * skipped everywhere else.
 *
 * "What the client receives" is modelled the way daemon/index.ts wires a
 * session pipe: the attach flush is the ring as it stands when the client
 * attaches, and after that every bridge 'data' event is forwarded to the
 * client. The replay burst is the 'data' emitted while the unmute runs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManagedSession } from '../DaemonSessionManager';
import { DaemonSessionManager } from '../DaemonSessionManager';

const SYS = process.env.SystemRoot || 'C:\\Windows';
const CMD_EXE = `${SYS}\\System32\\cmd.exe`;
const onWindows = process.platform === 'win32' && fs.existsSync(CMD_EXE);

// A loaded windows-latest runner can take seconds to cold-start a ConPTY
// shell; the happy path resolves as soon as the condition holds.
const WAIT_MS = 60000;
// DEFERRED_UNMUTE_DELAY_MS is 100; give the timer room on a busy runner.
const UNMUTE_SETTLE_MS = 500;
const HOLD_CAP = 256 * 1024;

const HISTORY = 'WMUX-HISTORY-1464';
const HEAD = 'WMUX-HEAD-1464';
const TAIL = 'WMUX-TAIL-1464';

interface HoldState {
  heldWhileMuted: string[] | null;
  heldFull: boolean;
}

interface Client {
  /** The attach flush: the ring when the client attached. */
  flush: string;
  /** Bytes forwarded while the unmute ran — the replay of held output. */
  replayed: string[];
  /** Bytes forwarded at any other time (live output). */
  live: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, label: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

function holdState(managed: ManagedSession): HoldState {
  return managed.bridge as unknown as HoldState;
}

function heldText(managed: ManagedSession): string {
  return (holdState(managed).heldWhileMuted ?? []).join('');
}

describe.skipIf(!onWindows)('recovery replay — real ConPTY (win32 only; elsewhere the Windows branch is not reachable)', () => {
  let manager: DaemonSessionManager | undefined;

  afterEach(() => {
    manager?.disposeAll();
    manager = undefined;
  });

  /**
   * Create a recovered (deferred) cmd.exe session with restored history,
   * attach a client, and make the shell print HEAD while output is muted.
   */
  async function recoverWithHeldHead(id: string): Promise<{ mgr: DaemonSessionManager; managed: ManagedSession; client: Client }> {
    const mgr = new DaemonSessionManager();
    manager = mgr;
    mgr.createSession({
      id,
      cmd: CMD_EXE,
      cwd: path.resolve(process.cwd()),
      cols: 80,
      rows: 24,
      scrollbackData: Buffer.from(`${HISTORY}\r\n`),
      deferOutput: true,
    });
    const managed = mgr.getSession(id);
    if (!managed) throw new Error(`session ${id} was not created`);
    expect(managed.bridge.isMuted).toBe(true);

    const client: Client = { flush: managed.ringBuffer.readAll().toString('utf8'), replayed: [], live: [] };
    let inUnmute = false;
    managed.bridge.on('data', (buf: Buffer) => {
      (inUnmute ? client.replayed : client.live).push(buf.toString('utf8'));
    });
    const setMuted = managed.bridge.setMuted.bind(managed.bridge);
    managed.bridge.setMuted = (muted, opts) => {
      inUnmute = !muted;
      try {
        setMuted(muted, opts);
      } finally {
        inUnmute = false;
      }
    };

    // Input flows while muted; only the output is held.
    managed.ptyProcess.write(`echo ${HEAD}\r`);
    await waitFor(() => heldText(managed).includes(HEAD), `${HEAD} to be held while muted`);
    expect(client.live.join('')).toBe('');
    return { mgr, managed, client };
  }

  it('(a) same-size recovery: the prompt printed while muted reaches the client', async () => {
    const { mgr, managed, client } = await recoverWithHeldHead(`rt-1464-same-${Date.now()}`);

    mgr.resizeSession(managed.meta.id, 80, 24);
    await waitFor(() => !managed.bridge.isMuted, 'unmute');
    await sleep(UNMUTE_SETTLE_MS);

    // History arrived with the attach flush…
    expect(client.flush).toContain(HISTORY);
    // …and the shell's output from while it was muted — the echoed line and
    // cmd's prompt after it — arrived as the replay, not lost.
    const replayed = client.replayed.join('');
    expect(replayed).toContain(HEAD);
    expect(replayed).toMatch(/[A-Za-z]:\\[^\r\n]*>/);
  }, WAIT_MS + 10000);

  it('(b) same size then a size change inside the window: nothing held is replayed, the prompt still arrives', async () => {
    const { mgr, managed, client } = await recoverWithHeldHead(`rt-1464-change-${Date.now()}`);

    // First resize keeps the saved size (schedules the unmute), the second
    // changes it before the 100 ms drain elapses — the Resume row shrinking
    // the pane is the real-world trigger. The held bytes may mix ConPTY frames
    // from both sizes; none of them may be replayed.
    mgr.resizeSession(managed.meta.id, 80, 24);
    mgr.resizeSession(managed.meta.id, 80, 22);
    await waitFor(() => !managed.bridge.isMuted, 'unmute');

    expect(client.flush).toContain(HISTORY);
    expect(client.replayed.join('')).toBe('');
    // …but the pane is not left blank: with no keystroke, ConPTY's repaint at
    // the current size (asked for after the unmute) brings cmd's prompt. The
    // Windows dogfood of #1469 found it missing in 4 of 6 recovered panes.
    await waitFor(() => /[A-Za-z]:\\[^\r\n]*>/.test(client.live.join('')), 'the prompt to arrive live without input');
    // The pane is live again: new output reaches the client directly.
    managed.ptyProcess.write(`echo ${TAIL}\r`);
    await waitFor(() => client.live.join('').includes(TAIL), `${TAIL} to arrive live`);
  }, WAIT_MS * 2 + 10000);

  it('(c) over the hold cap: the head (the first prompt) survives', async () => {
    const { mgr, managed, client } = await recoverWithHeldHead(`rt-1464-cap-${Date.now()}`);

    // Well past 256 KiB of output while still muted. The caret keeps the TAIL
    // marker out of cmd's echo of the typed line (which lands in the held
    // head); only the command's own output spells it.
    const line = 'x'.repeat(100);
    const escapedTail = `${TAIL.slice(0, -4)}^${TAIL.slice(-4)}`;
    managed.ptyProcess.write(`(for /L %i in (1,1,10000) do @echo ${line}) & echo ${escapedTail}\r`);
    await waitFor(() => holdState(managed).heldFull, 'the hold cap to be reached', WAIT_MS * 2);

    mgr.resizeSession(managed.meta.id, 80, 24);
    await waitFor(() => !managed.bridge.isMuted, 'unmute');
    await sleep(UNMUTE_SETTLE_MS);

    const replayed = client.replayed.join('');
    expect(replayed).toContain(HEAD);
    expect(Buffer.byteLength(replayed, 'utf8')).toBeLessThanOrEqual(HOLD_CAP);
    // Nothing past the cap is replayed, so the end of the burst is not in it.
    expect(replayed).not.toContain(TAIL);
  }, WAIT_MS * 3 + 10000);
});
