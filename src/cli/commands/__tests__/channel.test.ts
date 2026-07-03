/**
 * `wmux channel` — the universal agent surface for Channels v2.
 *
 * What these tests pin:
 *  1. Transport: every subcommand rides the DAEMON pipe (sendDaemonRequest),
 *     never the main pipe — that is what keeps the CLI working headless.
 *  2. Identity: senderPtyId rides along (walk hit here via the mocked
 *     resolveSelfContext; env-fallback is covered separately) and the CLI
 *     NEVER claims a workspace (no verifiedWorkspaceId, no sender.workspaceId
 *     — the daemon stamps/backfills those server-side).
 *  3. Envelope unwrap: a daemon-level `{ok:false, error:{code,message}}`
 *     RESULT (inside an ok pipe envelope) exits 1 with the code visible.
 *  4. Fail-closed UX: a mutation with no resolvable pane identity exits 1
 *     BEFORE any RPC is issued, with an actionable message.
 *  5. Name → id resolution: `read general` resolves via a2a.channel.list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendDaemonRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleChannel } from '../channel';

const daemonRpc = sendDaemonRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_ENV_PTY = process.env.WMUX_PTY_ID;
const ORIGINAL_ENV_MEMBER = process.env.WMUX_MEMBER_ID;

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WMUX_PTY_ID;
  delete process.env.WMUX_MEMBER_ID;
  if (ORIGINAL_ENV_PTY !== undefined) process.env.WMUX_PTY_ID = undefined as unknown as string;
  if (ORIGINAL_ENV_MEMBER !== undefined) process.env.WMUX_MEMBER_ID = undefined as unknown as string;
  delete process.env.WMUX_PTY_ID;
  delete process.env.WMUX_MEMBER_ID;
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self' });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const okEnvelope = (result: unknown) => ({ id: 'x', ok: true as const, result });

describe('wmux channel — transport + identity', () => {
  it('unread rides the daemon pipe with senderPtyId and NO workspace claim', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, entries: [] }));
    await handleChannel('unread', [], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.unread', {
      senderPtyId: 'pty-self',
    });
    const params = daemonRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('verifiedWorkspaceId');
  });

  it('falls back to env WMUX_PTY_ID when the verified walk misses (headless)', async () => {
    selfContext.mockResolvedValue({});
    process.env.WMUX_PTY_ID = 'pty-env';
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, entries: [] }));
    await handleChannel('unread', [], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.unread', {
      senderPtyId: 'pty-env',
    });
  });

  it('unread honors $WMUX_MEMBER_ID like post/ack (GLM review — consistent member filtering)', async () => {
    process.env.WMUX_MEMBER_ID = 'codex';
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, entries: [] }));
    await handleChannel('unread', [], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.unread', {
      memberId: 'codex',
      senderPtyId: 'pty-self',
    });
  });

  it('post sends sender WITHOUT workspaceId (daemon backfills from its own stamp)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, message: { seq: 3 } }));
    await handleChannel('post', ['ch-1', 'hello', 'world', '--member', 'codex'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.post', {
      channelId: 'ch-1',
      text: 'hello world',
      sender: { memberId: 'codex', memberName: 'codex' },
      senderPtyId: 'pty-self',
    });
  });

  it('post keeps body tokens that start with a dash (flag stripper is pair-aware)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, message: { seq: 4 } }));
    await handleChannel('post', ['ch-1', 'step', '-1', 'failed', '--member', 'codex'], false);
    const postCall = daemonRpc.mock.calls.find((c: unknown[]) => c[0] === 'a2a.channel.post');
    expect((postCall?.[1] as { text: string }).text).toBe('step -1 failed');
  });

  it('ack forwards uptoSeq + memberId; "all" maps to MAX_SAFE_INTEGER (daemon clamps to head)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, acked: 0, lastReadSeq: 9 }));
    await handleChannel('ack', ['ch-1', 'all', '--member', 'codex'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.ack', {
      channelId: 'ch-1',
      uptoSeq: Number.MAX_SAFE_INTEGER,
      memberId: 'codex',
      senderPtyId: 'pty-self',
    });
  });

  it('ack without --member resolves the caller\'s SINGLE row from unread (no "agent" guess)', async () => {
    const row = { channelId: 'ch-1', name: 'g', memberId: 'codex', lastReadSeq: 2, headSeq: 9, unread: 7, mentionUnread: 0, trimmedBeforeCursor: 0 };
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] })) // ref resolution (id passthrough)
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [row] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, acked: 1, lastReadSeq: 9 }));
    await handleChannel('ack', ['ch-1', 'all'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(2, 'a2a.channel.unread', { senderPtyId: 'pty-self' });
    expect(daemonRpc).toHaveBeenNthCalledWith(3, 'a2a.channel.ack', {
      channelId: 'ch-1',
      uptoSeq: Number.MAX_SAFE_INTEGER,
      memberId: 'codex',
      senderPtyId: 'pty-self',
    });
  });

  it('ack rejects a fractional/oversized uptoSeq before any RPC (GLM review — no silent no-op)', async () => {
    // 1.5 would pass the daemon's isSafeInteger guard as a clamp-to-0 no-op,
    // then echo the row's real cursor and print a false success. Reject in CLI.
    await expect(handleChannel('ack', ['ch-1', '1.5'], false)).rejects.toThrow(ExitCalled);
    await expect(handleChannel('ack', ['ch-1', '99999999999999999'], false)).rejects.toThrow(ExitCalled);
    expect(daemonRpc).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('whole number');
  });

  it('ack without --member on a MULTI-row workspace fails loudly (never guesses a cursor)', async () => {
    const mk = (memberId: string) => ({ channelId: 'ch-1', name: 'g', memberId, lastReadSeq: 0, headSeq: 3, unread: 3, mentionUnread: 0, trimmedBeforeCursor: 0 });
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [mk('codex'), mk('opencode')] }));
    await expect(handleChannel('ack', ['ch-1', 'all'], false)).rejects.toThrow(ExitCalled);
    // Ref resolution + the unread lookup ran — the ack RPC never fired.
    expect(daemonRpc).toHaveBeenCalledTimes(2);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('--member');
  });

  it('post without --member posts AS the resolved row (self-unread exemption depends on it)', async () => {
    const row = { channelId: 'ch-1', name: 'g', memberId: 'codex', lastReadSeq: 2, headSeq: 2, unread: 0, mentionUnread: 0, trimmedBeforeCursor: 0 };
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [row] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, message: { seq: 3 } }));
    await handleChannel('post', ['ch-1', 'hi'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(3, 'a2a.channel.post', {
      channelId: 'ch-1',
      text: 'hi',
      sender: { memberId: 'codex', memberName: 'codex' },
      senderPtyId: 'pty-self',
    });
  });

  it('read prints NO ack hint for a non-member (rows=0) — an ack there is a no-op (GLM review)', async () => {
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] })) // ref resolution
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [] }))   // quietOwnMemberRows → no rows
      .mockResolvedValueOnce(okEnvelope({ ok: true, messages: [{ seq: 5, memberName: 'pm', text: 'hi' }] }));
    await handleChannel('read', ['ch-1'], false);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('[seq 5] pm: hi');
    expect(out).not.toContain('wmux channel ack'); // no misleading hint for a non-member
  });

  it('a channel NAME starting with "ch-" still resolves via the listing (exact ids win)', async () => {
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [{ id: 'ch-abc123', name: 'ch-release', visibility: 'public' }] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, messages: [] }));
    await handleChannel('read', ['ch-release'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(3, 'a2a.channel.getMessages', {
      channelId: 'ch-abc123',
      limit: 50,
      senderPtyId: 'pty-self',
    });
  });

  it('read resolves a channel NAME to its id via a2a.channel.list', async () => {
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [{ id: 'ch-9', name: 'general', visibility: 'public' }] }))
      // Quiet own-row lookup (read's cursor default + ack hint).
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, messages: [{ seq: 1, memberName: 'pm', text: 'hi' }] }));
    await handleChannel('read', ['general'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(1, 'a2a.channel.list', { senderPtyId: 'pty-self' });
    expect(daemonRpc).toHaveBeenNthCalledWith(3, 'a2a.channel.getMessages', {
      channelId: 'ch-9',
      limit: 50,
      senderPtyId: 'pty-self',
    });
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('[seq 1] pm: hi');
  });

  it('--since / --limit flag values are never mistaken for positionals', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, messages: [] }));
    await handleChannel('read', ['--since', '3', 'ch-1', '--limit', '5'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.getMessages', {
      channelId: 'ch-1',
      sinceSeq: 3,
      limit: 5,
      senderPtyId: 'pty-self',
    });
  });

  it('read without --since starts from the caller\'s OWN cursor (single row) and pages oldest-first', async () => {
    const row = { channelId: 'ch-1', name: 'g', memberId: 'codex', lastReadSeq: 4, headSeq: 9, unread: 5, mentionUnread: 0, trimmedBeforeCursor: 0 };
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [row] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, messages: [{ seq: 5, memberName: 'pm', text: 'a' }, { seq: 6, memberName: 'pm', text: 'b' }] }));
    await handleChannel('read', ['ch-1', '--limit', '2'], false);
    // sinceSeq = lastReadSeq + 1: the printed ack hint can never jump the
    // cursor over unseen messages (pages are contiguous from the cursor).
    expect(daemonRpc).toHaveBeenNthCalledWith(3, 'a2a.channel.getMessages', {
      channelId: 'ch-1',
      sinceSeq: 5,
      limit: 2,
      senderPtyId: 'pty-self',
    });
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // Full page → the continue hint points at the NEXT page.
    expect(out).toContain('--since 7');
    expect(out).toContain('wmux channel ack ch-1 6');
  });

  it('multi-row + --since maps the ack hint back to the ONE matching row (--member included)', async () => {
    const mk = (memberId: string, lastReadSeq: number) => ({ channelId: 'ch-1', name: 'g', memberId, lastReadSeq, headSeq: 9, unread: 9 - lastReadSeq, mentionUnread: 0, trimmedBeforeCursor: 0 });
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [mk('codex', 4), mk('opencode', 7)] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, messages: [{ seq: 5, memberName: 'pm', text: 'a' }] }));
    // --since 5 came from codex's unread hint (cursor 4 + 1) — the ack hint
    // must carry --member codex, or following it hits the never-guess error
    // and the wake worker re-nudges forever (Codex round-3).
    await handleChannel('read', ['ch-1', '--since', '5'], false);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('wmux channel ack ch-1 5 --member codex');
  });

  it('a bare -- ends option parsing: post bodies keep flag-like tokens (--limit 5)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, message: { seq: 8 } }));
    await handleChannel('post', ['ch-1', '--member', 'codex', '--', 'try', 'again', 'with', '--limit', '5'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.post', {
      channelId: 'ch-1',
      text: 'try again with --limit 5',
      sender: { memberId: 'codex', memberName: 'codex' },
      senderPtyId: 'pty-self',
    });
  });
});

describe('wmux channel — failure surfaces', () => {
  it('a mutation with no resolvable pane identity fails closed BEFORE any RPC', async () => {
    selfContext.mockResolvedValue({});
    await expect(handleChannel('post', ['ch-1', 'hi'], false)).rejects.toThrow(ExitCalled);
    expect(daemonRpc).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('not inside a wmux pane');
  });

  it('a daemon-level channel error (result.ok=false) exits 1 with the error code visible', async () => {
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [] })) // ref resolution succeeds
      .mockResolvedValue(okEnvelope({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a channel member' } }));
    // Explicit --member skips row resolution, so the post RPC itself errors.
    await expect(handleChannel('post', ['ch-1', 'hi', '--member', 'codex'], false)).rejects.toThrow(ExitCalled);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('NOT_A_MEMBER');
  });

  it('a reads-path call still works with NO pane identity (visibility falls to the daemon gate)', async () => {
    selfContext.mockResolvedValue({});
    daemonRpc.mockResolvedValue(
      okEnvelope({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } }),
    );
    // No senderPtyId at all → the daemon's own guard produces the rejection;
    // the CLI must surface it, not crash.
    await expect(handleChannel('list', [], false)).rejects.toThrow(ExitCalled);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.list', {});
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('NOT_AUTHORIZED');
  });

  it('unread surfaces trimmedBeforeCursor as a WARNING (silent loss is forbidden)', async () => {
    daemonRpc.mockResolvedValue(
      okEnvelope({
        ok: true,
        entries: [
          {
            channelId: 'ch-1',
            name: 'general',
            memberId: 'codex',
            lastReadSeq: 2,
            headSeq: 9,
            unread: 3,
            mentionUnread: 1,
            trimmedBeforeCursor: 4,
          },
        ],
      }),
    );
    await handleChannel('unread', [], false);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('3 unread');
    expect(out).toContain('1 mention you');
    expect(out).toContain('WARNING: 4 message(s) trimmed');
  });
});
