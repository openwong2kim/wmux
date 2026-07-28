// ─── Channel trash lifecycle tests ──────────────────────────────────────────
// The deletion path is the part of this feature that can lose data, so the
// three properties that must hold are pinned here:
//   ① a trashed channel can be restored, with its history intact;
//   ② permanent deletion removes ONLY the targeted channel, and cannot be
//      reached without going through the trash first;
//   ③ the retention sweep destroys expired trash and nothing else, and does
//      not auto-trash anything unless the operator turned that knob on.
// Plus the authz surface: the local operator may manage a channel it only
// observes, an unrelated agent workspace may not.

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import { HUMAN_WORKSPACE_ID, type ChannelState } from '../../../shared/channels';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

// In-memory fake writer (same contract as ChannelService.observer.test.ts).
function makeFakeWriter() {
  let lastSaved: ChannelState | null = null;
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  const clone = (state: ChannelState): ChannelState => ({
    version: state.version,
    channels: state.channels.map((c) => ({ ...c })),
    members: Object.fromEntries(
      Object.entries(state.members).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    messages: Object.fromEntries(
      Object.entries(state.messages).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    idempotency: Object.fromEntries(
      Object.entries(state.idempotency).map(([k, v]) => [k, { ...v }]),
    ),
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
  };
}

function makeService(opts: { trashTtlHours?: number; autoTrashArchivedHours?: number } = {}) {
  const writer = makeFakeWriter();
  const emit = vi.fn<ChannelServiceEmit>();
  let clock = T0;
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: 'co-test',
    emit,
    now: () => clock,
    ...opts,
  });
  return { svc, writer, emit, setClock: (t: number) => (clock = t) };
}

/** A private agent channel with one message. The human is NOT a member — the
 *  exact shape of a fan-out mission channel the operator only observes. */
async function makeMissionChannel(svc: ChannelService, name = 'mission-alpha'): Promise<string> {
  const created = await svc.create({
    name,
    visibility: 'private',
    createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
    verifiedWorkspaceId: 'ws-agent',
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  const posted = await svc.post({
    channelId: created.channel.id,
    sender: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
    text: 'mission log entry',
    verifiedWorkspaceId: 'ws-agent',
  });
  if (!posted.ok) throw new Error(`post failed: ${posted.error.code}`);
  return created.channel.id;
}

function row(svc: ChannelService, channelId: string) {
  return svc.list(HUMAN_WORKSPACE_ID).find((c) => c.id === channelId);
}

describe('trash — soft delete is reversible', () => {
  it('trashing an active channel archives it and stamps the trash marker', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);

    const res = await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);

    const ch = row(svc, id);
    expect(ch?.status).toBe('archived');
    expect(ch?.trashedAt).toBe(T0);
    expect(ch?.trashedBy).toBe(HUMAN_WORKSPACE_ID);
  });

  it('restore clears the marker, keeps the channel archived, and keeps history', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    const res = await svc.restore({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);

    const ch = row(svc, id);
    expect(ch?.trashedAt).toBeUndefined();
    expect(ch?.trashedBy).toBeUndefined();
    // Restore undoes the trashing, not the archiving.
    expect(ch?.status).toBe('archived');
    // ① the record survived the round trip intact.
    expect(svc.getMessages(id, undefined, HUMAN_WORKSPACE_ID).map((m) => m.text)).toEqual([
      'mission log entry',
    ]);
  });

  it('trash is idempotent — a retry does not extend the retention clock', async () => {
    const { svc, setClock } = makeService();
    const id = await makeMissionChannel(svc);
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    setClock(T0 + 100 * HOUR);
    const again = await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    expect(again.ok).toBe(true);
    expect(row(svc, id)?.trashedAt).toBe(T0);
  });

  it('restoring a channel that is not in the trash is an ok no-op', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);
    const res = await svc.restore({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);
    expect(row(svc, id)?.status).toBe('active');
  });
});

