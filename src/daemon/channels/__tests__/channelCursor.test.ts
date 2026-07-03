// Channels v2 Step 1 — durable per-member read cursor (lastReadSeq) tests.
// Covers: seeding at create/join, upgrade backfill to head (NOT 0 — the
// re-nudge-storm guard), advance-only ack with optional member narrowing,
// persist-failure rollback, and the unreadFor() read model.
import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelState } from '../../../shared/channels';

function makeWriter(initial?: ChannelState) {
  let failNext = false;
  let last: ChannelState | null = initial ? structuredClone(initial) : null;
  return {
    load: (): ChannelState =>
      last
        ? structuredClone(last)
        : { version: 1, channels: [], members: {}, messages: {}, idempotency: {} },
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      if (failNext) {
        failNext = false;
        return false;
      }
      last = structuredClone(state);
      return true;
    }),
    save: vi.fn(),
    flush: vi.fn(),
    flushSync: vi.fn(),
    dispose: vi.fn(),
    failNext: () => {
      failNext = true;
    },
  };
}

function makeService(writer = makeWriter()) {
  const emit = vi.fn();
  const svc = new ChannelService({
    writer: writer as never,
    companyId: 'co-test',
    emit,
  });
  return { svc, writer, emit };
}

const A = 'ws-a';
const B = 'ws-b';

async function seedChannel(svc: ChannelService) {
  const created = await svc.create({
    name: 'cursor-test',
    visibility: 'public',
    createdBy: { workspaceId: A, memberId: 'pm', memberName: 'pm' },
    verifiedWorkspaceId: A,
  });
  if (!created.ok) throw new Error('create failed');
  const channelId = created.channel.id;
  const joined = await svc.join({
    channelId,
    member: { workspaceId: B, memberId: 'codex', memberName: 'codex' },
    verifiedWorkspaceId: B,
  });
  if (!joined.ok) throw new Error('join failed');
  return channelId;
}

async function post(svc: ChannelService, channelId: string, ws: string, memberId: string, text: string, mentions?: Array<{ workspaceId: string; memberId?: string; name: string }>) {
  const r = await svc.post({
    channelId,
    text,
    sender: { workspaceId: ws, memberId, memberName: memberId },
    verifiedWorkspaceId: ws,
    ...(mentions ? { mentions } : {}),
  });
  if (!r.ok) throw new Error(`post failed: ${JSON.stringify(r.error)}`);
  return r.message.seq;
}

