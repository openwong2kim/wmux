import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  checkPeer,
  decideWin32Peer,
  decideWin32Session,
  isTransientSelfCheckFailure,
  MEDIUM_INTEGRITY_RID,
  PreAuthGate,
  retryingSelfCheck,
  selfCheckNativePipe,
  TOKEN_FACTS_TIMEOUT_MS,
  WIN32_HOST_BUDGET_MS,
  win32SelfCheckPipeName,
  type PeerCheckInput,
  type SelfCheckListen,
  type SelfCheckSocket,
  type Win32PeerInput,
  type Win32SessionInput,
} from '../brokerPeer';
import type { TokenFactsResult } from '../nativePipeSocket';

type Win32TokenFacts = TokenFactsResult;

// The broker's Windows decision over the native pipe listener's facts, with
// the facts injected: what the listener read for the client process, and what
// the client's own token said. The real listener is covered by the os tests
// that need the built core (brokerAck.os.test.ts, nativePipe.os.test.ts).

const HIGH_RID = 0x3000;
const LOW_RID = 0x1000;

const hosted: Win32PeerInput = {
  selfCheckOk: true,
  peer: { pid: 4242, sameSession: true, ppid: 4000, reason: null },
  facts: { ok: true, sameUser: true, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false },
  claimedPid: 4242,
};

describe('decideWin32Peer', () => {
  it('hosts a Medium client of this user in this session, with the parent the listener read', () => {
    expect(decideWin32Peer(hosted)).toEqual({ ok: true, callerPid: 4242, callerPpid: 4000 });
  });

  it('hosts an elevated client of this user (High integrity, token read by impersonation)', () => {
    // The process token of an elevated client cannot be opened from a Medium
    // broker: the listener says token-unreadable, and the client's own token
    // answers instead.
    const elevated: Win32PeerInput = {
      ...hosted,
      peer: { ...hosted.peer, reason: 'token-unreadable' },
      facts: { ok: true, sameUser: true, integrityRid: HIGH_RID, elevated: true },
    };
    expect(decideWin32Peer(elevated)).toEqual({ ok: true, callerPid: 4242, callerPpid: 4000 });
  });

  it('refuses every session until the self-check passed', () => {
    expect(decideWin32Peer({ ...hosted, selfCheckOk: false })).toMatchObject({ ok: false, reason: 'peer-unverified' });
  });

  it('refuses a Low integrity client (integrity-low)', () => {
    expect(decideWin32Peer({ ...hosted, facts: { ok: true, sameUser: true, integrityRid: LOW_RID, elevated: false } }))
      .toEqual({ ok: false, reason: 'integrity-low', detail: 'peer 4242 integrity 0x1000' });
    expect(decideWin32Peer({ ...hosted, facts: { ok: true, sameUser: true, integrityRid: 0, elevated: false } }))
      .toMatchObject({ ok: false, reason: 'integrity-low' });
  });

  it('refuses a client of another user (other-user)', () => {
    expect(decideWin32Peer({ ...hosted, facts: { ok: true, sameUser: false, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false } }))
      .toMatchObject({ ok: false, reason: 'other-user' });
  });

  it('refuses a client in another session (other-session)', () => {
    expect(decideWin32Peer({ ...hosted, peer: { ...hosted.peer, sameSession: false } }))
      .toMatchObject({ ok: false, reason: 'other-session' });
  });

  it('refuses when the token facts were not read, whatever the reason (token-unreadable)', () => {
    for (const reason of ['no-read-yet', 'impersonation-failed', 'token-unreadable', 'closed', 'timed-out', 'unsupported'] as const) {
      const facts: Win32TokenFacts = { ok: false, reason };
      expect(decideWin32Peer({ ...hosted, facts }), reason).toEqual({
        ok: false, reason: 'token-unreadable', detail: `token facts for peer 4242: ${reason}`,
      });
    }
  });

  it('refuses when the token facts were not read at all', () => {
    expect(decideWin32Peer({ ...hosted, facts: null })).toEqual({
      ok: false, reason: 'token-unreadable', detail: 'token facts for peer 4242: not read',
    });
  });

  it('refuses a handshake that names another pid, or none (pid-mismatch)', () => {
    for (const claimedPid of [4243, undefined, '4242', null]) {
      expect(decideWin32Peer({ ...hosted, claimedPid }), String(claimedPid)).toMatchObject({ ok: false, reason: 'pid-mismatch' });
    }
  });

  it('refuses a client whose process could not be read or whose pid names a newer process', () => {
    for (const reason of ['process-unreadable', 'created-after-accept']) {
      expect(decideWin32Peer({ ...hosted, peer: { ...hosted.peer, reason } }), reason)
        .toMatchObject({ ok: false, reason: 'process-unreadable' });
    }
  });

  it('refuses a client with no parent the listener could vouch for (no-parent)', () => {
    expect(decideWin32Peer({ ...hosted, peer: { ...hosted.peer, ppid: null } }))
      .toEqual({ ok: false, reason: 'no-parent', detail: 'no parent pid for peer 4242' });
  });

  it('checks the token before the session and the pid', () => {
    const everythingWrong: Win32PeerInput = {
      selfCheckOk: true,
      peer: { pid: 1, sameSession: false, ppid: null, reason: 'created-after-accept' },
      facts: { ok: true, sameUser: false, integrityRid: LOW_RID, elevated: false },
      claimedPid: 2,
    };
    expect(decideWin32Peer(everythingWrong)).toMatchObject({ reason: 'other-user' });
  });
});