describe('destroy — permanent deletion is gated and narrow', () => {
  it('refuses a channel that is not in the trash (the undo window cannot be skipped)', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);

    const active = await svc.destroy({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(active.ok).toBe(false);
    expect(!active.ok && active.error.code).toBe('CHANNEL_NOT_TRASHED');

    // Archived-but-not-trashed is refused too.
    await svc.archive({ channelId: id, archivedBy: 'ws-agent', verifiedWorkspaceId: 'ws-agent' });
    const archived = await svc.destroy({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(archived.ok).toBe(false);
    expect(!archived.ok && archived.error.code).toBe('CHANNEL_NOT_TRASHED');
    expect(row(svc, id)).toBeDefined();
  });

  it('② destroys only the targeted channel, with its members/messages', async () => {
    const { svc } = makeService();
    const doomed = await makeMissionChannel(svc, 'mission-doomed');
    const keeper = await makeMissionChannel(svc, 'mission-keeper');
    await svc.trash({ channelId: doomed, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    await svc.trash({ channelId: keeper, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    const res = await svc.destroy({ channelId: doomed, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);

    expect(row(svc, doomed)).toBeUndefined();
    expect(row(svc, keeper)).toBeDefined();
    // The neighbour's history is untouched.
    expect(svc.getMessages(keeper, undefined, HUMAN_WORKSPACE_ID)).toHaveLength(1);
    // The destroyed channel's rows are gone, not orphaned.
    expect(svc.getMessages(doomed, undefined, HUMAN_WORKSPACE_ID)).toEqual([]);
    expect(svc.getMembers(doomed, HUMAN_WORKSPACE_ID)).toEqual([]);
  });
});

describe('authz — humans-only lifecycle gate', () => {
  it('the local operator may trash a channel it merely observes', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);
    // Precondition: the human is not a member (observation only).
    const members = svc.getMembers(id, HUMAN_WORKSPACE_ID);
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => m.workspaceId !== HUMAN_WORKSPACE_ID)).toBe(true);

    const res = await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);
  });

  it('an unrelated workspace may not trash or destroy', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);

    const trashed = await svc.trash({ channelId: id, verifiedWorkspaceId: 'ws-stranger' });
    expect(trashed.ok).toBe(false);
    expect(!trashed.ok && trashed.error.code).toBe('NOT_AUTHORIZED');

    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    const destroyed = await svc.destroy({ channelId: id, verifiedWorkspaceId: 'ws-stranger' });
    expect(destroyed.ok).toBe(false);
    expect(!destroyed.ok && destroyed.error.code).toBe('NOT_AUTHORIZED');
    expect(row(svc, id)).toBeDefined();
  });

  it('an empty verified workspace is refused (no anonymous mutation)', async () => {
    const { svc } = makeService();
    const id = await makeMissionChannel(svc);
    const res = await svc.trash({ channelId: id, verifiedWorkspaceId: '' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('NOT_AUTHORIZED');
  });
});

describe('③ retention sweep', () => {
  it('destroys trash past the TTL and leaves fresher trash alone', async () => {
    const { svc, setClock } = makeService({ trashTtlHours: 24 });
    const old = await makeMissionChannel(svc, 'mission-old');
    await svc.trash({ channelId: old, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    setClock(T0 + 20 * HOUR);
    const fresh = await makeMissionChannel(svc, 'mission-fresh');
    await svc.trash({ channelId: fresh, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    setClock(T0 + 25 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.destroyed).toEqual([old]);
    expect(row(svc, old)).toBeUndefined();
    expect(row(svc, fresh)).toBeDefined();
  });

  it('never touches channels outside the trash', async () => {
    const { svc, setClock } = makeService({ trashTtlHours: 1 });
    const active = await makeMissionChannel(svc, 'mission-active');
    const archived = await makeMissionChannel(svc, 'mission-archived');
    await svc.archive({
      channelId: archived,
      archivedBy: 'ws-agent',
      verifiedWorkspaceId: 'ws-agent',
    });

    setClock(T0 + 10_000 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.destroyed).toEqual([]);
    expect(swept.trashed).toEqual([]);
    expect(row(svc, active)?.status).toBe('active');
    expect(row(svc, archived)?.status).toBe('archived');
  });

  it('auto-trash is off by default and moves (not deletes) when enabled', async () => {
    const { svc, setClock } = makeService({ autoTrashArchivedHours: 24, trashTtlHours: 30 * 24 });
    const id = await makeMissionChannel(svc);
    await svc.archive({ channelId: id, archivedBy: 'ws-agent', verifiedWorkspaceId: 'ws-agent' });

    setClock(T0 + 48 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.trashed).toEqual([id]);
    expect(swept.destroyed).toEqual([]);
    // Moved to the trash, still recoverable with its history.
    expect(row(svc, id)?.trashedAt).toBe(T0 + 48 * HOUR);
    expect(svc.getMessages(id, undefined, HUMAN_WORKSPACE_ID)).toHaveLength(1);
  });

  it('leaves archived channels alone when auto-trash is at its default (off)', async () => {
    const { svc, setClock } = makeService();
    const id = await makeMissionChannel(svc);
    await svc.archive({ channelId: id, archivedBy: 'ws-agent', verifiedWorkspaceId: 'ws-agent' });

    setClock(T0 + 10_000 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.trashed).toEqual([]);
    expect(row(svc, id)).toBeDefined();
  });

  it('a zero TTL disables the purge pass entirely', async () => {
    const { svc, setClock } = makeService({ trashTtlHours: 0 });
    const id = await makeMissionChannel(svc);
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    setClock(T0 + 10_000 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.destroyed).toEqual([]);
    expect(row(svc, id)).toBeDefined();
  });
});
