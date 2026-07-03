// Channels v2 Step 0 — daemon-side caller stamping unit tests.
// Rules under test (channelCallerIdentity.ts):
//   1. pre-stamped verifiedWorkspaceId → trusted verbatim, params untouched
//   2. senderPtyId resolvable → server-side stamp + caller-field backfill
//   3a. neither present → pass through (per-handler guard rejects)
//   3b. senderPtyId present but unresolvable → fail-closed NOT_AUTHORIZED
import { describe, it, expect } from 'vitest';
import { stampChannelCaller, type ResolveSessionWorkspace } from '../channelCallerIdentity';

const resolver =
  (map: Record<string, string>): ResolveSessionWorkspace =>
  (id) =>
    map[id] ?? '';

describe('stampChannelCaller', () => {
  it('rule 1: trusts a pre-stamped verifiedWorkspaceId verbatim and does not re-resolve', () => {
    const r = stampChannelCaller(
      resolver({ 'pty-1': 'ws-other' }),
      { verifiedWorkspaceId: 'ws-main-stamped', senderPtyId: 'pty-1' },
      { kind: 'none' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params['verifiedWorkspaceId']).toBe('ws-main-stamped');
    }
  });

  it('rule 2: stamps verifiedWorkspaceId from the daemon session binding', () => {
    const r = stampChannelCaller(resolver({ 'pty-1': 'ws-a' }), { senderPtyId: 'pty-1' }, { kind: 'none' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params['verifiedWorkspaceId']).toBe('ws-a');
  });

  it('rule 2: backfills an omitted ref-style caller field (post sender)', () => {
    const r = stampChannelCaller(
      resolver({ 'pty-1': 'ws-a' }),
      { senderPtyId: 'pty-1', sender: { memberId: 'codex', memberName: 'codex' } },
      { kind: 'ref', key: 'sender' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params['sender']).toEqual({ memberId: 'codex', memberName: 'codex', workspaceId: 'ws-a' });
      expect(r.params['verifiedWorkspaceId']).toBe('ws-a');
    }
  });

  it('rule 2: leaves an EXPLICIT ref workspaceId alone (sender-pin gate still verifies it)', () => {
    const r = stampChannelCaller(
      resolver({ 'pty-1': 'ws-a' }),
      { senderPtyId: 'pty-1', sender: { workspaceId: 'ws-forged', memberId: 'x' } },
      { kind: 'ref', key: 'sender' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // verified is the daemon's answer; the mismatching explicit sender is
      // left for ChannelService's sender-pin gate to reject.
      expect(r.params['verifiedWorkspaceId']).toBe('ws-a');
      expect((r.params['sender'] as Record<string, unknown>)['workspaceId']).toBe('ws-forged');
    }
  });

  it('rule 2: backfills a flat caller field (leave workspaceId)', () => {
    const r = stampChannelCaller(
      resolver({ 'pty-1': 'ws-a' }),
      { senderPtyId: 'pty-1', memberId: 'codex' },
      { kind: 'flat', key: 'workspaceId' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params['workspaceId']).toBe('ws-a');
  });

  it('rule 3a: passes through when neither identity input is present', () => {
    const r = stampChannelCaller(resolver({}), { channelId: 'ch-1' }, { kind: 'none' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params['verifiedWorkspaceId']).toBeUndefined();
  });

  it('rule 3b: fails closed when senderPtyId cannot be resolved', () => {
    const r = stampChannelCaller(resolver({}), { senderPtyId: 'pty-ghost' }, { kind: 'none' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NOT_AUTHORIZED');
      expect(r.error.message).toContain('pty-ghost');
    }
  });

  it('does not mutate the input params object', () => {
    const raw = { senderPtyId: 'pty-1', sender: { memberId: 'codex' } };
    const snapshot = JSON.parse(JSON.stringify(raw));
    stampChannelCaller(resolver({ 'pty-1': 'ws-a' }), raw, { kind: 'ref', key: 'sender' });
    expect(raw).toEqual(snapshot);
  });

  it('treats a whitespace-only senderPtyId as absent (rule 3a)', () => {
    const r = stampChannelCaller(resolver({ '  ': 'ws-weird' }), { senderPtyId: '   ' }, { kind: 'none' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params['verifiedWorkspaceId']).toBeUndefined();
  });
});
