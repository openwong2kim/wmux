import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pickPs, psPath } from '../../shared/psPath';
import { checkPeer, decidePeer, osParentPid, PARENT_READ_TIMEOUT_MS, retryingSelfCheck, type PeerCheckInput } from '../brokerPeer';

const ok: PeerCheckInput = { selfCheckOk: true, peer: { pid: 4242, uid: 501 }, claimedPid: 4242, ownUid: 501 };

describe('checkPeer', () => {
  it('takes a peer the OS names, running as this user, that claims its own pid', () => {
    expect(checkPeer(ok)).toEqual({ ok: true, callerPid: 4242 });
  });

  it('refuses every session when this process cannot read peer pids', () => {
    expect(checkPeer({ ...ok, selfCheckOk: false })).toMatchObject({ ok: false, reason: 'peer-unverified' });
  });

  it('refuses a socket the OS has no pid for', () => {
    expect(checkPeer({ ...ok, peer: { pid: null, reason: 'unsupported platform win32' } }))
      .toEqual({ ok: false, reason: 'peer-unverified', detail: 'unsupported platform win32' });
  });

  it('refuses a peer whose uid cannot be read, or where this process has none', () => {
    expect(checkPeer({ ...ok, peer: { pid: 4242 } })).toMatchObject({ ok: false, reason: 'peer-unverified' });
    expect(checkPeer({ ...ok, ownUid: null })).toMatchObject({ ok: false, reason: 'peer-unverified' });
  });

  it('refuses a peer running as another user', () => {
    expect(checkPeer({ ...ok, peer: { pid: 4242, uid: 0 } })).toMatchObject({ ok: false, reason: 'peer' });
  });

  it('refuses a handshake that names another pid, or none', () => {
    for (const claimedPid of [4243, undefined, '4242', null]) {
      expect(checkPeer({ ...ok, claimedPid }), String(claimedPid)).toMatchObject({ ok: false, reason: 'peer' });
    }
  });
});

describe('decidePeer', () => {
  it('takes the parent pid from the OS, whatever the handshake said', async () => {
    const parentOf = vi.fn(async () => 77);
    expect(await decidePeer(ok, parentOf)).toEqual({ ok: true, callerPid: 4242, callerPpid: 77 });
    expect(parentOf).toHaveBeenCalledWith(4242);
  });

  it('refuses when the parent cannot be read', async () => {
    expect(await decidePeer(ok, async () => null)).toMatchObject({ ok: false, reason: 'peer-unverified' });
  });

  it('reads no parent for a refused peer', async () => {
    const parentOf = vi.fn(async () => 77);
    expect(await decidePeer({ ...ok, claimedPid: 1 }, parentOf)).toMatchObject({ ok: false, reason: 'peer' });
    expect(parentOf).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('psPath', () => {
  it('names an absolute ps that exists here', () => {
    const ps = psPath();
    expect(path.isAbsolute(ps)).toBe(true);
    expect(fs.existsSync(ps)).toBe(true);
    expect(process.platform === 'darwin' ? ['/bin/ps'] : ['/bin/ps', '/usr/bin/ps']).toContain(ps);
  });

  it('takes the first path that exists, and PATH where neither does', () => {
    expect(pickPs('linux', (p) => p === '/usr/bin/ps')).toBe('/usr/bin/ps');
    expect(pickPs('linux', () => true)).toBe('/bin/ps');
    expect(pickPs('darwin', (p) => p === '/usr/bin/ps')).toBe('ps');
    expect(pickPs('linux', () => false)).toBe('ps');
  });
});

describe.runIf(process.platform !== 'win32')('osParentPid', () => {
  it('reads this process\'s parent', async () => {
    expect(await osParentPid(process.pid)).toBe(process.ppid);
  });

  it('has no answer for a pid that does not exist', async () => {
    expect(await osParentPid(2 ** 22 + 12345)).toBeNull();
  });
});

describe('the time the broker takes to decide', () => {
  it('stays under the native shim\'s ack deadline, self-check and parent read together', () => {
    const repo = path.resolve(__dirname, '..', '..', '..');
    const shim = fs.readFileSync(path.join(repo, 'core', 'wmux-native', 'src', 'mcp_shim.rs'), 'utf8');
    const peerPid = fs.readFileSync(path.join(repo, 'src', 'shared', 'peerPid.ts'), 'utf8');
    const deadlineMs = Number(/const ACK_DEADLINE: Duration = Duration::from_secs\((\d+)\);/.exec(shim)?.[1]) * 1000;
    const selfCheckMs = Number(/export function selfCheckPeerPid\(timeoutMs = (\d+)[,)]/.exec(peerPid)?.[1]);
    expect(deadlineMs).toBeGreaterThan(0);
    expect(selfCheckMs).toBeGreaterThan(0);
    expect(selfCheckMs + PARENT_READ_TIMEOUT_MS).toBeLessThan(deadlineMs);
  });
});

describe('retryingSelfCheck', () => {
  it('checks again with backoff until a transient failure recovers, then stops', async () => {
    vi.useFakeTimers();
    try {
      const verdicts = ['unavailable (EMFILE)', 'unavailable (listen EINVAL)', 'available'];
      const run = vi.fn(async () => verdicts.shift() ?? 'never');
      const seen: [string | null, number][] = [];
      const check = retryingSelfCheck(run, (v, n) => seen.push([v, n]), [1000, 2000]);
      expect(await check.verdict()).toBe('unavailable (EMFILE)');
      await vi.advanceTimersByTimeAsync(999);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await check.verdict()).toBe('unavailable (listen EINVAL)');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await check.verdict()).toBe('available');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(3);
      expect(seen).toEqual([['unavailable (EMFILE)', 1], ['unavailable (listen EINVAL)', 2], ['available', 3]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a platform with no peer pids as final', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => null);
      const check = retryingSelfCheck(run, () => undefined, [10]);
      expect(await check.verdict()).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a check that throws into a verdict and keeps checking', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn<() => Promise<string | null>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue('available');
      const check = retryingSelfCheck(run, () => undefined, [10]);
      expect(await check.verdict()).toBe('unavailable (boom)');
      await vi.advanceTimersByTimeAsync(10);
      expect(await check.verdict()).toBe('available');
    } finally {
      vi.useRealTimers();
    }
  });
});
