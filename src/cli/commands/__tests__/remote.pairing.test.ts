/**
 * `wmux remote join | peers | unpair` — the pairing verbs a daemon-only host
 * uses. They ride the daemon control pipe only (never the app's pipe, never a
 * pane-identity lookup), and never print the invite or its code back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
  isDefinitelyNotRunning: (err: unknown) => {
    const code = (err as { code?: string })?.code;
    return code === 'ENOENT' || code === 'ECONNREFUSED';
  },
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest, sendDaemonRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleRemote } from '../remote';

const daemonRpc = sendDaemonRequest as unknown as ReturnType<typeof vi.fn>;
const mainRpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const CODE = 'K7QX4M2P';
const FP = Array.from({ length: 32 }, () => 'AB').join(':');
const INVITE = `wmux-a2a://desk.local:7843/${CODE}#sha256=${FP}`;
const HOST_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

const host = {
  v: 1, hostId: HOST_ID, name: 'desk', addresses: ['desk.local'], port: 7843,
  fingerprint256: FP, peerId: 'peer-1', createdAt: '2026-11-12T00:00:00.000Z',
};

const okEnvelope = (result: unknown) => ({ id: 'x', ok: true as const, result });

/** Route daemon RPCs by method name. */
function routeDaemon(routes: Record<string, unknown>): void {
  daemonRpc.mockImplementation(async (method: string) => {
    if (!(method in routes)) throw new Error(`unexpected method ${method}`);
    return okEnvelope(routes[method]);
  });
}

function printed(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' ')).join('\n');
}

async function run(sub: string, args: string[], json = false): Promise<number | undefined> {
  try {
    await handleRemote(sub, args, json);
    return 0;
  } catch (err) {
    if (err instanceof ExitCalled) return err.code;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('wmux remote join', () => {
  it('sends the invite to a2a.remote.join on the daemon pipe only', async () => {
    routeDaemon({ 'a2a.remote.join': { ok: true, host } });
    expect(await run('join', [INVITE])).toBe(0);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.join', { invite: INVITE });
    expect(mainRpc).not.toHaveBeenCalled();
    expect(selfContext).not.toHaveBeenCalled();
    expect(printed()).toContain(HOST_ID);
    expect(printed()).toContain(FP);
    expect(printed()).not.toContain(CODE);
  });

  it('prints usage and exits 1 without an invite, before any RPC', async () => {
    expect(await run('join', [])).toBe(1);
    expect(daemonRpc).not.toHaveBeenCalled();
    expect(printed()).toContain('Usage: wmux remote join');
  });

  it('maps a join error code to a readable line, exit 1, invite and code redacted', async () => {
    routeDaemon({ 'a2a.remote.join': { ok: false, error: 'code-invalid', detail: `server said ${CODE} is wrong for ${INVITE}` } });
    expect(await run('join', [INVITE])).toBe(1);
    const out = printed();
    expect(out).toContain('does not match');
    expect(out).not.toContain(CODE);
    expect(out).not.toContain(INVITE);
  });

  it('says how long to wait when rate-limited', async () => {
    routeDaemon({ 'a2a.remote.join': { ok: false, error: 'rate-limited', retryAfterMs: 4_200 } });
    expect(await run('join', [INVITE])).toBe(1);
    expect(printed()).toContain('Try again in 5 s');
  });

  it('--json prints the result shape and exits 1 on failure, still redacted', async () => {
    routeDaemon({ 'a2a.remote.join': { ok: false, error: 'timeout', detail: `no answer from ${INVITE}` } });
    expect(await run('join', [INVITE], true)).toBe(1);
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, error: 'timeout' });
    expect(printed()).not.toContain(CODE);
  });

  it('--json on success prints {ok, host}', async () => {
    routeDaemon({ 'a2a.remote.join': { ok: true, host } });
    expect(await run('join', [INVITE], true)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ ok: true, host });
  });

  it('daemon not running: names the daemon and how to start it', async () => {
    daemonRpc.mockRejectedValue(Object.assign(new Error('wmux is not running. Start the app first.'), { code: 'ENOENT' }));
    expect(await run('join', [INVITE])).toBe(1);
    expect(printed()).toContain('wmux daemon is not running');
    expect(printed()).toContain('wmux daemon start');
    expect(printed()).not.toContain('Start the app');
  });

  it('a CLI timeout does not retry and points at `wmux remote peers`', async () => {
    daemonRpc.mockRejectedValue(new Error('Request timed out after 15 seconds.'));
    expect(await run('join', [INVITE])).toBe(1);
    expect(daemonRpc).toHaveBeenCalledTimes(1);
    expect(printed()).toContain('wmux remote peers');
  });

  it('an older daemon without the RPC gets a readable line', async () => {
    daemonRpc.mockResolvedValue({ id: 'x', ok: false, error: 'Unknown method: a2a.remote.join' });
    expect(await run('join', [INVITE])).toBe(1);
    expect(printed()).toContain('not available in this wmux daemon');
  });
});

