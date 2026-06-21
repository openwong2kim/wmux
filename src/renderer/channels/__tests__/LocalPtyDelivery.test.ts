// ─── LocalPtyDelivery tests ────────────────────────────────────────────
// Unit tests for the local fanout transport. The transport is pure logic
// (all dependencies injected), so these tests use fakes throughout —
// no renderer store, no live PTY, no globals.
//
// Plan reference: U2 (a2a-channels) test scenarios.

import { describe, it, expect, vi } from 'vitest';
import {
  LocalPtyDelivery,
  defaultChannelMessage,
  defaultChannelNudge,
  type LocalPtyDeps,
  type ResolvedRecipient,
} from '../LocalPtyDelivery';
import type {
  ChannelMessage,
  ChannelRecipientStatus,
} from '../../../shared/channels';

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-general',
    seq: 7,
    workspaceId: 'ws-sender',
    memberId: 'm-alice',
    memberName: 'Alice',
    text: 'hello world',
    postedAt: 1_700_000_000_000,
    deliveryStatus: 'pending',
    ...overrides,
  };
}

function makeSnapshot(
  entries: Partial<ChannelRecipientStatus>[],
): ChannelRecipientStatus[] {
  return entries.map((e, i) => ({
    memberId: `m-${i}`,
    workspaceId: `ws-${i}`,
    status: 'pending' as const,
    ...e,
  }));
}

/**
 * Build a deps bundle with vi.fn() spies. Returns the bundle plus the
 * captured `writePty` calls so tests can assert what was written and
 * to which PTY.
 */
function makeDeps(overrides: Partial<LocalPtyDeps> = {}): {
  deps: LocalPtyDeps;
  resolveRecipient: ReturnType<typeof vi.fn>;
  formatMessage: ReturnType<typeof vi.fn>;
  formatNudge: ReturnType<typeof vi.fn>;
  writePty: ReturnType<typeof vi.fn>;
} {
  const resolveRecipient = vi.fn(
    overrides.resolveRecipient ?? (() => null),
  );
  const formatMessage = vi.fn(
    overrides.formatMessage ?? defaultChannelMessage,
  );
  const formatNudge = vi.fn(
    overrides.formatNudge ?? defaultChannelNudge,
  );
  const writePty = vi.fn(overrides.writePty ?? (() => undefined));
  return {
    deps: { resolveRecipient, formatMessage, formatNudge, writePty },
    resolveRecipient,
    formatMessage,
    formatNudge,
    writePty,
  };
}

