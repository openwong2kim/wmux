// What a pane's processes get when its shell exits and when the pane is
// closed, on each terminal engine, through a real /bin/sh in DaemonSessionManager.
//
// The node engine (node-pty) is the reference: on the shell's exit it signals
// nothing, so the kernel's hangup is all a leftover process gets, and a pane
// close sends the shell SIGHUP. The rust engine matches that, and adds one
// thing node-pty never does: after HANGUP_GRACE (native_transport.rs), it
// SIGKILLs whatever is left in the session of a pane closed while its shell ran.
//
// Like sessionReattach.engines.os.test.ts, the rust cases skip with a warning
// when the native module is not built, unless WMUX_REQUIRE_RUST_CORE=1.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { rustTerminalCoreAvailable, type TerminalEngine } from '../../shared/terminalCoreSettings';
import { ptyBackend } from '../../shared/terminalPty';
import { loadNativeTerminalCore } from '../../shared/nativeTerminalCore';
import { waitFor, deliberateSleep } from '../../test-utils/waitFor';

const SHELL = '/bin/sh';
const posix = process.platform !== 'win32' && fs.existsSync(SHELL);
const RUST_PROMISED = process.env.WMUX_REQUIRE_RUST_CORE === '1';
const rustAvailable = posix && rustTerminalCoreAvailable();
/** HANGUP_GRACE in core/wmux-term/src/native_transport.rs. */
const HANGUP_GRACE_MS = 5_000;
const WAIT_MS = 20_000;
const TEST_MS = 60_000;

if (posix && !rustAvailable && !RUST_PROMISED) {
  // eslint-disable-next-line no-console
  console.warn('[paneHangup.engines] rust cases SKIPPED: native terminal core not built (npm run build:terminal-core)');
}

/** Running, not a zombie waiting for its parent to reap it. */
function alive(pid: number): boolean {
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch {
    return false;
  }
}

function pidIn(file: string): number {
  try { return Number(fs.readFileSync(file, 'utf8').trim()) || 0; } catch { return 0; }
}

const ENGINES: TerminalEngine[] = ['node', 'rust'];

