// The broker's half of the stamp: it takes the stamp from main's exact message,
// and puts it only on `a2a.resolve.identity` from a session it verified, naming
// no pid but that session's, sent over the pipe.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { RpcMethod } from '../../shared/rpc';
import { brokerStampForTarget, sendRpc } from '../wmux-client';
import { createConnectionScope, runInConnectionScope } from '../connectionScope';
import { acceptBrokerStamp, brokerStampFor, resetBrokerStampForTest } from '../brokerStamp';

const STAMP = 'e'.repeat(64);
const verified = (pid: number) => ({ ...createConnectionScope(), verifiedCallerPid: pid });

afterEach(() => resetBrokerStampForTest());

describe('brokerStampFor', () => {
  it('takes the stamp only from the exact message main sends', () => {
    const scope = verified(42);
    const read = () => runInConnectionScope(scope, () => brokerStampFor('a2a.resolve.identity', { callerPid: 42 }));
    for (const bad of [
      null, 'x', [], { wmuxBroker: 'stamp' }, { wmuxBroker: 'stamp', stamp: 'E'.repeat(64) },
      { wmuxBroker: 'stamp', stamp: 'e'.repeat(63) }, { wmuxBroker: 'connections', stamp: STAMP },
      { wmuxBroker: 'stamp', stamp: STAMP, extra: 1 },
    ]) {
      acceptBrokerStamp(bad);
      expect(read(), JSON.stringify(bad)).toBeUndefined();
    }
    acceptBrokerStamp({ wmuxBroker: 'stamp', stamp: STAMP });
    expect(read()).toBe(STAMP);
  });

  it('stamps only an identity call from a verified session that claims that session\'s pid', () => {
    acceptBrokerStamp({ wmuxBroker: 'stamp', stamp: STAMP });
    const scope = verified(42);
    const inScope = (method: string, params: Record<string, unknown>) =>
      runInConnectionScope(scope, () => brokerStampFor(method, params));
    expect(inScope('a2a.resolve.identity', { callerPid: 42 })).toBe(STAMP);
    expect(inScope('a2a.resolve.identity', { codexThreadId: 't', codexCallerPid: 42 })).toBe(STAMP);
    // A call that claims no pid carries none.
    expect(inScope('a2a.resolve.identity', {})).toBeUndefined();
    expect(inScope('a2a.resolve.identity', { hintedPtyId: 'p' })).toBeUndefined();
    // Another method, another pid, or a pid of another type.
    expect(inScope('pane.list', { callerPid: 42 })).toBeUndefined();
    expect(inScope('a2a.resolve.identity', { callerPid: 43 })).toBeUndefined();
    expect(inScope('a2a.resolve.identity', { callerPid: 42, codexCallerPid: 43 })).toBeUndefined();
    expect(inScope('a2a.resolve.identity', { callerPid: '42' })).toBeUndefined();
    // A session the broker did not verify, and no session at all.
    expect(runInConnectionScope(createConnectionScope(), () => brokerStampFor('a2a.resolve.identity', { callerPid: 42 }))).toBeUndefined();
    expect(brokerStampFor('a2a.resolve.identity', { callerPid: 42 })).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('the stamp on the envelope', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};
  let server: net.Server | undefined;
  const envelopes: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-brokerstamp-'));
    for (const key of ['HOME', 'WMUX_SOCKET_PATH', 'WMUX_DATA_SUFFIX']) saved[key] = process.env[key];
    process.env.HOME = tmpHome;
    delete process.env.WMUX_SOCKET_PATH;
    delete process.env.WMUX_DATA_SUFFIX;
    fs.writeFileSync(path.join(tmpHome, '.wmux-auth-token'), 'test-token', 'utf8');
    server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const envelope = JSON.parse(line) as Record<string, unknown>;
          envelopes.push(envelope);
          socket.write(JSON.stringify({ id: envelope.id, ok: true, result: {} }) + '\n');
        }
      });
      socket.on('error', () => undefined);
    });
    const activeServer = server;
    await new Promise<void>((resolve) => activeServer.listen(path.join(tmpHome, '.wmux.sock'), () => resolve()));
  });

  afterEach(() => {
    envelopes.length = 0;
  });

  afterAll(async () => {
    const activeServer = server;
    if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('goes on a verified session\'s identity call, and on nothing else', async () => {
    acceptBrokerStamp({ wmuxBroker: 'stamp', stamp: STAMP });
    await runInConnectionScope(verified(42), async () => {
      await sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: 42 });
      await sendRpc('pane.list' as RpcMethod, {});
      await sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: 7 });
    });
    await sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: 42 });
    expect(envelopes.map((e) => e.brokerStamp)).toEqual([STAMP, undefined, undefined, undefined]);
  });

  it('goes only to this instance\'s own socket: never to an inherited WMUX_SOCKET_PATH, never over TCP', async () => {
    acceptBrokerStamp({ wmuxBroker: 'stamp', stamp: STAMP });
    const own = path.join(tmpHome, '.wmux.sock');
    const scoped = (target: string | { host: string; port: number }) =>
      runInConnectionScope(verified(42), () => brokerStampForTarget(target, 'a2a.resolve.identity', { callerPid: 42 }));
    expect(scoped(own)).toBe(STAMP);
    expect(scoped(path.join(tmpHome, '.wmux-other.sock'))).toBeUndefined();
    expect(scoped({ host: '127.0.0.1', port: 1 })).toBeUndefined();
    // Another instance's socket in WMUX_SOCKET_PATH is tried first; what it
    // receives carries no stamp.
    const other: Array<Record<string, unknown>> = [];
    const otherSock = path.join(tmpHome, '.wmux-other.sock');
    const otherServer = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n').filter((l) => l.trim())) {
          const envelope = JSON.parse(line) as Record<string, unknown>;
          other.push(envelope);
          socket.write(JSON.stringify({ id: envelope.id, ok: true, result: {} }) + '\n');
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => otherServer.listen(otherSock, () => resolve()));
    process.env.WMUX_SOCKET_PATH = otherSock;
    try {
      await runInConnectionScope(verified(42), () => sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: 42 }));
    } finally {
      delete process.env.WMUX_SOCKET_PATH;
      await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    }
    expect(other).toHaveLength(1);
    expect('brokerStamp' in other[0]).toBe(false);
  });

  it('is never sent before main has sent one', async () => {
    await runInConnectionScope(verified(42), () => sendRpc('a2a.resolve.identity' as RpcMethod, { callerPid: 42 }));
    expect(envelopes).toHaveLength(1);
    expect('brokerStamp' in envelopes[0]).toBe(false);
  });
});
