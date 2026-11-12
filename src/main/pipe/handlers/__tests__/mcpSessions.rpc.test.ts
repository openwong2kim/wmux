import { describe, expect, it } from 'vitest';
import { registerMcpSessionsRpc } from '../mcpSessions.rpc';
import { RpcRouter } from '../../RpcRouter';
import { McpSessionTracker } from '../../../mcp/mcpSessionTracker';
import { WMUX_CLI_METHODS } from '../../../mcp/internalCli';
import { METHOD_CAPABILITY } from '../../../mcp/methodCapabilityMap';
import type { BrokerStatus } from '../../../../shared/mcpSessions';

const broker: BrokerStatus = {
  running: true, pid: 4321, uptimeS: 65, connections: 2, crashExits: 1, spawnFailures: 0, standDowns: 0, standingDown: false, downReason: null,
};

describe('mcp.sessions.summary', () => {
  it('returns the broker counts and the recent bundle sessions, nothing else', async () => {
    const tracker = new McpSessionTracker({ now: () => 0 });
    tracker.touch('a'.repeat(32));
    const router = new RpcRouter();
    registerMcpSessionsRpc(router, { brokerEnabled: () => true, brokerStatus: () => broker, tracker });
    const res = await router.dispatch({ id: '1', method: 'mcp.sessions.summary', params: { includePaths: true } });
    expect(res).toEqual({
      id: '1',
      ok: true,
      result: { broker: { enabled: true, ...broker }, bundle: { recent: 1, capped: false, ttlS: 600 } },
    });
    // No session ids, paths or tokens ride the answer.
    expect(JSON.stringify(res)).not.toContain('a'.repeat(32));
  });

  it('carries how main takes pid claims, as counts', async () => {
    const identity = {
      peerRead: { state: 'ok' as const }, startTimes: 'ok' as const,
      refusals: { 'no-peer': 0, 'other-pid': 2, 'start-unread': 0, restarted: 0, 'broker-unverified': 0, 'unowned-broker': 0 },
    };
    const router = new RpcRouter();
    registerMcpSessionsRpc(router, { brokerEnabled: () => false, brokerStatus: () => broker, tracker: new McpSessionTracker({ now: () => 0 }), identity: () => identity });
    const res = await router.dispatch({ id: '1', method: 'mcp.sessions.summary', params: {} });
    expect((res as { result: { identity?: unknown } }).result.identity).toEqual(identity);
  });

  it('is an internal method the CLI tier reaches', () => {
    expect(METHOD_CAPABILITY['mcp.sessions.summary']).toEqual({ capability: 'wmux.internal' });
    expect(WMUX_CLI_METHODS.has('mcp.sessions.summary')).toBe(true);
  });
});
