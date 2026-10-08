// Per-pane Chrome profiles: the caller's half of `RpcRequest.callerPtyId`.
//
// main picks a pane's browser profile from the PTY stamped on the envelope, so
// the value must (a) ride every envelope, (b) stay per connection under the
// broker — one hosted caller must never drive the browser as another pane's
// account — and (c) never come from tool arguments, which only reach `params`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { RpcMethod } from '../../shared/rpc';
import {
  clearClientIdentity,
  getCallerPtyId,
  runWithCallerPtyIdSource,
  sendRpc,
  setCallerPtyId,
  setClientIdentity,
} from '../wmux-client';
import { createConnectionScope, runInConnectionScope } from '../connectionScope';

beforeEach(() => {
  setCallerPtyId(undefined);
  clearClientIdentity();
});

describe('wmux-client callerPtyId', () => {
  it('round-trips, trims, and treats blank as absent', () => {
    setCallerPtyId('  pty-1  ');
    expect(getCallerPtyId()).toBe('pty-1');
    setCallerPtyId('   ');
    expect(getCallerPtyId()).toBeUndefined();
  });

  it('is dropped with the rest of the identity by clearClientIdentity', () => {
    setClientIdentity('claude-code', '1.0.0');
    setCallerPtyId('pty-1');
    clearClientIdentity();
    expect(getCallerPtyId()).toBeUndefined();
  });

  it('keeps each broker connection to its own pane', () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    runInConnectionScope(a, () => setCallerPtyId('pty-a'));
    runInConnectionScope(b, () => setCallerPtyId('pty-b'));

    expect(runInConnectionScope(a, () => getCallerPtyId())).toBe('pty-a');
    expect(runInConnectionScope(b, () => getCallerPtyId())).toBe('pty-b');
    // Neither leaks into the single-child globals, nor the globals into a scope.
    expect(getCallerPtyId()).toBeUndefined();
    setCallerPtyId('pty-global');
    expect(runInConnectionScope(createConnectionScope(), () => getCallerPtyId())).toBeUndefined();

    runInConnectionScope(a, () => clearClientIdentity());
    expect(runInConnectionScope(a, () => getCallerPtyId())).toBeUndefined();
    expect(runInConnectionScope(b, () => getCallerPtyId())).toBe('pty-b');
  });

  it('lets a per-call source override, suppress, or defer to the connection value', () => {
    setCallerPtyId('pty-starter');
    expect(runWithCallerPtyIdSource(() => 'pty-thread', () => getCallerPtyId())).toBe('pty-thread');
    // '' = this call has no pane: omit, never fall back to the starter's pane.
    expect(runWithCallerPtyIdSource(() => '', () => getCallerPtyId())).toBeUndefined();
    expect(runWithCallerPtyIdSource(() => undefined, () => getCallerPtyId())).toBe('pty-starter');
  });
});

// The wire: a local fake daemon captures the raw envelopes. POSIX only (Unix
// domain socket fixture), like wmux-client.transport.test.ts.
describe.skipIf(process.platform === 'win32')('callerPtyId on the envelope', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};
  let server: net.Server | undefined;
  const envelopes: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-callerpty-'));
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
      socket.on('error', () => { /* client destroys the socket after the response */ });
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

  it('stamps the connection pane on every envelope, per connection', async () => {
    const a = createConnectionScope();
    const b = createConnectionScope();
    runInConnectionScope(a, () => setCallerPtyId('pty-a'));
    runInConnectionScope(b, () => setCallerPtyId('pty-b'));
    setCallerPtyId('pty-stdio');

    await runInConnectionScope(a, () => sendRpc('browser.cdp.info' as RpcMethod, {}));
    await runInConnectionScope(b, () => sendRpc('browser.navigate' as RpcMethod, {}));
    await sendRpc('a2a.discover' as RpcMethod, {});

    expect(envelopes.map((e) => e.callerPtyId)).toEqual(['pty-a', 'pty-b', 'pty-stdio']);
  });

  it('never takes it from tool arguments, and omits it when unknown', async () => {
    // A forged argument stays inside params; main reads only the envelope field.
    await sendRpc('browser.navigate' as RpcMethod, { callerPtyId: 'pty-forged' });
    setCallerPtyId('pty-real');
    await sendRpc('browser.navigate' as RpcMethod, { callerPtyId: 'pty-forged' });

    expect('callerPtyId' in envelopes[0]).toBe(false);
    expect(envelopes[1].callerPtyId).toBe('pty-real');
    expect((envelopes[1].params as Record<string, unknown>).callerPtyId).toBe('pty-forged');
  });
});
