// A real shell session through the daemon's session layer, on each terminal
// engine (Settings > Terminal > Performance > Terminal engine).
//
// DaemonSessionManager.os.test.ts mocks node-pty, and the rust engine never
// calls node-pty, so that suite cannot say anything about rust. The real-PTY
// suites (recoveryReplay.runtime, createSessionPid.runtime) are cmd.exe only.
// This file drives a real /bin/sh through DaemonSessionManager and SessionPipe,
// wired the way daemon/index.ts wires daemon.attachSession, and runs once per
// engine: create, attach, detach, reattach, the attach snapshot of a large
// ring, a restart that restores the dumped ring, resize and exit.
//
// The native module is built by `npm run build:terminal-core`. Without it the
// rust cases skip with a warning, unless WMUX_REQUIRE_RUST_CORE=1 (set by the
// CI job that builds it), which turns a missing module into a failure: the
// engine falls back to node on a load error, so without that promise a broken
// build would pass here as node.
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { SessionPipe, createSessionPipeMarkers, ATTACH_SNAPSHOT_MIN_BYTES } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { rustTerminalCoreAvailable, type TerminalEngine } from '../../shared/terminalCoreSettings';
import { ptyBackend } from '../../shared/terminalPty';
import { waitFor } from '../../test-utils/waitFor';

const SHELL = '/bin/sh';
const posix = process.platform !== 'win32' && fs.existsSync(SHELL);
const RUST_PROMISED = process.env.WMUX_REQUIRE_RUST_CORE === '1';
const rustAvailable = posix && rustTerminalCoreAvailable();
const TOKEN = 'reattach-engines-token';
const FLUSH_DONE = createSessionPipeMarkers(TOKEN).flushDone;
// A cold shell on a loaded runner is slow; the happy path resolves at once.
const WAIT_MS = 20_000;
const TEST_MS = 60_000;

if (posix && !rustAvailable && !RUST_PROMISED) {
  // eslint-disable-next-line no-console
  console.warn('[sessionReattach.engines] rust cases SKIPPED: native terminal core not built (npm run build:terminal-core)');
}

// macOS's isolated HOME can exceed sockaddr_un.sun_path; keep sockets short.
const socketDir = posix ? fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'wmux-re-')) : null;
afterAll(() => {
  if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
});

interface Client {
  socket: net.Socket;
  wire: () => Buffer;
}

interface Attached {
  pipe: SessionPipe;
  client: Client;
  detach: () => Promise<void>;
}

/** Everything before the flush-done marker: the attach replay. */
function replayOf(wire: Buffer): Buffer | null {
  const at = wire.indexOf(FLUSH_DONE);
  return at === -1 ? null : wire.subarray(0, at);
}

function liveOf(wire: Buffer): string {
  const at = wire.indexOf(FLUSH_DONE);
  return at === -1 ? '' : wire.subarray(at + FLUSH_DONE.length).toString('utf8');
}

async function screenOf(data: Buffer, cols: number, rows: number): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  try {
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buf = term.buffer.active;
    return Array.from({ length: rows }, (_, y) => buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  } finally {
    term.dispose();
  }
}

function connect(pipeName: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(pipeName, () => {
      socket.write(`${TOKEN}\n`);
      resolve({ socket, wire: () => Buffer.concat(chunks) });
    });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
  });
}

/** daemon.attachSession, reduced to the session layer: pipe, output, input. */
async function attach(mgr: DaemonSessionManager, id: string, socketName: string): Promise<Attached> {
  mgr.attachSession(id);
  const managed = mgr.getSession(id)!;
  const pipe = new SessionPipe(id, managed.ringBuffer, TOKEN,
    () => ({ cols: mgr.getSession(id)!.meta.cols, rows: mgr.getSession(id)!.meta.rows }),
    () => mgr.getSession(id)?.bridge.outputModes ?? null);
  vi.spyOn(pipe, 'getPipeName').mockReturnValue(path.join(socketDir!, `${socketName}.sock`));
  const onData = (data: Buffer) => pipe.writeToClient(data);
  managed.bridge.on('data', onData);
  pipe.onInput((data) => {
    managed.ptyProcess.write(data);
    managed.bridge.noteInput(data.toString());
  });
  let client: Client | undefined;
  const detach = async () => {
    client?.socket.destroy();
    managed.bridge.removeListener('data', onData);
    await pipe.stop();
    if (mgr.getSession(id)?.meta.state !== 'dead') mgr.detachSession(id);
  };
  try {
    await pipe.start();
    client = await connect(pipe.getPipeName());
    const connected = client;
    await waitFor(() => replayOf(connected.wire()) !== null, WAIT_MS, 'attach flush');
    return { pipe, client, detach };
  } catch (err) {
    // A failed attach must not leave its pipe listening into the retry.
    await detach().catch(() => undefined);
    throw err;
  }
}

