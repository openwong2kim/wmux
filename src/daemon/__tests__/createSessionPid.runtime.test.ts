/**
 * #2398 — node-pty 1.2.0-beta against a real Windows ConPTY.
 *
 * The beta connects ConPTY after `spawn` returns, so the PTY's pid is 0 at
 * first and a CreateProcess failure arrives as an exit instead of a throw.
 * createSessionAsync waits for the pid (src/shared/spawnPty.ts). These checks
 * run the real thing:
 *  - the session is registered with the shell's real pid, and everything keyed
 *    on it works: the reap identity (pidCreatedAtFt), the process tree agent
 *    tracking walks, and the pid main writes into the A2A pid map;
 *  - a cwd that no longer exists: the Rust engine's spawn (portable-pty) falls
 *    back to the home folder instead of failing with error 267 as node-pty
 *    did, so the create succeeds, the shell starts in home, and exactly one
 *    session is registered (#3422).
 *
 * Skipped off Windows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { AgentProcessTracker } from '../AgentProcessTracker';
import { getProcessCreatedAtFt } from '../phantomExit';

const SYS = process.env.SystemRoot || 'C:\\Windows';
const CMD_EXE = `${SYS}\\System32\\cmd.exe`;
const onWindows = process.platform === 'win32' && fs.existsSync(CMD_EXE);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!onWindows)('createSessionAsync on a real ConPTY (win32 only)', () => {
  let manager: DaemonSessionManager | undefined;

  afterEach(() => {
    manager?.disposeAll();
    manager = undefined;
  });

  it('registers the shell\'s real pid, and reap identity and process-tree tracking find that shell', async () => {
    const mgr = new DaemonSessionManager();
    manager = mgr;
    const id = `rt-2398-pid-${Date.now()}`;
    const session = await mgr.createSessionAsync({ id, cmd: CMD_EXE, cwd: path.resolve(process.cwd()), cols: 80, rows: 24 });
    const managed = mgr.getSession(id)!;

    // What main writes into the A2A pid map comes from this same value.
    expect(session.pid).toBeGreaterThan(0);
    expect(managed.meta.pid).toBe(session.pid);
    expect(managed.ptyProcess.pid).toBe(session.pid);

    // #646/#2416 reap identity: stamped from the real pid at create time.
    const ft = getProcessCreatedAtFt(session.pid);
    expect(ft).not.toBeNull();
    expect(session.pidCreatedAtFt).toBe(ft!.toString());

    // Agent tracking walks the process tree from this pid: it is cmd.exe, and
    // a command typed into the pane becomes its child.
    const tracker = new AgentProcessTracker({ watch: () => { /* noop */ }, unwatch: () => { /* noop */ } });
    expect(await tracker.idleShellState(session.pid, {}, true)).toEqual({ ok: true });
    managed.ptyProcess.write('ping -n 30 127.0.0.1\r');
    let state = await tracker.idleShellState(session.pid, {}, true);
    for (let i = 0; i < 40 && state.ok; i++) {
      await sleep(250);
      state = await tracker.idleShellState(session.pid, {}, true);
    }
    expect(state).toEqual({ ok: false, reason: 'shell-has-children' });
  }, 60_000);

  it('a cwd that does not exist starts the shell in the home folder and registers one session', async () => {
    const mgr = new DaemonSessionManager();
    manager = mgr;
    const id = `rt-2398-cwd-${Date.now()}`;
    const gone = path.join(os.tmpdir(), `wmux-2398-gone-${process.pid}-${Date.now()}`);
    const created: unknown[] = [];
    mgr.on('session:created', (e) => created.push(e));
    const session = await mgr.createSessionAsync({ id, cmd: CMD_EXE, cwd: gone, cols: 120, rows: 24 });
    expect(session.pid).toBeGreaterThan(0);
    const managed = mgr.getSession(id)!;
    expect(managed).toBeDefined();
    expect(created).toHaveLength(1);

    // cmd's prompt is the current folder followed by `>`. The temp folder sits
    // under home, so match the prompt, not a bare home prefix. ConPTY output
    // carries escape sequences between rows; strip them first.
    const prompt = `${os.homedir().toLowerCase()}>`;
    const screen = () => managed.ringBuffer.readAll().toString('utf8')
      // eslint-disable-next-line no-control-regex -- strips OSC and CSI sequences
      .replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .toLowerCase();
    for (let i = 0; i < 40 && !screen().includes(prompt); i++) await sleep(250);
    expect(screen()).toContain(prompt);
    expect(screen()).not.toContain(gone.toLowerCase());
  }, 30_000);
});
