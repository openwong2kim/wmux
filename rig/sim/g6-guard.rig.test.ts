// Verification rig — G6 guard regression test (review follow-up: lock bypass prevention in tests)
//
// Verifies **without a daemon** that PipeClient identity hygiene (G6) is enforced at harness
// level via throw — hygiene runs before socket connect, so a nonexistent pipe path suffices.
// Only the negative case "legitimate cross-ws targets are not blocked" proceeds to connect;
// it is then rejected with a connect error (not G6) — ENOENT-like on the fake path.
//
// Contracts pinned (pipe.ts header "caution" block):
//   (1) verifiedWorkspaceId may only be stamped by channelRpc() — smuggling via rpc() or nested
//       locations throws regardless of position.
//   (2) Reserved identity values (ws-human/local-ui) throw globally if carried on identity keys.
//   (3) sender.workspaceId throws if it mismatches bound.
//   (4) Not a blanket ban — legitimate cross-ws refs (invite target, A2A to) pass.

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { PipeClient } from '../harness/pipe';

// Nonexistent pipe/token path — only hygiene-pass cases reach here, then fail immediately on connect.
const FAKE_PIPE = path.join(os.tmpdir(), `wmux-rig-g6-nonexistent-${process.pid}.sock`);
const FAKE_TOKEN = path.join(os.tmpdir(), `wmux-rig-g6-nonexistent-${process.pid}-token`);

describe('G6 guard — PipeClient identity hygiene (no daemon)', () => {
  const clients: PipeClient[] = [];
  const mk = (ws: string): PipeClient => {
    const c = new PipeClient(FAKE_PIPE, FAKE_TOKEN, ws, { timeoutMs: 2000 });
    clients.push(c);
    return c;
  };
  afterEach(() => {
    while (clients.length) clients.pop()!.close();
  });

  it('constructor: rejects reserved identity binding (ws-human / local-ui / empty)', () => {
    expect(() => new PipeClient(FAKE_PIPE, FAKE_TOKEN, 'ws-human')).toThrow(/G6/);
    expect(() => new PipeClient(FAKE_PIPE, FAKE_TOKEN, 'local-ui')).toThrow(/G6/);
    expect(() => new PipeClient(FAKE_PIPE, FAKE_TOKEN, '')).toThrow(/workspaceId/);
  });

  it('rpc(): smuggled verifiedWorkspaceId throws regardless of position', async () => {
    const c = mk('ws-honest');
    // Top level.
    await expect(
      c.rpc('a2a.channel.post', { verifiedWorkspaceId: 'ws-victim', text: 'x' }),
    ).rejects.toThrow(/G6/);
    // Nested object.
    await expect(
      c.rpc('some.method', { nested: { verifiedWorkspaceId: 'ws-victim' } }),
    ).rejects.toThrow(/G6/);
    // Deep nesting inside array.
    await expect(
      c.rpc('some.method', { arr: [{ deep: { verifiedWorkspaceId: 'v' } }] }),
    ).rejects.toThrow(/G6/);
  });

  it('rpc(): throws when reserved identity value appears on identity-class keys', async () => {
    const c = mk('ws-honest');
    await expect(c.rpc('some.method', { workspaceId: 'ws-human' })).rejects.toThrow(/G6/);
    await expect(c.rpc('some.method', { member: { memberId: 'local-ui' } })).rejects.toThrow(/G6/);
    await expect(c.rpc('some.method', { targetWorkspaceId: 'ws-human' })).rejects.toThrow(/G6/);
  });

  it('channelRpc(): impersonating other ws·nested smuggling, sender mismatch, reserved sender all throw', async () => {
    const c = mk('ws-honest');
    // Top-level impersonation of another ws.
    await expect(
      c.channelRpc('a2a.channel.post', { verifiedWorkspaceId: 'ws-victim' }),
    ).rejects.toThrow(/G6/);
    // Nested smuggling (top level is stamped by channelRpc, but nested presence is smuggling).
    await expect(
      c.channelRpc('a2a.channel.post', { nested: { verifiedWorkspaceId: 'ws-victim' } }),
    ).rejects.toThrow(/G6/);
    // Caller identity field sender.workspaceId mismatch.
    await expect(
      c.channelRpc('a2a.channel.post', { sender: { workspaceId: 'ws-other', memberId: 'm' } }),
    ).rejects.toThrow(/G6/);
    // Reserved identity as sender.
    await expect(
      c.channelRpc('a2a.channel.post', { sender: { workspaceId: 'ws-human', memberId: 'm' } }),
    ).rejects.toThrow(/G6/);
  });

  it('legitimate cross-ws targets (invite target, A2A to) are not blocked by G6 (not blanket ban)', async () => {
    const c = mk('ws-honest');
    // Invite target legitimately references another ws — must pass hygiene and reach connect,
    // then fail on connect (fake pipe); that error must not be a G6 violation.
    const errInvite = await c
      .channelRpc('a2a.channel.invite', {
        channelId: 'ch-x',
        invitedMember: { workspaceId: 'ws-teammate', memberId: 'mate' },
      })
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(errInvite, 'invite must fail (fake pipe)').toBeTruthy();
    expect(String(errInvite)).not.toMatch(/G6/);

    // A2A to (recipient ws) also passes — 'to' is not an identity key.
    const errTo = await c.rpc('a2a.task.send', { to: 'ws-other', message: 'hi' }).then(
      () => null,
      (e: Error) => e,
    );
    expect(errTo, 'task.send must fail (fake pipe)').toBeTruthy();
    expect(String(errTo)).not.toMatch(/G6/);
  });

  it('channelRpc(): explicit verifiedWorkspaceId matching bound is allowed (equivalent to stamp)', async () => {
    const c = mk('ws-honest');
    const err = await c
      .channelRpc('a2a.channel.unread', { verifiedWorkspaceId: 'ws-honest' })
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err, '(fake pipe) connection error expected').toBeTruthy();
    expect(String(err)).not.toMatch(/G6/);
  });
});
