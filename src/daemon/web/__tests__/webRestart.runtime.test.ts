import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { createTlsTestFixture, findOpenSsl } from './tlsTestFixture';

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
const HAVE_OPENSSL = findOpenSsl() !== undefined;

if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    `[#596 restart test] SKIPPED — ${!IS_WIN ? 'not win32' : 'no dist/daemon-bundle/index.js (run `npm run build:daemon`)'}`,
  );
}
if (CAN_RUN && !HAVE_OPENSSL) {
  // eslint-disable-next-line no-console
  console.warn('[#764 restart test] SKIPPED native TLS case — OpenSSL is unavailable');
}

/**
 * Set by the one CI job that promises to build the bundle before running the
 * suites. Without it a skip is indistinguishable from a pass: this file spent
 * its whole life skipped in CI because no workflow ran `npm run build:daemon`,
 * so it could not have caught a #596 regression at any point. The guard below
 * turns a broken promise into a red test instead of silence.
 */
const BUNDLE_PROMISED = process.env.WMUX_REQUIRE_DAEMON_BUNDLE === '1';

const SUFFIX = '-webrestart-test';
const WMUX_DIR = path.join(os.homedir(), `.wmux${SUFFIX}`);
const PIPE = `\\\\.\\pipe\\wmux-daemon${SUFFIX}-${os.userInfo().username || 'default'}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RpcResult {
  running?: boolean;
  port?: number;
  host?: string;
  allowInput?: boolean;
  tls?: boolean;
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
          const res = JSON.parse(line) as {
            id: string;
            ok?: boolean;
            result?: RpcResult;
            error?: string;
          };
          if (res.id === id) {
            finish(() => {
              if (res.ok === false) {
                reject(new Error(res.error ?? `${method}: daemon rejected the request`));
              } else {
                resolve(res.result ?? {});
              }
            });
          }
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
function probe(
  port: number,
  urlPath: string,
  token?: string,
  secure = false,
): Promise<{ status?: number; error?: string }> {
  return new Promise((resolve) => {
    const options = {
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      timeout: 4000,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const onResponse = (res: http.IncomingMessage): void => {
      res.resume();
      resolve({ status: res.statusCode });
    };
    const req = secure
      ? https.request({ ...options, rejectUnauthorized: false }, onResponse)
      : http.request(options, onResponse);
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'TIMEOUT' });
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

/** JSON GET used for the live pairing exchange. */
function requestJson(
  port: number,
  urlPath: string,
  secure = false,
): Promise<{ status?: number; body?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const options = {
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      timeout: 4000,
    };
    const onResponse = (res: http.IncomingMessage): void => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) as unknown });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    };
    const req = secure
      ? https.request({ ...options, rejectUnauthorized: false }, onResponse)
      : http.request(options, onResponse);
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

/**
 * Everything a spawned daemon printed. A boot's own log is the only witness
 * that says WHICH code path ran — a filesystem side effect cannot, because
 * more than one writer touches the same file (see awaitWebStateReHarden).
 */
const daemonOutput = new WeakMap<ChildProcess, string[]>();

function outputOf(child: ChildProcess): string {
  return (daemonOutput.get(child) ?? []).join('');
}

async function startDaemon(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, WMUX_DATA_SUFFIX: SUFFIX },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  const chunks: string[] = [];
  daemonOutput.set(child, chunks);
  // Attaching a 'data' listener also resumes the stream, so this replaces the
  // resume() that used to drop every line on the floor.
  const capture = (chunk: Buffer): void => void chunks.push(chunk.toString());
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
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

/** What `secureWriteTokenFile` prints when it hardens a NEW record inline. */
const SYNC_HARDEN = '[security] fresh token ACL harden';
/** What the boot's deferred, off-event-loop re-harden of an EXISTING record prints. */
const DEFERRED_HARDEN = '[security] deferred token ACL re-harden';

/** Lines this daemon printed about hardening `web-state.json` specifically —
 *  the same primitive also hardens the auth token and the device store. */
function hardenLines(child: ChildProcess, marker: string): string[] {
  return outputOf(child)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(marker) && line.includes('(web-state.json)'));
}

/**
 * Wait for the restore's deferred ACL re-harden of `web-state.json` to finish.
 *
 * This is why a filesystem check cannot be the evidence here. The re-harden
 * rewrites the record through a FRESH INODE, so mtime and inode both move
 * ~80 ms into every boot whether or not the restore wrote anything itself. An
 * earlier revision asserted `mtimeMs` was unchanged and passed only by
 * observing the file before that rewrite landed — inserting a 1.5 s sleep
 * ahead of the same assertion failed it every time.
 *
 * Waiting for the completion line puts the observation AFTER both candidate
 * writers, and doubles as proof the restore path ran at all.
 */
async function awaitWebStateReHarden(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (hardenLines(child, DEFERRED_HARDEN).length > 0) return;
    await sleep(100);
  }
  throw new Error(
    `restored daemon never logged a deferred re-harden of web-state.json:\n${outputOf(child)}`,
  );
}

/** SIGKILL — no graceful shutdown, which is what a crash or a reboot looks like. */
async function killDaemon(child: ChildProcess): Promise<void> {
  let exited = child.exitCode !== null || child.signalCode !== null;
  await new Promise<void>((resolve) => {
    if (exited) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (didExit: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (didExit) exited = true;
      resolve();
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), 5000);
    child.once('exit', onExit);
    try {
      child.kill('SIGKILL');
    } catch {
      finish(false);
    }
  });
  // Explicitly killed daemons must not make the next beforeEach wait for them
  // again. Unexpectedly live children stay registered for resetFixture.
  if (exited) {
    const index = spawned.indexOf(child);
    if (index >= 0) spawned.splice(index, 1);
  }
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

// Deliberately OUTSIDE the skipIf above: it has to run precisely in the case
// where the suite itself cannot. A green log that says nothing is how this file
// went unrun for its whole life.
describe.runIf(BUNDLE_PROMISED)('#596 restart suite prerequisites', () => {
  it('has the daemon bundle the promising job was supposed to build', () => {
    expect(HAVE_BUNDLE).toBe(true);
  });
});

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
      const d2 = await startDaemon();
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
      // Restore must not rewrite an identical state record: on Windows that
      // no-op would synchronously shell out for ACL hardening and freeze the
      // daemon event loop for seconds. The daemon's own log is the witness —
      // that synchronous harden is exactly what a saveWebState would print,
      // and the deferred re-harden a restore DOES perform is a different line.
      await awaitWebStateReHarden(d2);
      expect(hardenLines(d2, SYNC_HARDEN)).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!HAVE_OPENSSL)(
    'restores native HTTPS without key material or plaintext downgrade',
    async () => {
      const fixture = createTlsTestFixture();
      try {
        const port = await freePort();

        const d1 = await startDaemon();
        const started = await rpc('daemon.web.start', {
          port,
          host: '127.0.0.1',
          allowInput: false,
          allowedHosts: ['localhost'],
          tls: { certPath: fixture.certPath, keyPath: fixture.keyPath },
        });
        const token = started.token as string;
        expect(started.tls).toBe(true);
        expect(await probe(port, '/api/config', token, true)).toEqual({ status: 200 });

        // An option-only caller such as the GUI does not have the private-key
        // path. Omitting `tls` must preserve HTTPS rather than downgrade it.
        const reconfigured = await rpc('daemon.web.start', {
          port,
          host: '127.0.0.1',
          allowInput: true,
          allowedHosts: ['localhost'],
        });
        expect(reconfigured.tls).toBe(true);
        expect(reconfigured.allowInput).toBe(true);
        expect(await probe(port, '/api/config', token, true)).toEqual({ status: 200 });

        const statePath = path.join(WMUX_DIR, 'web-state.json');
        const rawState = fs.readFileSync(statePath, 'utf8');
        const persisted = JSON.parse(rawState) as {
          tls?: { certPath?: string; keyPath?: string };
        };
        expect(persisted.tls).toEqual({
          certPath: fixture.certPath,
          keyPath: fixture.keyPath,
        });
        expect(rawState).not.toContain(fs.readFileSync(fixture.keyPath, 'utf8').trim());

        await killDaemon(d1);
        expect((await probe(port, '/api/config', token, true)).error).toBeTruthy();

        const d2 = await startDaemon();
        const restored = await rpc('daemon.web.status');
        expect(restored.running).toBe(true);
        expect(restored.tls).toBe(true);
        expect(restored.port).toBe(port);
        expect(restored.token).toBe(token);
        expect(await probe(port, '/api/config', token, true)).toEqual({ status: 200 });
        expect((await probe(port, '/api/config', token)).error).toBeTruthy();
        // Same contract as the plaintext case, same witness — see above.
        await awaitWebStateReHarden(d2);
        expect(hardenLines(d2, SYNC_HARDEN)).toEqual([]);

        // Losing a persisted key must leave no listener at all after restart;
        // silently replaying the same port as HTTP would expose the bearer token.
        await killDaemon(d2);
        fs.unlinkSync(fixture.keyPath);
        await startDaemon();
        expect((await rpc('daemon.web.status')).running).toBe(false);
        expect((await probe(port, '/api/config', token, true)).error).toBeTruthy();
        expect((await probe(port, '/api/config', token)).error).toBeTruthy();

        // The failed restore does not erase the operator's TLS configuration.
        // If the files are repaired, a later restart can recover it.
        const failedState = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
          tls?: { certPath?: string; keyPath?: string };
          [key: string]: unknown;
        };
        expect(failedState.tls).toEqual({
          certPath: fixture.certPath,
          keyPath: fixture.keyPath,
        });

        // A syntactically malformed TLS record is also fail-closed. A GUI
        // option-only start did not choose a new transport, so it must surface
        // the corruption rather than silently opening plaintext HTTP.
        fs.writeFileSync(
          statePath,
          JSON.stringify({
            ...failedState,
            tls: { certPath: fixture.certPath, keyPath: 'relative-key.pem' },
          }),
          'utf8',
        );
        await expect(
          rpc('daemon.web.start', {
            port,
            host: '127.0.0.1',
            allowInput: false,
          }),
        ).rejects.toThrow('persisted web TLS configuration is invalid');
        expect((await rpc('daemon.web.status')).running).toBe(false);

        // An explicit transport choice repairs the record. Crossing to HTTP
        // rotates the HTTPS credential before the listener is exposed.
        const fallback = await rpc('daemon.web.start', {
          port,
          host: '127.0.0.1',
          allowInput: false,
          tls: false,
        });
        const fallbackToken = fallback.token as string;
        expect(fallback.tls).toBe(false);
        expect(fallbackToken).toBeTruthy();
        expect(fallbackToken).not.toBe(token);
        expect(await probe(port, '/api/config', fallbackToken)).toEqual({ status: 200 });
        expect((await probe(port, '/api/config', token)).status).toBe(401);
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );

  it.skipIf(!HAVE_OPENSSL)(
    'rotates operator and device credentials when native HTTPS is explicitly downgraded to HTTP',
    async () => {
      const fixture = createTlsTestFixture();
      try {
        const port = await freePort();
        await startDaemon();
        const secure = await rpc('daemon.web.start', {
          port,
          host: '127.0.0.1',
          allowInput: false,
          tls: { certPath: fixture.certPath, keyPath: fixture.keyPath },
        });
        const secureToken = secure.token as string;
        expect(secure.tls).toBe(true);
        expect(await probe(port, '/api/config', secureToken, true)).toEqual({ status: 200 });

        const paired = await requestJson(
          port,
          `/api/pair?code=${encodeURIComponent(secure.pairCode as string)}`,
          true,
        );
        expect(paired.status).toBe(200);
        const deviceToken = (paired.body as { token?: string }).token as string;
        expect(deviceToken).toBeTruthy();
        expect(await probe(port, '/api/config', deviceToken, true)).toEqual({ status: 200 });

        const plaintext = await rpc('daemon.web.start', {
          port,
          host: '127.0.0.1',
          allowInput: false,
          tls: false,
        });
        const plaintextToken = plaintext.token as string;
        expect(plaintext.tls).toBe(false);
        expect(plaintextToken).toBeTruthy();
        expect(plaintextToken).not.toBe(secureToken);
        expect(await probe(port, '/api/config', plaintextToken)).toEqual({ status: 200 });
        expect((await probe(port, '/api/config', secureToken)).status).toBe(401);
        expect((await probe(port, '/api/config', deviceToken)).status).toBe(401);
        expect((await probe(port, '/api/config', plaintextToken, true)).error).toBeTruthy();
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );

  it(
    'an explicit stop is remembered too — and revokes every web credential',
    async () => {
      const port = await freePort();

      const d1 = await startDaemon();
      const started = await rpc('daemon.web.start', { port, host: '127.0.0.1', allowInput: false });
      const token = started.token as string;
      const paired = await requestJson(
        port,
        `/api/pair?code=${encodeURIComponent(started.pairCode as string)}`,
      );
      const deviceToken = (paired.body as { token?: string }).token as string;
      expect(paired.status).toBe(200);
      expect(deviceToken).toBeTruthy();
      expect(await probe(port, '/api/config', deviceToken)).toEqual({ status: 200 });
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
      expect((await probe(port, '/api/config', deviceToken)).status).toBe(401);
    },
    120_000,
  );

  it(
    'a durable-stop write failure rejects the RPC after the live listener is down',
    async () => {
      const port = await freePort();

      await startDaemon();
      const started = await rpc('daemon.web.start', {
        port,
        host: '127.0.0.1',
        allowInput: false,
      });
      const token = started.token as string;
      const statePath = path.join(WMUX_DIR, 'web-state.json');

      // A same-name directory makes both unlink and overwrite fail while
      // remaining portable and recoverable inside this disposable fixture.
      fs.rmSync(statePath, { force: true });
      fs.mkdirSync(statePath);

      try {
        await expect(rpc('daemon.web.stop')).rejects.toThrow(
          'persisted state could not be revoked',
        );
        expect((await rpc('daemon.web.status')).running).toBe(false);
        expect((await probe(port, '/api/config', token)).error).toBeTruthy();
      } finally {
        fs.rmSync(statePath, { recursive: true, force: true });
      }
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

      // `--new-token` is the deliberate same-transport revocation path.
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

  it(
    'a rotated start fails closed when the new web state cannot be persisted',
    async () => {
      const port = await freePort();
      await startDaemon();
      const first = await rpc('daemon.web.start', {
        port,
        host: '127.0.0.1',
        allowInput: false,
      });
      const oldToken = first.token as string;
      const statePath = path.join(WMUX_DIR, 'web-state.json');

      // A same-name directory defeats placeholder creation, deletion, and the
      // emergency disabled overwrite. This is the store's strongest failure
      // mode: an older record could otherwise survive a reported rotation.
      fs.rmSync(statePath, { force: true });
      fs.mkdirSync(statePath);
      try {
        await expect(
          rpc('daemon.web.start', {
            port,
            host: '127.0.0.1',
            allowInput: false,
            newToken: true,
          }),
        ).rejects.toThrow('new web state could not be durably persisted');
        expect((await rpc('daemon.web.status')).running).toBe(false);
        expect((await probe(port, '/api/config', oldToken)).error).toBeTruthy();
      } finally {
        fs.rmSync(statePath, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