/** The newest bytes only: the bulk test polls this on a ring of several hundred KB. */
function ringText(mgr: DaemonSessionManager, id: string): string {
  return mgr.getSession(id)!.ringBuffer.readAll().subarray(-4096).toString('utf8');
}

// `printf '%s-%s\n' rx NAME` prints `rx-NAME`; the echoed command line does not
// contain that string, so a match is the command's output, not its echo.
const say = (name: string) => `printf '%s-%s\\n' rx ${name}\n`;
const out = (name: string) => `rx-${name}`;

const ENGINES: TerminalEngine[] = ['node', 'rust'];

describe.skipIf(!posix).each(ENGINES)('a real shell session on the %s engine', (engine) => {
  const skip = engine === 'rust' && !rustAvailable && !RUST_PROMISED;
  let prevEngine: string | undefined;
  const managers: DaemonSessionManager[] = [];
  const detaches: Array<() => Promise<void>> = [];
  let cwd: string;

  beforeAll(() => {
    prevEngine = process.env.WMUX_TERMINAL_CORE;
    // Read at each spawn and ring construction, so this selects the engine
    // for everything this block creates.
    process.env.WMUX_TERMINAL_CORE = engine;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-re-cwd-'));
  });

  afterAll(() => {
    if (prevEngine === undefined) delete process.env.WMUX_TERMINAL_CORE;
    else process.env.WMUX_TERMINAL_CORE = prevEngine;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const d of detaches.splice(0)) await d().catch(() => undefined);
    for (const m of managers.splice(0)) m.disposeAll();
  });

  async function create(mgr: DaemonSessionManager, id: string, extra: { scrollbackData?: Buffer; deferOutput?: boolean } = {}) {
    managers.push(mgr);
    await mgr.createSessionAsync({
      id, cmd: SHELL, cwd, cols: 80, rows: 24,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, PS1: '$ ', TERM: 'xterm-256color', LC_ALL: 'C' },
      ...extra,
    });
    const managed = mgr.getSession(id)!;
    // The engine actually in use, not the one asked for: a load failure
    // falls back to node silently.
    expect(ptyBackend(managed.ptyProcess)).toBe(engine);
    expect(managed.ringBuffer.backend).toBe(engine);
    return managed;
  }

  async function attachTracked(mgr: DaemonSessionManager, id: string, socketName: string): Promise<Attached> {
    const a = await attach(mgr, id, socketName);
    detaches.push(a.detach);
    return a;
  }

  it.skipIf(skip)('the native module is loadable when the rust engine is promised', () => {
    if (engine === 'rust') expect(rustTerminalCoreAvailable()).toBe(true);
    expect(new RingBuffer(1024).backend).toBe(engine);
  });

  it.skipIf(skip)('reattaches after a disconnect and replays output written while detached', async () => {
    const mgr = new DaemonSessionManager();
    const id = `re-${engine}-reattach`;
    await create(mgr, id);

    const first = await attachTracked(mgr, id, `${engine}-a1`);
    first.client.socket.write(say('LIVE1'));
    await waitFor(() => liveOf(first.client.wire()).includes(out('LIVE1')), WAIT_MS, 'live output on the first attach');
    await first.detach();
    expect(mgr.getSession(id)!.meta.state).toBe('detached');

    // Nobody attached: the output goes only to the ring.
    mgr.getSession(id)!.ptyProcess.write(say('DETACHED'));
    await waitFor(() => ringText(mgr, id).includes(out('DETACHED')), WAIT_MS, 'detached output in the ring');

    const second = await attachTracked(mgr, id, `${engine}-a2`);
    const replay = replayOf(second.client.wire())!.toString('utf8');
    expect(replay).toContain(out('LIVE1'));
    expect(replay).toContain(out('DETACHED'));
    second.client.socket.write(say('LIVE2'));
    await waitFor(() => liveOf(second.client.wire()).includes(out('LIVE2')), WAIT_MS, 'live output after reattach');
  }, TEST_MS);

  it.skipIf(skip)('serves a large ring as a snapshot with the same screen', async () => {
    const mgr = new DaemonSessionManager();
    const id = `re-${engine}-snapshot`;
    const managed = await create(mgr, id);
    // Redraw frames (clear, then repaint), like a progress bar or a TUI: the
    // final screen is a few rows however much was written. Pure-append output
    // keeps every line in the snapshot's scrollback, gains nothing, and is
    // shipped raw (SessionPipe's no-gain fallback).
    const frames = Math.ceil((ATTACH_SNAPSHOT_MIN_BYTES * 1.5) / 64);
    managed.ptyProcess.write(`i=0; while [ $i -lt ${frames} ]; do printf '\\033[H\\033[2Jframe %06d %s\\n' $i ................................................; i=$((i+1)); done; ${say('BULK')}`);
    await waitFor(() => ringText(mgr, id).includes(out('BULK')), WAIT_MS, 'bulk output to finish');
    // Wait for the prompt after the last line, so the ring is still while it is compared.
    await waitFor(() => ringText(mgr, id).trimEnd().endsWith('$'), WAIT_MS, 'prompt after the bulk output');
    expect(managed.ringBuffer.size).toBeGreaterThanOrEqual(ATTACH_SNAPSHOT_MIN_BYTES);

    // On the rust engine the ANSI attach snapshot is the native one
    // (AnsiSnapshotBackend.ts); on node it is xterm's.
    const a = await attachTracked(mgr, id, `${engine}-s`);
    const replay = replayOf(a.client.wire())!;
    // A snapshot, not the raw ring...
    expect(replay.length).toBeLessThan(managed.ringBuffer.size);
    // ...showing the same screen.
    expect(await screenOf(replay, 80, 24)).toEqual(await screenOf(managed.ringBuffer.readAll(), 80, 24));
  }, TEST_MS);

  it.skipIf(skip)('restores the dumped ring after a restart, then goes live at the first resize', async () => {
    const id = `re-${engine}-restore`;
    const old = new DaemonSessionManager();
    const oldManaged = await create(old, id);
    oldManaged.ptyProcess.write(say('BEFORE'));
    await waitFor(() => ringText(old, id).includes(out('BEFORE')), WAIT_MS, 'output before the restart');
    const buf = path.join(cwd, `${id}.buf`);
    await oldManaged.ringBuffer.dumpToFile(buf);
    old.disposeAll();

    // What startup recovery does with a suspended session's .buf.
    const mgr = new DaemonSessionManager();
    const managed = await create(mgr, id, { scrollbackData: fs.readFileSync(buf), deferOutput: true });
    expect(managed.bridge.isMuted).toBe(true);
    const a = await attachTracked(mgr, id, `${engine}-r`);
    expect(replayOf(a.client.wire())!.toString('utf8')).toContain(out('BEFORE'));

    mgr.resizeSession(id, 80, 24);
    await waitFor(() => !managed.bridge.isMuted, WAIT_MS, 'unmute after the first resize');
    a.client.socket.write(say('AFTER'));
    await waitFor(() => liveOf(a.client.wire()).includes(out('AFTER')), WAIT_MS, 'live output after the restore');
  }, TEST_MS);

  it.skipIf(skip)('resizes the PTY and reports the exit code', async () => {
    const mgr = new DaemonSessionManager();
    const id = `re-${engine}-exit`;
    await create(mgr, id);
    const a = await attachTracked(mgr, id, `${engine}-e`);

    mgr.resizeSession(id, 100, 30);
    expect(mgr.getSession(id)!.meta).toMatchObject({ cols: 100, rows: 30 });
    a.client.socket.write(`stty size | sed 's/^/rx-size /'\n`);
    await waitFor(() => liveOf(a.client.wire()).includes('rx-size 30 100'), WAIT_MS, 'the shell to see the new size');

    const died = new Promise<{ id: string; exitCode: number | null }>((resolve) => {
      mgr.once('session:died', resolve);
    });
    a.client.socket.write('exit 3\n');
    expect((await died).exitCode).toBe(3);
    expect(mgr.getSession(id)!.meta.state).toBe('dead');
  }, TEST_MS);
});