/** A session input with a fake clock that the token read can move. */
function session(over: Partial<Win32SessionInput> & { clock?: { t: number } } = {}) {
  const clock = over.clock ?? { t: 10_000 };
  const tokenFacts = vi.fn(async (_timeoutMs: number): Promise<TokenFactsResult> => ({ ok: true, sameUser: true, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false }));
  const verdict = vi.fn(async () => 'available' as string | null);
  const input: Win32SessionInput = {
    acceptedAt: clock.t,
    selfCheck: { latest: () => 'available', verdict },
    tokenFacts,
    peer: hosted.peer,
    claimedPid: 4242,
    now: () => clock.t,
    ...over,
  };
  return { input, clock, tokenFacts, verdict };
}

describe('decideWin32Session', () => {
  it('hosts on the last verdict without waiting on a check, and gives the token read its full bound', async () => {
    const { input, tokenFacts, verdict } = session();
    expect(await decideWin32Session(input)).toEqual({ ok: true, callerPid: 4242, callerPpid: 4000 });
    expect(verdict).not.toHaveBeenCalled();
    expect(tokenFacts).toHaveBeenCalledWith(TOKEN_FACTS_TIMEOUT_MS);
  });

  it('a failed last verdict refuses at once, reads no token, and rechecks in the background', async () => {
    const pending = new Promise<string | null>(() => undefined);
    const verdict = vi.fn(() => pending);
    const { input, tokenFacts } = session({ selfCheck: { latest: () => 'unavailable (boom)', verdict } });
    expect(await decideWin32Session(input)).toMatchObject({ ok: false, reason: 'peer-unverified' });
    expect(verdict).toHaveBeenCalledTimes(1);
    expect(tokenFacts).not.toHaveBeenCalled();
  });

  it('before the first check finished it waits for it, within the budget', async () => {
    const { input } = session({ selfCheck: { latest: () => undefined, verdict: async () => 'available' } });
    expect(await decideWin32Session(input)).toMatchObject({ ok: true });
  });

  it('a first check that does not finish within the budget refuses (peer-unverified)', async () => {
    const { input } = session({
      selfCheck: { latest: () => undefined, verdict: () => new Promise<string | null>(() => undefined) },
      budgetMs: 30,
      now: Date.now,
      acceptedAt: Date.now(),
    });
    expect(await decideWin32Session(input)).toMatchObject({ ok: false, reason: 'peer-unverified' });
  });

  it('the token read gets only what is left of the budget', async () => {
    const clock = { t: 10_000 };
    const { input, tokenFacts } = session({ clock, acceptedAt: clock.t - (WIN32_HOST_BUDGET_MS - 400) });
    await decideWin32Session(input);
    expect(tokenFacts).toHaveBeenCalledWith(400);
  });

  it('a session decided after the budget ran out is refused (too-late), so the shim falls back before its deadline', async () => {
    const clock = { t: 10_000 };
    const { input } = session({ clock });
    input.tokenFacts = async () => {
      clock.t += WIN32_HOST_BUDGET_MS + 1;
      return { ok: true, sameUser: true, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false };
    };
    expect(await decideWin32Session(input)).toMatchObject({ ok: false, reason: 'too-late' });
  });

  it('the budget stays under the native shim\'s 5 s ack deadline with room for the ack itself', () => {
    expect(WIN32_HOST_BUDGET_MS).toBeLessThanOrEqual(3500);
    expect(TOKEN_FACTS_TIMEOUT_MS).toBeLessThan(WIN32_HOST_BUDGET_MS);
  });
});

