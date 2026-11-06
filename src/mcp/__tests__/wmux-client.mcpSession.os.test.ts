// The bundle's half of the live-session count for `wmux doctor`: a single-child
// server stamps one per-process id on every envelope. The broker process never
// does, hosted connection or not, since it reports its own connection count.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { RpcMethod } from '../../shared/rpc';
import { MCP_SESSION_ID_RE } from '../../shared/mcpSessions';
import { getMcpSessionId, sendRpc, setBrokerEnvelopeMode } from '../wmux-client';
import { createConnectionScope, runInConnectionScope } from '../connectionScope';

describe.skipIf(process.platform === 'win32')('mcpSession on the envelope', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};
  let server: net.Server | undefined;
  const envelopes: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcpsession-'));
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

  // One mechanism: only broker mode clears the id. A connection scope does
  // not, since only the broker creates scopes and it is in broker mode first.
  it('stamps one id per process on a single-child server, scope or not', async () => {
    const id = getMcpSessionId();
    expect(id).toMatch(MCP_SESSION_ID_RE);
    await sendRpc('a2a.discover' as RpcMethod, {});
    await runInConnectionScope(createConnectionScope(), () => sendRpc('pane.list' as RpcMethod, {}));
    expect(envelopes.map((e) => e.mcpSession)).toEqual([id, id]);
  });

  it('stamps nothing once the process is the broker, in a connection or not', async () => {
    setBrokerEnvelopeMode();
    expect(getMcpSessionId()).toBeUndefined();
    await sendRpc('pane.list' as RpcMethod, {});
    await runInConnectionScope(createConnectionScope(), () => sendRpc('pane.list' as RpcMethod, {}));
    expect(envelopes.every((e) => !('mcpSession' in e))).toBe(true);
    expect(envelopes).toHaveLength(2);
  });
});
