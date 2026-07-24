// Dynamic broker-lifecycle harness — exercises the REAL broker process and the
// production connect-probe (brokerProbe.canConnectBrokerPipe) instead of mocks.
// The unit suites (BrokerSupervisor.test / brokerProbe.test / McpRegistrar.test)
// stub timers and the pipe; this file pins the contracts those stubs stand in
// for against a broker.js spawned under plain node:
//
//   1. whenReady's underlying signal — the supervisor polls
//      canConnectBrokerPipe(); this proves that signal flips true once a real
//      broker is listening and flips back false once it dies (T7 positive half).
//   2. exit-75 "already running" contract — the reclaim logic in
//      BrokerSupervisor is unit-tested with fake timers, but it hinges on a
//      SECOND broker on the same pipe exiting with code 75. That is a property
//      of broker.ts, verifiable only with two real processes.
//   3. probe hang guard — canConnectBrokerPipe must SETTLE (never hang) against
//      a socket that accepts-but-never-writes and against a nonexistent pipe.
//
// Isolation: every broker/server is keyed by a unique WMUX_DATA_SUFFIX so the
// pipe name (getMcpBrokerPipeName) can never collide with a live wmux on this
// machine. The broker's auth token is supplied via WMUX_AUTH_TOKEN so the
// harness never writes to the user's real ~/.wmux-auth-token file. Every child
// process and server is torn down in afterEach (try/finally at the call sites),
// so a failed assertion cannot strand a node process.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { canConnectBrokerPipe } from '../brokerProbe';
import { getMcpBrokerPipeName } from '../../../shared/constants';

// npm test runs from the package root, so the bundled broker sits here. This is
// the SAME artifact packaged builds ship (resources/mcp-bundle/broker.js) — it
// is self-contained, so it runs under plain node with no node_modules access.
const BROKER_JS = path.join(process.cwd(), 'dist', 'mcp-bundle', 'broker.js');

// broker.js is a build artifact (`npm run build:mcp`), not checked in. CI-clean
// runs `npm test` without building it, so this whole suite is a local/dogfood
// lane: it deliberately skips unless the bundle exists. The packaged-build matrix
// is the separate gate that guarantees the bundle is present
// (see plans/mcp-broker-enable-plan-2026-07-24.md).
const brokerBundleExists = fs.existsSync(BROKER_JS);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let suffixSeq = 0;
function uniqueSuffix(): string {
  return `-brokerdyn-${process.pid}-${Date.now()}-${suffixSeq++}`;
}

// Resolve the broker pipe name for a given suffix through the PRODUCTION helper
// (so a rename of the pipe scheme breaks this test too), without leaking the
// suffix into the ambient env that later probes read.
function pipeFor(suffix: string): string {
  const prev = process.env.WMUX_DATA_SUFFIX;
  process.env.WMUX_DATA_SUFFIX = suffix;
  try {
    return getMcpBrokerPipeName();
  } finally {
    if (prev === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = prev;
  }
}

const children: ChildProcess[] = [];
const servers: net.Server[] = [];

function spawnBroker(suffix: string): ChildProcess {
  const child = spawn(process.execPath, [BROKER_JS], {
    env: {
      ...process.env,
      WMUX_DATA_SUFFIX: suffix,
      // Bypass the on-disk token file — the broker's readAuthToken() falls back
      // to this env var, so the harness never touches the real user token.
      WMUX_AUTH_TOKEN: 'dyn-test-token',
      // Not required under plain node, but harmless and matches how the
      // supervisor spawns it (Electron binary in RUN_AS_NODE mode).
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

/** Poll `fn` until it returns `expected` or the deadline passes. */
async function waitUntil(
  fn: () => Promise<boolean>,
  expected: boolean,
  timeoutMs: number,
  intervalMs = 150,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await fn()) === expected) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** Resolve a child's exit code, or `null` if it hasn't exited by the deadline. */
function exitCode(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function killAndWait(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
  const gone = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!gone) child.kill('SIGKILL');
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    } catch {
      /* best-effort */
    }
  }
  for (const server of servers.splice(0)) {
    try {
      server.close();
    } catch {
      /* best-effort */
    }
  }
});

describe.skipIf(!brokerBundleExists)('broker lifecycle (dynamic, real process)', () => {
  it(
    'real broker makes the pipe connectable, then unconnectable after it dies',
    async () => {
      const suffix = uniqueSuffix();
      const pipe = pipeFor(suffix);

      // Before boot the pipe does not exist.
      expect(await canConnectBrokerPipe(300, pipe)).toBe(false);

      const broker = spawnBroker(suffix);

      // The signal whenReady() polls flips true once the broker is listening.
      const up = await waitUntil(() => canConnectBrokerPipe(300, pipe), true, 8000);
      expect(up).toBe(true);

      // ...and flips back false once the broker is gone (Windows named pipes
      // vanish with their owner; Unix sockets are unlinked on clean shutdown).
      // waitUntil returns true when the probe REACHED the expected value
      // (false), i.e. the pipe became unconnectable within the window.
      await killAndWait(broker);
      const becameUnconnectable = await waitUntil(
        () => canConnectBrokerPipe(300, pipe),
        false,
        5000,
      );
      expect(becameUnconnectable).toBe(true);
    },
    20000,
  );

  it(
    'a second broker on the same pipe exits with code 75 (already-running contract)',
    async () => {
      const suffix = uniqueSuffix();
      const pipe = pipeFor(suffix);

      // The first broker is tracked in `children` and torn down in afterEach;
      // we only need it listening, not its handle.
      spawnBroker(suffix);
      expect(
        await waitUntil(() => canConnectBrokerPipe(300, pipe), true, 8000),
      ).toBe(true);

      // The supervisor treats exit 75 as "another live broker owns the pipe"
      // and stands down (arming the reclaim probe). That branch is dead unless
      // broker.ts actually exits 75 on EADDRINUSE against a live listener.
      const second = spawnBroker(suffix);
      const code = await exitCode(second, 8000);
      expect(code).toBe(75);

      // The original broker is unaffected — still serving.
      expect(await canConnectBrokerPipe(300, pipe)).toBe(true);
    },
    20000,
  );

  it(
    'canConnectBrokerPipe settles (never hangs) on accept-never-write and on a missing pipe',
    async () => {
      // (a) A server that ACCEPTS the connection but never writes a byte.
      // canConnectBrokerPipe resolves on 'connect' — it must NOT wait for data,
      // so it returns true well inside its timeout envelope.
      const suffix = uniqueSuffix();
      const pipe = pipeFor(suffix);
      const server = net.createServer(() => {
        /* accept, hold the socket, never write */
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipe, resolve);
      });

      const t0 = Date.now();
      const okAccept = await canConnectBrokerPipe(2000, pipe);
      const acceptElapsed = Date.now() - t0;
      expect(okAccept).toBe(true);
      expect(acceptElapsed).toBeLessThan(2000);

      // (b) A pipe nobody is listening on settles quickly to false — the
      // connect is refused/ENOENT immediately, no timeout wait.
      const missing = pipeFor(uniqueSuffix());
      const t1 = Date.now();
      const okMissing = await canConnectBrokerPipe(2000, missing);
      const missingElapsed = Date.now() - t1;
      expect(okMissing).toBe(false);
      expect(missingElapsed).toBeLessThan(2000);
    },
    15000,
  );
});