describe('retryingSelfCheck.latest', () => {
  it('is undefined until the first check finishes, then its verdict, without starting a check', async () => {
    const run = vi.fn(async () => 'available' as string | null);
    const check = retryingSelfCheck(run, () => undefined);
    expect(check.latest()).toBeUndefined();
    await check.verdict();
    expect(check.latest()).toBe('available');
    expect(check.latest()).toBe('available');
    expect(run).toHaveBeenCalledTimes(1);
    check.stop();
  });
});

describe('the unix decision is unchanged', () => {
  // The reasons and details the unix branch logs, pinned: darwin and linux
  // host sessions by default, so this branch must not move.
  const ok: PeerCheckInput = { selfCheckOk: true, peer: { pid: 4242, uid: 501 }, claimedPid: 4242, ownUid: 501 };
  it('keeps every reason string', () => {
    expect([
      checkPeer(ok),
      checkPeer({ ...ok, selfCheckOk: false }),
      checkPeer({ ...ok, peer: { pid: null, reason: 'no fd' } }),
      checkPeer({ ...ok, peer: { pid: 4242 } }),
      checkPeer({ ...ok, ownUid: null }),
      checkPeer({ ...ok, peer: { pid: 4242, uid: 0 } }),
      checkPeer({ ...ok, claimedPid: 4243 }),
    ]).toEqual([
      { ok: true, callerPid: 4242 },
      { ok: false, reason: 'peer-unverified', detail: 'peer pids cannot be read in this process' },
      { ok: false, reason: 'peer-unverified', detail: 'no fd' },
      { ok: false, reason: 'peer-unverified', detail: 'no uid for peer 4242' },
      { ok: false, reason: 'peer-unverified', detail: 'no uid for peer 4242' },
      { ok: false, reason: 'peer', detail: 'peer 4242 runs as uid 0' },
      { ok: false, reason: 'peer', detail: 'claimed pid 4243, peer 4242' },
    ]);
  });
});

describe('PreAuthGate', () => {
  it('admits up to the cap, and a release frees one place once', () => {
    const gate = new PreAuthGate(2);
    const a = gate.admit();
    const b = gate.admit();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(gate.admit()).toBeNull();
    expect(gate.size).toBe(2);
    a!();
    a!();
    expect(gate.size).toBe(1);
    const c = gate.admit();
    expect(c).toBeTypeOf('function');
    expect(gate.admit()).toBeNull();
  });
});

describe('win32SelfCheckPipeName', () => {
  it('is the broker pipe name with this pid and a nonce after it', () => {
    expect(win32SelfCheckPipeName('\\\\.\\pipe\\wmux-mcpb-x-user', 77, 'abcd1234')).toBe('\\\\.\\pipe\\wmux-mcpb-x-user-pc-77-abcd1234');
    expect(win32SelfCheckPipeName('p')).toMatch(new RegExp(`^p-pc-${process.pid}-[0-9a-f]{8}$`));
  });
});

/** The client end the self-check connects with. */
class FakeClient extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(data: string): boolean { this.written.push(data); return true; }
  destroy(): this { this.destroyed = true; return this; }
}

/** The accepted end the self-check reads. */
class FakeAccepted extends EventEmitter implements SelfCheckSocket {
  destroyed = false;
  paused = false;
  constructor(readonly peer: { pid: number }, private readonly facts: () => Promise<Win32TokenFacts>) { super(); }
  pause(): this { this.paused = true; return this; }
  destroy(): this { this.destroyed = true; return this; }
  tokenFacts(): Promise<Win32TokenFacts> { return this.facts(); }
}