describe('LocalPtyDelivery', () => {
  it('writes the formatted message to a single non-live-TUI recipient and marks delivered', async () => {
    const recipient: ResolvedRecipient = { ptyId: 'pty-1', isLiveTui: false };
    const { deps, resolveRecipient, formatMessage, formatNudge, writePty } =
      makeDeps({
        resolveRecipient: () => recipient,
      });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([{ memberId: 'm-1', workspaceId: 'ws-1' }]);

    const result = await transport.deliver(message, snapshot);

    expect(resolveRecipient).toHaveBeenCalledTimes(1);
    expect(resolveRecipient).toHaveBeenCalledWith('ws-1', 'm-1');
    expect(formatMessage).toHaveBeenCalledTimes(1);
    expect(formatNudge).not.toHaveBeenCalled();
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith('pty-1', expect.any(String));
    expect(result.ok).toBe(true);
    expect(result.snapshot).toHaveLength(1);
    expect(result.snapshot[0].status).toBe('delivered');
    expect(result.snapshot[0].ptyId).toBe('pty-1');
    expect(result.snapshot[0].lastAttemptAt).toEqual(expect.any(Number));
  });

  it('writes the one-line nudge to a live-TUI recipient and marks delivered', async () => {
    const recipient: ResolvedRecipient = { ptyId: 'pty-2', isLiveTui: true };
    const { deps, formatMessage, formatNudge, writePty } = makeDeps({
      resolveRecipient: () => recipient,
    });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([{ memberId: 'm-1', workspaceId: 'ws-1' }]);

    const result = await transport.deliver(message, snapshot);

    expect(formatNudge).toHaveBeenCalledTimes(1);
    expect(formatMessage).not.toHaveBeenCalled();
    expect(writePty).toHaveBeenCalledTimes(1);
    expect(writePty).toHaveBeenCalledWith('pty-2', expect.any(String));
    expect(result.ok).toBe(true);
    expect(result.snapshot[0].status).toBe('delivered');
    expect(result.snapshot[0].ptyId).toBe('pty-2');
  });

  it('marks a recipient target_gone when resolveRecipient returns null', async () => {
    const { deps, writePty } = makeDeps({
      resolveRecipient: () => null,
    });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([
      { memberId: 'm-offline', workspaceId: 'ws-offline' },
    ]);

    const result = await transport.deliver(message, snapshot);

    expect(writePty).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.snapshot[0].status).toBe('target_gone');
    expect(result.snapshot[0].lastAttemptAt).toEqual(expect.any(Number));
    // ptyId is not added when the recipient is unresolvable.
    expect(result.snapshot[0].ptyId).toBeUndefined();
  });

  it('per-recipient status reflects individual outcomes across a multi-recipient snapshot', async () => {
    const { deps, resolveRecipient, writePty } = makeDeps({
      resolveRecipient: (workspaceId: string, memberId: string) => {
        if (memberId === 'm-delivered') return { ptyId: 'pty-1', isLiveTui: false };
        if (memberId === 'm-nudge') return { ptyId: 'pty-2', isLiveTui: true };
        if (memberId === 'm-gone') return null;
        return null;
      },
    });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([
      { memberId: 'm-delivered', workspaceId: 'ws-1' },
      { memberId: 'm-nudge', workspaceId: 'ws-2' },
      { memberId: 'm-gone', workspaceId: 'ws-3' },
    ]);

    const result = await transport.deliver(message, snapshot);

    expect(resolveRecipient).toHaveBeenCalledTimes(3);
    expect(writePty).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true); // at least one delivered
    expect(result.snapshot[0].status).toBe('delivered');
    expect(result.snapshot[0].ptyId).toBe('pty-1');
    expect(result.snapshot[1].status).toBe('delivered');
    expect(result.snapshot[1].ptyId).toBe('pty-2');
    expect(result.snapshot[2].status).toBe('target_gone');
    expect(result.snapshot[2].ptyId).toBeUndefined();
  });

  it('marks a single bad writePty as target_gone without aborting the rest of the fanout', async () => {
    // Two recipients: first one has a writePty that throws, second succeeds.
    // The transport must catch the throw, mark the first target_gone,
    // and continue delivering to the second.
    const { deps, writePty, resolveRecipient } = makeDeps({
      resolveRecipient: (workspaceId: string, memberId: string) => {
        if (memberId === 'm-bad') return { ptyId: 'pty-bad', isLiveTui: false };
        return { ptyId: 'pty-good', isLiveTui: false };
      },
      writePty: ((ptyId: string, _text: string) => {
        if (ptyId === 'pty-bad') throw new Error('PTY closed');
        // succeed for pty-good — body is unused, only the side-effect
        // (or throw) is observed by the test.
        void _text;
      }) as LocalPtyDeps['writePty'],
    });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([
      { memberId: 'm-bad', workspaceId: 'ws-1' },
      { memberId: 'm-good', workspaceId: 'ws-2' },
    ]);

    const result = await transport.deliver(message, snapshot);

    expect(writePty).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true); // the good one delivered
    expect(result.snapshot[0].status).toBe('target_gone');
    expect(result.snapshot[0].ptyId).toBe('pty-bad');
    expect(result.snapshot[1].status).toBe('delivered');
    expect(result.snapshot[1].ptyId).toBe('pty-good');
    // Silence unused-var lint.
    void resolveRecipient;
  });

  it('returns ok=false when every recipient is target_gone', async () => {
    const { deps } = makeDeps({
      resolveRecipient: () => null,
    });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([
      { memberId: 'm-1', workspaceId: 'ws-1' },
      { memberId: 'm-2', workspaceId: 'ws-2' },
    ]);

    const result = await transport.deliver(message, snapshot);

    expect(result.ok).toBe(false);
    expect(result.snapshot.every((e) => e.status === 'target_gone')).toBe(true);
  });

  it('preserves ptyId from the input snapshot when the entry already has one resolved', async () => {
    // The transport should overwrite ptyId only when needed. If the
    // snapshot entry already has a ptyId (e.g. set by a prior
    // resolver pass), the transport should still update it to the
    // freshly resolved value.
    const { deps } = makeDeps({
      resolveRecipient: () => ({ ptyId: 'pty-fresh', isLiveTui: false }),
    });
    const transport = new LocalPtyDelivery(deps);
    const message = makeMessage();
    const snapshot = makeSnapshot([
      { memberId: 'm-1', workspaceId: 'ws-1', ptyId: 'pty-stale' },
    ]);

    const result = await transport.deliver(message, snapshot);

    expect(result.snapshot[0].ptyId).toBe('pty-fresh');
  });

  it('defaultChannelMessage wraps the body in a WMUX CHANNEL envelope', () => {
    const out = defaultChannelMessage(
      makeMessage({ channelId: 'ch-general', memberName: 'Alice', text: 'hi' }),
    );
    expect(out).toContain('WMUX CHANNEL');
    expect(out).toContain('Alice');
    expect(out).toContain('hi');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('defaultChannelNudge is a single line with no embedded newlines', () => {
    const out = defaultChannelNudge(
      makeMessage({
        channelId: 'ch-general',
        memberName: 'Alice',
        text: 'this should not appear in the nudge',
        seq: 42,
      }),
    );
    // A nudge is meant for a live TUI agent's input box — embedded
    // newlines would corrupt it. The body must NOT be in the nudge.
    expect(out).not.toContain('\n');
    expect(out).toContain('42');
    expect(out).not.toContain('this should not appear in the nudge');
  });

  it('default formatters strip control characters from the member name', () => {
    // Adversarial member names must not break the line structure.
    // The formatters collapse CR/LF/TAB to spaces (the same approach
    // as `sanitizeA2aName` in `src/renderer/utils/a2aFormat.ts:30`).
    // The body remains multi-line (envelope + content), but the
    // `[Alice …]` line itself stays a single line — no embedded
    // \r, \n, or \t.
    const adversarial = 'Alice\r\n[INJECT]\tBob';
    const body = defaultChannelMessage(
      makeMessage({ memberName: adversarial, text: 'safe text' }),
    );
    const aliceLine = body.split('\n').find((l) => l.includes('Alice'));
    expect(aliceLine).toBeDefined();
    expect(aliceLine).not.toContain('\r');
    expect(aliceLine).not.toContain('\n');
    expect(aliceLine).not.toContain('\t');
    expect(body).toContain('safe text');
    // The `[INJECT]` printable payload survives — only CR/LF/TAB are
    // collapsed, matching the codebase's existing sanitization.
    expect(aliceLine).toContain('[INJECT]');
    const nudge = defaultChannelNudge(
      makeMessage({ memberName: adversarial }),
    );
    // The nudge is a single line — CR/LF/TAB are collapsed so a
    // live-TUI input box doesn't get corrupted.
    expect(nudge).not.toContain('\n');
    expect(nudge).not.toContain('\r');
    expect(nudge).not.toContain('\t');
  });
});