describe('wmux remote peers', () => {
  const peer = { v: 1, peerId: 'peer-9', hostId: '11111111-2222-4333-8444-555555555555', name: 'laptop', createdAt: '2026-11-12T00:00:00.000Z' };

  it('--json prints {hosts, peers} from both lists', async () => {
    routeDaemon({ 'a2a.remote.hosts.list': { hosts: [host] }, 'a2a.remote.peers.list': { peers: [peer] } });
    expect(await run('peers', [], true)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ hosts: [host], peers: [peer] });
    expect(mainRpc).not.toHaveBeenCalled();
  });

  it('text lists host id, name and fingerprint', async () => {
    routeDaemon({ 'a2a.remote.hosts.list': { hosts: [host] }, 'a2a.remote.peers.list': { peers: [] } });
    expect(await run('peers', [])).toBe(0);
    const out = printed();
    expect(out).toContain(`${HOST_ID}  desk  ${FP}`);
    expect(out).toContain('none');
  });
});

describe('wmux remote unpair', () => {
  it('rejects a value that is not a host id, before any RPC', async () => {
    expect(await run('unpair', ['desk'])).toBe(1);
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('removes a joined host and reports whether that PC confirmed', async () => {
    routeDaemon({ 'a2a.remote.hosts.remove': { ok: true, remoteRevoked: true }, 'a2a.remote.peers.list': { peers: [] } });
    expect(await run('unpair', [HOST_ID], true)).toBe(0);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.hosts.remove', { hostId: HOST_ID });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      ok: true, hostId: HOST_ID, hostRemoved: true, remoteRevoked: true, peersRevoked: 0,
    });
  });

  it('also revokes that PC when it joined this one', async () => {
    routeDaemon({
      'a2a.remote.hosts.remove': { ok: false, remoteRevoked: false },
      'a2a.remote.peers.list': { peers: [{ v: 1, peerId: 'peer-2', hostId: HOST_ID, name: 'desk', createdAt: 'x' }] },
      'a2a.remote.peers.revoke': { ok: true },
    });
    expect(await run('unpair', [HOST_ID])).toBe(0);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.peers.revoke', { peerId: 'peer-2' });
  });

  it('accepts an uppercase host id', async () => {
    routeDaemon({ 'a2a.remote.hosts.remove': { ok: true, remoteRevoked: false }, 'a2a.remote.peers.list': { peers: [] } });
    expect(await run('unpair', [HOST_ID.toUpperCase()])).toBe(0);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.hosts.remove', { hostId: HOST_ID });
  });

  it('revokes that PC before the host removal, so a removal timeout cannot skip it', async () => {
    daemonRpc.mockImplementation(async (method: string) => {
      if (method === 'a2a.remote.peers.list') return okEnvelope({ peers: [{ v: 1, peerId: 'peer-3', hostId: HOST_ID, name: 'desk', createdAt: 'x' }] });
      if (method === 'a2a.remote.peers.revoke') return okEnvelope({ ok: true });
      throw new Error('Request timed out after 15 seconds.');
    });
    expect(await run('unpair', [HOST_ID])).toBe(1);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.peers.revoke', { peerId: 'peer-3' });
    expect(printed()).toContain('already revoked');
  });

  it('exits 1 when the host is not paired at all', async () => {
    routeDaemon({ 'a2a.remote.hosts.remove': { ok: false, remoteRevoked: false }, 'a2a.remote.peers.list': { peers: [] } });
    expect(await run('unpair', [HOST_ID])).toBe(1);
    expect(printed()).toContain('is not paired');
  });
});