interface Rig {
  run: Promise<string>;
  closed: () => boolean;
  client: () => FakeClient;
  accepted: () => FakeAccepted | undefined;
}

/** The self-check against a fake listener that accepts the client's connection and reads its line. */
function rig(peerPid: number, facts: () => Promise<Win32TokenFacts>, opts: { listenThrows?: Error; noAccept?: boolean } = {}): Rig {
  let closed = false;
  let client: FakeClient | undefined;
  let accepted: FakeAccepted | undefined;
  let onConnection: ((socket: SelfCheckSocket) => void) | undefined;
  const listen: SelfCheckListen = (_name, options) => {
    if (opts.listenThrows) throw opts.listenThrows;
    expect(options.maxInstances).toBe(1);
    onConnection = options.onConnection;
    return { close: () => { closed = true; } };
  };
  const connect = (): net.Socket => {
    client = new FakeClient();
    client.write = (data: string) => {
      client!.written.push(data);
      if (opts.noAccept) return true;
      accepted = new FakeAccepted({ pid: peerPid }, facts);
      onConnection!(accepted);
      setImmediate(() => accepted!.emit('data', Buffer.from(data)));
      return true;
    };
    setImmediate(() => client!.emit('connect'));
    return client as unknown as net.Socket;
  };
  return {
    run: selfCheckNativePipe(listen, 'p', 200, connect),
    closed: () => closed,
    client: () => client!,
    accepted: () => accepted,
  };
}

describe('selfCheckNativePipe', () => {
  it('is available when the listener reads this pid and the token names this user', async () => {
    const r = rig(process.pid, async () => ({ ok: true, sameUser: true, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false }));
    expect(await r.run).toBe('available');
    expect(r.client().written).toEqual(['self-check\n']);
    expect(r.accepted()!.paused).toBe(true);
    expect(r.closed()).toBe(true);
    expect(r.client().destroyed).toBe(true);
    expect(r.accepted()!.destroyed).toBe(true);
  });

  it('is unavailable when the listener reads another pid', async () => {
    const r = rig(process.pid + 1, async () => ({ ok: true, sameUser: true, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false }));
    expect(await r.run).toBe(`unavailable (read pid ${process.pid + 1}, expected ${process.pid})`);
  });

  it('is unavailable when the token read fails or names another user', async () => {
    expect(await rig(process.pid, async () => ({ ok: false, reason: 'impersonation-failed' })).run)
      .toBe('unavailable (token facts: impersonation-failed)');
    expect(await rig(process.pid, async () => ({ ok: true, sameUser: false, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false })).run)
      .toBe('unavailable (the token read names another user)');
  });

  it('says "timed out" for a token read that ran out of time, and for a check that did (transient)', async () => {
    const slow = await rig(process.pid, async () => ({ ok: false, reason: 'timed-out' })).run;
    expect(slow).toBe('unavailable (token facts timed out)');
    expect(isTransientSelfCheckFailure(slow)).toBe(true);
    const r = rig(process.pid, async () => ({ ok: true, sameUser: true, integrityRid: MEDIUM_INTEGRITY_RID, elevated: false }), { noAccept: true });
    const verdict = await r.run;
    expect(verdict).toBe('unavailable (self-check timed out)');
    expect(isTransientSelfCheckFailure(verdict)).toBe(true);
    expect(r.closed()).toBe(true);
  });

  it('is unavailable, without connecting, when listening throws', async () => {
    const connect = vi.fn();
    const verdict = await selfCheckNativePipe(() => { throw new Error('boom'); }, 'p', 200, connect);
    expect(verdict).toBe('unavailable (boom)');
    expect(connect).not.toHaveBeenCalled();
  });

  it('is unavailable when the client cannot connect', async () => {
    const listen: SelfCheckListen = () => ({ close: () => undefined });
    const verdict = await selfCheckNativePipe(listen, 'p', 200, () => {
      const c = new FakeClient();
      setImmediate(() => c.emit('error', new Error('connect ENOENT p')));
      return c as unknown as net.Socket;
    });
    expect(verdict).toBe('unavailable (connect ENOENT p)');
  });
});
