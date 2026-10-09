/**
 * #1965 — the bundled ConPTY (node-pty's conpty.dll + OpenConsole) against the
 * real thing. It is the default backend on every Windows build (#910, #1932);
 * this suite still pins it with WMUX_CONPTY_BACKEND so it keeps testing
 * OpenConsole whatever the runner's build or a demotion would pick.
 *
 * Two behaviours of OpenConsole that the in-box ConPTY does not share:
 *  - it writes a DA1 query (`CSI c`) at startup and holds the shell's output
 *    until it is answered, or for about 3 s;
 *  - it emits nothing at all on resize, so a recovered pane cannot get its
 *    prompt back from a repaint request.
 *
 * Skipped off Windows.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ManagedSession } from '../DaemonSessionManager';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { STARTUP_DA1_REPLY } from '../DaemonPTYBridge';
import { CONPTY_BACKEND_ENV } from '../../shared/conptyWindows';

const SYS = process.env.SystemRoot || 'C:\\Windows';
const CMD_EXE = `${SYS}\\System32\\cmd.exe`;
const onWindows = process.platform === 'win32' && fs.existsSync(CMD_EXE);

const WAIT_MS = 60000;
const PROMPT = /[A-Za-z]:\\[^\r\n]*>/;
const MARK = 'WMUX-MARK-1965';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, label: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** Create a session on the bundled backend and record what is written to it. */
function createBundled(
  mgr: DaemonSessionManager,
  id: string,
  extra: { deferOutput?: boolean; scrollbackData?: Buffer } = {},
): { managed: ManagedSession; writes: string[]; createdAt: number } {
  const prev = process.env[CONPTY_BACKEND_ENV];
  process.env[CONPTY_BACKEND_ENV] = 'bundled';
  const createdAt = Date.now();
  try {
    mgr.createSession({ id, cmd: CMD_EXE, cwd: path.resolve(process.cwd()), cols: 80, rows: 24, ...extra });
  } finally {
    if (prev === undefined) delete process.env[CONPTY_BACKEND_ENV];
    else process.env[CONPTY_BACKEND_ENV] = prev;
  }
  const managed = mgr.getSession(id);
  if (!managed) throw new Error(`session ${id} was not created`);
  // The PTY's output arrives asynchronously, so wrapping write here still
  // sees the startup reply.
  const writes: string[] = [];
  const write = managed.ptyProcess.write.bind(managed.ptyProcess);
  managed.ptyProcess.write = (data: string | Buffer) => {
    writes.push(data.toString());
    write(data);
  };
  return { managed, writes, createdAt };
}

describe.skipIf(!onWindows)('bundled ConPTY — real OpenConsole (win32 only)', () => {
  let manager: DaemonSessionManager | undefined;

  afterEach(() => {
    manager?.disposeAll();
    manager = undefined;
  });

  it('a new pane: the startup DA1 is answered once and the prompt arrives with no garbage', async () => {
    const mgr = new DaemonSessionManager();
    manager = mgr;
    const { managed, writes, createdAt } = createBundled(mgr, `rt-1965-new-${Date.now()}`);
    // A demotion to in-box here would mean the bundled DLL did not load.
    expect(managed.conptyBackend).toBe('bundled');

    const ring = () => managed.ringBuffer.readAll().toString('utf8');
    await waitFor(() => PROMPT.test(ring()), 'the first prompt');
    const promptMs = Date.now() - createdAt;
    expect(writes).toEqual([STARTUP_DA1_REPLY]);

    // The reply went to the pseudo console, not to the shell: cmd never saw
    // it as typed text.
    managed.ptyProcess.write(`echo ${MARK}\r`);
    await waitFor(() => ring().split(MARK).length >= 3, `${MARK} echoed and printed`);
    expect(ring()).not.toContain('62;4;9;22c');
    // Unanswered, OpenConsole holds the prompt for about 3 s.
    expect(promptMs).toBeLessThan(2500);
  }, WAIT_MS + 10000);

  it('a recovered pane: the prompt printed while muted arrives after a size change without a keypress', async () => {
    const mgr = new DaemonSessionManager();
    manager = mgr;
    const { managed, writes } = createBundled(mgr, `rt-1965-rec-${Date.now()}`, {
      deferOutput: true,
      scrollbackData: Buffer.from('WMUX-HISTORY-1965\r\n'),
    });
    expect(managed.conptyBackend).toBe('bundled');
    expect(managed.bridge.isMuted).toBe(true);

    const replayed: string[] = [];
    const live: string[] = [];
    let inUnmute = false;
    managed.bridge.on('data', (buf: Buffer) => (inUnmute ? replayed : live).push(buf.toString('utf8')));
    const setMuted = managed.bridge.setMuted.bind(managed.bridge);
    managed.bridge.setMuted = (muted, opts) => {
      inUnmute = !muted;
      try {
        setMuted(muted, opts);
      } finally {
        inUnmute = false;
      }
    };

    // The startup DA1 is answered while muted, so the prompt gets printed
    // (and held) without the 3 s wait.
    const held = () => ((managed.bridge as unknown as { heldWhileMuted: string[] | null }).heldWhileMuted ?? []).join('');
    await waitFor(() => PROMPT.test(held()), 'the prompt to be held while muted');
    expect(writes).toEqual([STARTUP_DA1_REPLY]);

    // Same size, then a change inside the drain window (the Resume row).
    mgr.resizeSession(managed.meta.id, 80, 24);
    mgr.resizeSession(managed.meta.id, 80, 22);
    await waitFor(() => !managed.bridge.isMuted, 'unmute');

    // OpenConsole sends nothing on resize; the held prompt is what arrives.
    expect(replayed.join('')).toMatch(PROMPT);
    // Stripped from the replay, so a renderer never answers it again.
    expect(replayed.join('')).not.toContain('\x1b[c');
    managed.ptyProcess.write(`echo ${MARK}\r`);
    await waitFor(() => live.join('').includes(MARK), `${MARK} to arrive live`);
  }, WAIT_MS * 2 + 10000);
});