describe.skipIf(!posix).each(ENGINES)('a pane\'s processes on the %s engine', (engine) => {
  const skip = engine === 'rust' && !rustAvailable && !RUST_PROMISED;
  let prevEngine: string | undefined;
  const managers: DaemonSessionManager[] = [];
  const started: number[] = [];
  let cwd: string;

  beforeAll(() => {
    prevEngine = process.env.WMUX_TERMINAL_CORE;
    // Read at each spawn, so this selects the engine for everything this block creates.
    process.env.WMUX_TERMINAL_CORE = engine;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hup-'));
  });

  afterAll(() => {
    if (prevEngine === undefined) delete process.env.WMUX_TERMINAL_CORE;
    else process.env.WMUX_TERMINAL_CORE = prevEngine;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.disposeAll();
    for (const pid of started.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  async function shell(id: string): Promise<DaemonSessionManager> {
    const mgr = new DaemonSessionManager();
    managers.push(mgr);
    await mgr.createSessionAsync({
      id, cmd: SHELL, cwd, cols: 80, rows: 24,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, PS1: '$ ', TERM: 'xterm-256color', LC_ALL: 'C' },
    });
    // The engine actually in use: a load failure falls back to node silently.
    expect(ptyBackend(mgr.getSession(id)!.ptyProcess)).toBe(engine);
    return mgr;
  }

  const type = (mgr: DaemonSessionManager, id: string, line: string) => mgr.getSession(id)!.ptyProcess.write(`${line}\n`);

  /** Types `line` to run the sh script `body`, which writes its pid to $1, and returns that pid once it runs. */
  async function start(mgr: DaemonSessionManager, id: string, name: string, line: (script: string, pidFile: string) => string, body: string): Promise<number> {
    const script = path.join(cwd, `${id}-${name}.sh`);
    const pidFile = path.join(cwd, `${id}-${name}.pid`);
    fs.writeFileSync(script, body);
    type(mgr, id, line(script, pidFile));
    await waitFor(() => pidIn(pidFile) > 0, WAIT_MS, `${name} to start`);
    const pid = pidIn(pidFile);
    started.push(pid);
    return pid;
  }

  async function shellExit(mgr: DaemonSessionManager, id: string): Promise<void> {
    type(mgr, id, 'exit');
    await waitFor(() => mgr.getSession(id)?.meta.state === 'dead', WAIT_MS, 'the shell\'s exit to be reported');
    await deliberateSleep(500, 'a negative check: a kill on the exit lands before it is reported, give it time anyway');
  }

  it.skipIf(skip)('a nohup job survives the shell\'s exit', async () => {
    const id = `hup-${engine}-nohup`;
    const mgr = await shell(id);
    const job = await start(mgr, id, 'job', (s, p) => `nohup sh ${s} ${p} >/dev/null 2>&1 &`, 'echo $$ > "$1"; exec sleep 60\n');
    await shellExit(mgr, id);
    expect(alive(job)).toBe(true);
  }, TEST_MS);

  it.skipIf(skip)('a background job that keeps the terminal open survives the shell\'s exit, and the exit is still reported', async () => {
    const id = `hup-${engine}-bg`;
    const mgr = await shell(id);
    // Its stdin, stdout and stderr are the terminal: the output never ends while it runs.
    const job = await start(mgr, id, 'job', (s, p) => `sh ${s} ${p} &`, 'echo $$ > "$1"; exec sleep 60\n');
    await shellExit(mgr, id);
    expect(alive(job)).toBe(true);
  }, TEST_MS);

  // macOS revokes the terminal when the shell exits, and the writer's next
  // write fails; on Linux it keeps writing into the terminal it holds open.
  it.skipIf(skip || process.platform !== 'linux')('a background job that writes without pause does not hold back the shell\'s exit', async () => {
    const id = `hup-${engine}-yes`;
    const mgr = await shell(id);
    await start(mgr, id, 'job', (s, p) => `sh ${s} ${p} &`, 'echo $$ > "$1"; exec yes\n');
    type(mgr, id, 'exit');
    await waitFor(() => mgr.getSession(id)?.meta.state === 'dead', WAIT_MS, 'the shell\'s exit to be reported');
  }, TEST_MS);

  it.skipIf(skip)('closing the pane hangs up the program in it, which gets time to act before any SIGKILL', async () => {
    const id = `hup-${engine}-trap`;
    const mgr = await shell(id);
    const marker = path.join(cwd, `${id}.marker`);
    // An agent saving its transcript on SIGHUP: a second of work, then a file.
    const program = await start(mgr, id, 'program', (s, p) => `sh ${s} ${p} ${marker}`, [
      'echo $$ > "$1"; marker=$2',
      // The master's close can hang it up again; that must not cut the work short.
      'on_hup() { trap \'\' HUP; sleep 1; echo saved > "$marker"; exit 0; }',
      'trap on_hup HUP',
      'while :; do sleep 0.1; done',
      '',
    ].join('\n'));
    mgr.destroySession(id);
    await waitFor(() => fs.existsSync(marker), HANGUP_GRACE_MS - 1_000, 'the SIGHUP handler to finish its work');
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('saved');
    await waitFor(() => !alive(program), WAIT_MS, 'the program to exit after its work');
  }, TEST_MS);

  // node-pty never SIGKILLs a pane's processes: a program that ignores SIGHUP
  // outlives the pane there. The rust engine kills it after the grace.
  it.skipIf(skip || engine === 'node')('closing the pane SIGKILLs a program that ignores SIGHUP, after the grace', async () => {
    const id = `hup-${engine}-ignore`;
    const mgr = await shell(id);
    const program = await start(mgr, id, 'program', (s, p) => `sh ${s} ${p}`, 'trap \'\' HUP; echo $$ > "$1"; exec sleep 60\n');
    const closedAt = Date.now();
    mgr.destroySession(id);
    await deliberateSleep(1_500, 'a negative check: within the grace it still runs, nothing was SIGKILLed at the close');
    expect(alive(program)).toBe(true);
    await waitFor(() => !alive(program), HANGUP_GRACE_MS + WAIT_MS, 'the SIGKILL after the grace');
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(HANGUP_GRACE_MS - 250);
  }, TEST_MS);

  it.skipIf(skip || engine === 'node')('closing the pane SIGKILLs a shell that ignores SIGHUP, after the grace, and then sweeps its session', async () => {
    const id = `hup-${engine}-root`;
    const mgr = await shell(id);
    const root = mgr.getSession(id)!.ptyProcess.pid;
    started.push(root);
    type(mgr, id, `trap '' HUP`);
    // A foreground program keeps the shell from reading the hung-up terminal,
    // whose end would make it exit. It inherits the ignored SIGHUP.
    const program = await start(mgr, id, 'program', (s, p) => `sh ${s} ${p}`, 'echo $$ > "$1"; exec sleep 60\n');
    const closedAt = Date.now();
    mgr.destroySession(id);
    await deliberateSleep(1_500, 'a negative check: within the grace the shell still runs, nothing was SIGKILLed at the close');
    expect(alive(root)).toBe(true);
    expect(alive(program)).toBe(true);
    await waitFor(() => !alive(root) && !alive(program), closedAt + HANGUP_GRACE_MS + 1_500 - Date.now(), 'the shell\'s SIGKILL after the grace, then the sweep');
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(HANGUP_GRACE_MS - 250);
  }, TEST_MS);

  // Through the transport itself: once a pane is disposed, its TerminalPty
  // ignores kill(), so nothing above can send one during the grace.
  it.skipIf(skip || engine === 'node')('an explicit SIGKILL during the grace sweeps the session at once', async () => {
    const { NativeTransport } = loadNativeTerminalCore('pty-v1');
    const transport = new NativeTransport(SHELL, [], cwd,
      { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, PS1: '$ ', TERM: 'xterm-256color', LC_ALL: 'C' }, 80, 24, () => undefined);
    started.push(transport.pid);
    const script = path.join(cwd, 'sigkill.sh');
    const pidFile = path.join(cwd, 'sigkill.pid');
    fs.writeFileSync(script, 'trap \'\' HUP; echo $$ > "$1"; exec sleep 60\n');
    transport.write(Buffer.from(`sh ${script} ${pidFile}\n`));
    await waitFor(() => pidIn(pidFile) > 0, WAIT_MS, 'the program to start');
    const program = pidIn(pidFile);
    started.push(program);
    // A pane's close: SIGHUP, then close() arms the grace.
    transport.kill();
    transport.close();
    await deliberateSleep(500, 'a negative check: the grace is under way and the program still runs');
    expect(alive(program)).toBe(true);
    const killedAt = Date.now();
    transport.kill(os.constants.signals.SIGKILL);
    await waitFor(() => !alive(program), HANGUP_GRACE_MS - 1_500, 'the SIGKILL sweep');
    expect(Date.now() - killedAt).toBeLessThan(HANGUP_GRACE_MS - 1_500);
  }, TEST_MS);
});
