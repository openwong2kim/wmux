/**
 * The native Claude hook refuses a payload deeper than PAYLOAD_DEPTH_MAX
 * (core/wmux-native/src/claude_hook.rs) so that it never sends a request the
 * servers cannot parse: main's and the daemon's JSON.parse with a reviver
 * recurses, and fails long before the bridge's own stringify. A payload at
 * exactly the limit, wrapped as the hook sends it, must parse in both
 * processLine paths (PipeServer, DaemonPipeServer); a lower server limit or
 * a heavier reviver fails here instead of leaving a Stop stuck.
 */
import { readFileSync } from 'node:fs';
import type * as net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RpcRouter } from '../../../src/main/pipe/RpcRouter';

vi.mock('../../../src/shared/constants', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPipeName: () => 'wmux-test-pipe',
  getAuthTokenPath: () => '\0wmux-test-token',
  getTcpPortPath: () => 'wmux-test-port',
}));
vi.mock('../../../src/shared/security', () => ({
  secureWriteTokenFile: vi.fn(),
  scheduleTokenFileReHarden: vi.fn(),
}));

import { PipeServer } from '../../../src/main/pipe/PipeServer';
import { DaemonPipeServer } from '../../../src/daemon/DaemonPipeServer';

const SOURCE = readFileSync(path.resolve(process.cwd(), 'core/wmux-native/src/claude_hook.rs'), 'utf8');
const DEPTH_MAX = Number(/const PAYLOAD_DEPTH_MAX: usize = ([\d_]+);/.exec(SOURCE)?.[1].replace(/_/g, ''));

/** The request line the hook sends, its payload `depth` levels below its own outermost value. */
function line(method: string, depth: number): string {
  const payload = '['.repeat(depth + 1) + ']'.repeat(depth + 1);
  return `{"id":"bridge-depth","method":"${method}","params":{"kind":"agent.stop","agent":"claude","cwd":"/w",`
    + `"payload":${payload},"ts":1},"token":"not-the-token","clientName":"wmux-hook-bridge"}`;
}

type LineServer = { processLine(socket: net.Socket, line: string): void };

/** What processLine wrote back for the line (it answers synchronously when it cannot parse). */
function answer(server: object, text: string): string {
  const write = vi.fn();
  const socket = { destroyed: false, write, destroy: vi.fn(), once: vi.fn(), on: vi.fn() } as unknown as net.Socket;
  (server as LineServer).processLine(socket, text);
  return write.mock.calls.map((call) => String(call[0])).join('');
}

describe('PAYLOAD_DEPTH_MAX against the servers that parse it', () => {
  it('is read from the native hook', () => {
    expect(DEPTH_MAX).toBeGreaterThan(0);
  });

  const servers: [string, string, () => object][] = [
    ['main (PipeServer)', 'hooks.signal', () => new PipeServer({ dispatch: vi.fn() } as unknown as RpcRouter)],
    ['the daemon (DaemonPipeServer)', 'daemon.hooks.signal', () => new DaemonPipeServer('wmux-depth-test')],
  ];
  for (const [name, method, make] of servers) {
    it(`${name} parses a payload at the limit`, () => {
      expect(answer(make(), line(method, DEPTH_MAX))).not.toContain('Invalid JSON');
    });

    it(`${name} refuses one far past it (the probe sees a parse failure)`, () => {
      expect(answer(make(), line(method, 100_000))).toContain('Invalid JSON');
    });
  }
});
