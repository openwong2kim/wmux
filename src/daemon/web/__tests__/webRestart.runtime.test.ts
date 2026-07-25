import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * #596 regression — `wmux web` must survive a daemon restart.
 *
 * This is deliberately a LIVE test against the real bundled daemon rather than
 * a unit test of restoreWebServer(). The bug was never in one function; it was
 * that the boot sequence had no restore step at all and nothing persisted the
 * operator's decision. Only a real "kill the daemon, start another one against
 * the same data dir" proves the seam, which is exactly how the issue was filed.
 *
 * Skipped when `dist/daemon-bundle/index.js` is absent (a plain `vitest` run on
 * a tree that has not been built) and on non-Windows, where the daemon control
 * transport is a unix socket this harness does not construct. The skip is
 * loud — a silently-skipped regression test is a regression test you do not
 * have.
 */
const BUNDLE = path.join(process.cwd(), 'dist', 'daemon-bundle', 'index.js');
const HAVE_BUNDLE = fs.existsSync(BUNDLE);
const IS_WIN = process.platform === 'win32';
const CAN_RUN = HAVE_BUNDLE && IS_WIN;

if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    `[#596 restart test] SKIPPED — ${!IS_WIN ? 'not win32' : 'no dist/daemon-bundle/index.js (run `npm run build:daemon`)'}`,
  );
}

const SUFFIX = '-webrestart-test';
const WMUX_DIR = path.join(os.homedir(), `.wmux${SUFFIX}`);
const PIPE = `\\\\.\\pipe\\wmux-daemon${SUFFIX}-${os.userInfo().username || 'default'}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RpcResult {
  running?: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  token?: string;
  [k: string]: unknown;
}

function rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    let token: string;
    try {
      token = fs.readFileSync(path.join(WMUX_DIR, 'daemon-auth-token'), 'utf8').trim();
    } catch {
      reject(new Error('daemon auth token not written yet'));
      return;
    }
    const id = crypto.randomUUID();
    const sock = net.connect(PIPE);
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`RPC timeout: ${method}`))), 10_000);
    sock.on('connect', () =>
      sock.write(JSON.stringify({ id, method, params, token, clientName: 'wmux-cli' }) + '\n'),
    );
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res = JSON.parse(line) as { id: string; result?: RpcResult };
          if (res.id === id) finish(() => resolve(res.result ?? {}));
        } catch {
          /* ignore malformed lines */
        }
      }
    });
    sock.on('error', (e) => finish(() => reject(e)));
    sock.on('close', () => finish(() => reject(new Error('closed before reply'))));
  });
}

/** GET against the web server. Resolves an error code instead of throwing. */
function probe(port: number, urlPath: string, token?: string): Promise<{ status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        timeout: 4000,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'TIMEOUT' });
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

/** An OS-assigned free port, so a parallel wmux on this box is never disturbed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const spawned: ChildProcess[] = [];

async function startDaemon(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, WMUX_DATA_SUFFIX: SUFFIX },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  child.stdout?.resume();
  child.stderr?.resume();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      await rpc('daemon.ping');
      return child;
    } catch {
      /* not ready yet */
    }
  }
  throw new Error('daemon never became ready');
}

/** SIGKILL — no graceful shutdown, which is what a crash or a reboot looks like. */
async function killDaemon(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    child.once('exit', done);
    try {
      child.kill('SIGKILL');
    } catch {
      done();
    }
    setTimeout(done, 5000);
  });
  await sleep(1500);
}

/**
 * Kill every daemon this file spawned, THEN wipe the data dir.
 *
 * Order matters: a live daemon holds the single-instance lock, so a follow-up
 * startDaemon() would exit immediately while `daemon.ping` still answered from
 * the stale process — the harness would test the previous test's daemon.
 */
async function resetFixture(): Promise<void> {
  while (spawned.length) {
    const c = spawned.pop();
    if (c && c.exitCode === null) await killDaemon(c);
  }
  try {
    fs.rmSync(WMUX_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

beforeEach(resetFixture);
afterAll(resetFixture);

describe.skipIf(!CAN_RUN)('#596 — wmux web survives a daemon restart', () => {
  it(
    'restores the listener AND the token after the daemon is killed and replaced',
    async () => {
      const port = await freePort();

      // ── the operator says "yes, serve this" ──
      const d1 = await startDaemon();
      expect((await rpc('daemon.web.status')).running).toBe(false); // lazy default intact
      const started = await rpc('daemon.web.start', {
        port,
        host: '127.0.0.1',
        allowInput: true,
        allowedHosts: ['box.example.ts.net'],
      });
      expect(started.running).toBe(true);
      const token = started.token as string;
      expect(token).toBeTruthy();
      expect(await probe(port, '/api/config', token)).toEqual({ status: 200 });

      // ── crash / reboot / one-click update restart ──
      await killDaemon(d1);
      expect((await probe(port, '/api/config', token)).error).toBeTruthy();

      // ── a fresh daemon against the same data dir ──
      await startDaemon();
      const after = await rpc('daemon.web.status');

      // The listener is back...
      expect(after.running).toBe(true);
      expect(after.port).toBe(port);
      // ...with the operator's exact options, not a safe-but-useless subset.
      expect(after.allowInput).toBe(true);
      expect(after.host).toBe('127.0.0.1');
      // ...and the token the phone still holds keeps working, so a browser left
      // open reconnects on its own with nobody at the desktop.
      expect(after.token).toBe(token);
      expect(await probe(port, '/api/config', token)).toEqual({ status: 200 });
    },
    120_000,
  );

  it(
    'an explicit stop is remembered too — and revokes the token',
    async () => {
      const port = await freePort();

      const d1 = await startDaemon();
      const started = await rpc('daemon.web.start', { port, host: '127.0.0.1', allowInput: false });
      const token = started.token as string;
      await rpc('daemon.web.stop');
      await killDaemon(d1);

      await startDaemon();
      // "Stop" is an operator decision as much as "start" — it must survive too,
      // or every restart would resurrect a server the operator turned off.
      expect((await rpc('daemon.web.status')).running).toBe(false);

      // And the old token is dead: a re-start after a stop mints a fresh one.
      const restarted = await rpc('daemon.web.start', { port, host: '127.0.0.1', allowInput: false });
      expect(restarted.token).not.toBe(token);
      expect((await probe(port, '/api/config', token)).status).toBe(401);
    },
    120_000,
  );

  it(
    '--new-token rotates on demand, revoking every paired device',
    async () => {
      const port = await freePort();

      await startDaemon();
      const first = await rpc('daemon.web.start', { port, host: '127.0.0.1', allowInput: false });
      const oldToken = first.token as string;

      // A plain re-start (e.g. adding --allow-host) must NOT lock out the phone.
      const readded = await rpc('daemon.web.start', {
        port,
        host: '127.0.0.1',
        allowInput: false,
        allowedHosts: ['box.example.ts.net'],
      });
      expect(readded.token).toBe(oldToken);

      // `--new-token` is the deliberate revocation path.
      const rotated = await rpc('daemon.web.start', {
        port,
        host: '127.0.0.1',
        allowInput: false,
        newToken: true,
      });
      expect(rotated.token).not.toBe(oldToken);
      expect((await probe(port, '/api/config', oldToken)).status).toBe(401);
      expect((await probe(port, '/api/config', rotated.token as string)).status).toBe(200);
    },
    120_000,
  );
});