describe('lastReadSeq cursor', () => {
  it('seeds the creator cursor at 0 and a joiner cursor at the join-time head', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'seed',
      visibility: 'public',
      createdBy: { workspaceId: A, memberId: 'pm', memberName: 'pm' },
      verifiedWorkspaceId: A,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const channelId = created.channel.id;
    await post(svc, channelId, A, 'pm', 'one');
    await post(svc, channelId, A, 'pm', 'two');
    await svc.join({
      channelId,
      member: { workspaceId: B, memberId: 'codex', memberName: 'codex' },
      verifiedWorkspaceId: B,
    });
    const entries = svc.unreadFor(B);
    expect(entries).toHaveLength(1);
    // Joined at head seq 2 → zero unread despite two prior messages.
    expect(entries[0].lastReadSeq).toBe(2);
    expect(entries[0].unread).toBe(0);
  });

  it('backfills a pre-v2 member row (no lastReadSeq) to the channel head on load', async () => {
    const { svc, writer } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    await post(svc, channelId, A, 'pm', 'm2');
    // Simulate a pre-v2 file: strip lastReadSeq from the persisted rows.
    const state = writer.load();
    for (const rows of Object.values(state.members)) {
      for (const row of rows) delete (row as unknown as Record<string, unknown>)['lastReadSeq'];
    }
    const writer2 = makeWriter(state);
    const svc2 = new ChannelService({ writer: writer2 as never, companyId: 'co-test', emit: vi.fn() });
    const entries = svc2.unreadFor(B);
    expect(entries).toHaveLength(1);
    // Head backfill ("start reading from now"), NOT 0 — no unread storm.
    expect(entries[0].lastReadSeq).toBe(2);
    expect(entries[0].unread).toBe(0);
  });

  it('ack advances the cursor, is clamped to head, and never moves backwards', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    await post(svc, channelId, A, 'pm', 'm2');
    expect(svc.unreadFor(B)[0].unread).toBe(2);

    // Overshoot: clamped to head (2), not persisted as 99.
    const r1 = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 99, memberId: 'codex' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.lastReadSeq).toBe(2);
    expect(svc.unreadFor(B)[0].unread).toBe(0);

    // Regression attempt: ack(1) after cursor=2 must not move backwards —
    // and the RESPONSE must echo the row's actual cursor (2), not the stale
    // request target (1): a client trusting the echo would otherwise believe
    // the cursor rewound and re-read from seq 2 (Codex round-3).
    const r2 = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.lastReadSeq).toBe(2);
    expect(svc.unreadFor(B)[0].lastReadSeq).toBe(2);
  });

  it('memberId narrows the cursor advance; omitting it is a READ RECEIPT — no cursor moves', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    // Second agent row for the same workspace B.
    await svc.join({
      channelId,
      member: { workspaceId: B, memberId: 'reviewer', memberName: 'reviewer' },
      verifiedWorkspaceId: B,
    });
    await post(svc, channelId, A, 'pm', 'm1');

    await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    const byMember = Object.fromEntries(svc.unreadFor(B).map((e) => [e.memberId, e]));
    expect(byMember['codex'].unread).toBe(0);
    expect(byMember['reviewer'].unread).toBe(1);

    // Workspace-wide ack = the renderer's open-channel receipt (a HUMAN
    // glanced at the channel). It must NOT consume the sibling agent's
    // inbox — before this rule a human read silently cleared agent cursors
    // and the wake worker went quiet on unprocessed work (Codex re-review P1).
    const receipt = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1 });
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.lastReadSeq).toBeUndefined();
    expect(svc.unreadFor(B).find((e) => e.memberId === 'reviewer')?.unread).toBe(1);
  });

  it('a narrowed ack naming a nonexistent member row fails loudly (NOT_A_MEMBER)', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    // Stale $WMUX_MEMBER_ID / typo: before the fix this returned ok with
    // nothing consumed — the CLI printed success while the wake worker kept
    // re-nudging the REAL row forever (Codex re-review).
    const r = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'agent' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_A_MEMBER');
    expect(svc.unreadFor(B)[0].unread).toBe(1);
  });

  it('a cursor advance emits a channel.catalog(reason=cursor); a receipt-only ack stays silent', async () => {
    const { svc, emit } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    emit.mockClear();

    // Receipt-only (renderer open) → no catalog chatter.
    await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1 });
    expect(emit.mock.calls.filter((c) => c[0]?.type === 'channel.catalog')).toHaveLength(0);

    // Member ack → the roster's "N behind" badges hydrate from the catalog,
    // so the advance must signal a re-sync (Codex re-review).
    await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    const catalogs = emit.mock.calls.filter((c) => c[0]?.type === 'channel.catalog');
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0][0]).toMatchObject({ channelId, reason: 'cursor' });

    // Repeat ack (no movement) → silent again.
    emit.mockClear();
    await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    expect(emit.mock.calls.filter((c) => c[0]?.type === 'channel.catalog')).toHaveLength(0);
  });

  it('rolls the cursor back when persist fails', async () => {
    const { svc, writer } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    writer.failNext();
    const r = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    // Cursor unchanged → the unread is still owed and a retry is not a no-op.
    expect(svc.unreadFor(B)[0].unread).toBe(1);
  });

  it('unreadFor counts mention-unread separately (workspace-level and member-targeted)', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'plain message');
    await post(svc, channelId, A, 'pm', 'hey @codex', [{ workspaceId: B, memberId: 'codex', name: 'codex' }]);
    await post(svc, channelId, A, 'pm', 'hey @ws-b', [{ workspaceId: B, name: 'B' }]);

    const entries = svc.unreadFor(B, 'codex');
    expect(entries).toHaveLength(1);
    expect(entries[0].unread).toBe(3);
    // member-targeted mention + workspace-level mention both count for codex.
    expect(entries[0].mentionUnread).toBe(2);
    expect(entries[0].trimmedBeforeCursor).toBe(0);
  });

  it('seeds an INVITED member cursor at the invite-time head (Codex review P1)', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'before-invite');
    const invited = await svc.invite({
      channelId,
      invitedMember: { workspaceId: 'ws-c', memberId: 'opencode', memberName: 'opencode' },
      verifiedWorkspaceId: A,
    });
    expect(invited.ok).toBe(true);
    // Nothing owed at invite time ("start reading from now", like join)…
    const atInvite = svc.unreadFor('ws-c')[0];
    expect(atInvite.lastReadSeq).toBe(1);
    expect(atInvite.unread).toBe(0);
    // …but a message posted AFTER the invite IS owed. Before the fix the
    // row had no cursor at all: unreadFor pinned it to the live head on
    // every query, so invited members never accumulated unread and the
    // wake worker never fired for them.
    await post(svc, channelId, A, 'pm', 'after-invite');
    expect(svc.unreadFor('ws-c')[0].unread).toBe(1);
  });

  it('a caught-up poster rides its cursor over its own message (never "behind" its reply)', async () => {
    const { svc, emit } = makeService();
    const channelId = await seedChannel(svc);
    emit.mockClear();
    const seq = await post(svc, channelId, B, 'codex', 'my reply');
    const mine = svc.unreadFor(B, 'codex')[0];
    expect(mine.lastReadSeq).toBe(seq);
    expect(mine.unread).toBe(0);
    // The OTHER side still owes it (self-exemption is row-scoped).
    expect(svc.unreadFor(A)[0].unread).toBe(1);
    // The ride advanced a PERSISTED cursor → same catalog signal as an ack,
    // or open rosters would show the poster "1 behind" its own message
    // (Codex round-4).
    const catalogs = emit.mock.calls.filter((c) => c[0]?.type === 'channel.catalog');
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0][0]).toMatchObject({ channelId, reason: 'cursor' });
  });

  it('a behind poster keeps its backlog but never owes its OWN post', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1'); // codex is now 1 behind
    await post(svc, channelId, B, 'codex', 'reply while behind');
    const mine = svc.unreadFor(B, 'codex')[0];
    // Cursor did NOT ride (the backlog is still owed)…
    expect(mine.lastReadSeq).toBe(0);
    // …and unread counts m1 only: the self-authored reply is exempt, so
    // the wake worker cannot nudge the pane about the message it just sent.
    expect(mine.unread).toBe(1);
  });

  it('unreadFor respects the historyFromSeq visibility floor', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'floor',
      visibility: 'public',
      createdBy: { workspaceId: A, memberId: 'pm', memberName: 'pm' },
      verifiedWorkspaceId: A,
    });
    if (!created.ok) return;
    const channelId = created.channel.id;
    await post(svc, channelId, A, 'pm', 'before-join');
    await svc.join({
      channelId,
      member: { workspaceId: B, memberId: 'codex', memberName: 'codex' },
      verifiedWorkspaceId: B,
      includeHistory: false,
    });
    // Force the cursor BELOW the visibility floor to prove the floor wins.
    // (Not reachable through the public API — simulates a hand-edited file.)
    const rows = (svc as unknown as { state: ChannelState }).state.members[channelId];
    const codexRow = rows.find((m) => m.memberId === 'codex');
    if (codexRow) codexRow.lastReadSeq = 0;
    const entries = svc.unreadFor(B);
    // seq 1 is below historyFromSeq (2) → not owed, not counted.
    expect(entries[0].unread).toBe(0);
  });
});
