import { describe, expect, it, vi } from 'vitest';
import { checkPeer, decidePeer, osParentPid, type PeerCheckInput } from '../brokerPeer';

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

describe.runIf(process.platform !== 'win32')('osParentPid', () => {
  it('reads this process\'s parent', async () => {
    expect(await osParentPid(process.pid)).toBe(process.ppid);
  });

  it('has no answer for a pid that does not exist', async () => {
    expect(await osParentPid(2 ** 22 + 12345)).toBeNull();
  });
});
