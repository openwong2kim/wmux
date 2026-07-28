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

function makeService(
  opts: {
    trashTtlHours?: number;
    autoTrashArchivedHours?: number;
    isChannelRetained?: (channelId: string) => boolean;
  } = {},
) {
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

  it('does not even ATTEMPT to destroy a channel outside the trash', async () => {
    // Asserting on the outcome alone cannot tell "the sweep selected the right
    // channels" from "the sweep selected everything and destroy() refused" —
    // mutation testing caught exactly that hole. Spy on the call so the
    // SELECTION is pinned independently of the precondition backing it up.
    const { svc, setClock } = makeService({ trashTtlHours: 1 });
    const untrashed = await makeMissionChannel(svc, 'mission-untrashed');
    await svc.archive({
      channelId: untrashed,
      archivedBy: 'ws-agent',
      verifiedWorkspaceId: 'ws-agent',
    });
    const doomed = await makeMissionChannel(svc, 'mission-doomed');
    await svc.trash({ channelId: doomed, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    const destroySpy = vi.spyOn(svc, 'destroy');

    setClock(T0 + 10_000 * HOUR);
    await svc.sweepRetention();

    expect(destroySpy.mock.calls.map((c) => c[0].channelId)).toEqual([doomed]);
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

  it('auto-trash moves (not deletes) archived channels, and only archived ones', async () => {
    const { svc, setClock } = makeService({ autoTrashArchivedHours: 24, trashTtlHours: 30 * 24 });
    const id = await makeMissionChannel(svc);
    await svc.archive({ channelId: id, archivedBy: 'ws-agent', verifiedWorkspaceId: 'ws-agent' });
    // A live channel of the same age must not be swept up with it — auto-trash
    // is an ARCHIVED-channel policy, and hiding a room people still post in
    // would be the worst possible reading of "periodic cleanup".
    const live = await makeMissionChannel(svc, 'mission-live');

    setClock(T0 + 48 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.trashed).toEqual([id]);
    expect(row(svc, live)?.status).toBe('active');
    expect(row(svc, live)?.trashedAt).toBeUndefined();
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

  it('a restore landing mid-sweep wins — retention never beats an explicit undo', async () => {
    // The purge list is a snapshot and every destroy awaits a commit. If the
    // operator pulls a channel back out during one of those windows, destroy's
    // "is trashed" precondition alone would not save it — the live re-check does.
    const { svc, setClock } = makeService({ trashTtlHours: 1 });
    const first = await makeMissionChannel(svc, 'mission-first');
    const rescued = await makeMissionChannel(svc, 'mission-rescued');
    await svc.trash({ channelId: first, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    await svc.trash({ channelId: rescued, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    setClock(T0 + 10 * HOUR);

    // Restore `rescued` the moment the first destroy commits, i.e. after the
    // purge list was already snapshotted with both ids on it.
    const realDestroy = svc.destroy.bind(svc);
    vi.spyOn(svc, 'destroy').mockImplementation(async (params) => {
      const res = await realDestroy(params);
      if (params.channelId === first) {
        await svc.restore({ channelId: rescued, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
      }
      return res;
    });

    const swept = await svc.sweepRetention();

    expect(swept.destroyed).toEqual([first]);
    expect(row(svc, rescued)).toBeDefined();
    expect(row(svc, rescued)?.trashedAt).toBeUndefined();
    expect(svc.getMessages(rescued, undefined, HUMAN_WORKSPACE_ID)).toHaveLength(1);
    // destroy's own precondition would also have saved the data, so asserting
    // survival alone cannot tell the re-check from the fallback. The observable
    // difference is the report: a restored channel must be SKIPPED, not recorded
    // as a failed op that warns every hour about correct behaviour.
    expect(swept.failed).toEqual([]);
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

describe('catalog fan-out — the deletion must reach somebody', () => {
  /** Catalog events emitted for `channelId`, newest last. */
  function catalogEvents(emit: ReturnType<typeof vi.fn>, channelId: string) {
    return emit.mock.calls
      .map((c) => c[0] as { type: string; channelId: string; recipientWorkspaceIds: string[] })
      .filter((e) => e.type === 'channel.catalog' && e.channelId === channelId);
  }

  it('destroying a zero-member PRIVATE channel still notifies the operator', async () => {
    // The bug: emitCatalog ran AFTER the applier removed the row, so its own
    // private-channel lookup found nothing and the recipient list (derived from
    // an already-deleted member map) was empty — nobody heard, and the operator
    // sidebar kept a ghost row no refresh would ever clear.
    const { svc, emit } = makeService();
    const id = await makeMissionChannel(svc);
    await svc.leave({
      channelId: id,
      workspaceId: 'ws-agent',
      memberId: 'agent-1',
      verifiedWorkspaceId: 'ws-agent',
    });
    expect(svc.getMembers(id, HUMAN_WORKSPACE_ID)).toEqual([]);
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    emit.mockClear();

    const res = await svc.destroy({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);

    const events = catalogEvents(emit, id);
    expect(events).toHaveLength(1);
    expect(events[0]?.recipientWorkspaceIds).toContain(HUMAN_WORKSPACE_ID);
  });

  it('a PUBLIC channel fans out to everyone on trash and restore', async () => {
    // list() shows a public channel to every workspace, so its NON-member
    // observers must hear that it moved to (or out of) the trash. Members-only
    // fan-out left them showing a row that no longer exists.
    const { svc, emit } = makeService();
    const created = await svc.create({
      name: 'town-square',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error('create failed');
    const id = created.channel.id;

    emit.mockClear();
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(catalogEvents(emit, id)[0]?.recipientWorkspaceIds).toEqual(['*']);

    emit.mockClear();
    await svc.restore({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(catalogEvents(emit, id)[0]?.recipientWorkspaceIds).toEqual(['*']);
  });

  it('an idempotent no-op trash/restore still re-emits (a stale mirror converges)', async () => {
    const { svc, emit } = makeService();
    const id = await makeMissionChannel(svc);
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    emit.mockClear();
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID }); // no-op
    expect(catalogEvents(emit, id)).toHaveLength(1);

    await svc.restore({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    emit.mockClear();
    await svc.restore({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID }); // no-op
    expect(catalogEvents(emit, id)).toHaveLength(1);
  });
});

describe('sweep — WorkTask anchor + failure reporting', () => {
  it('does not destroy a TTL-expired channel an open mission still anchors', async () => {
    let retained = true;
    const { svc, setClock } = makeService({
      trashTtlHours: 1,
      isChannelRetained: (id) => retained && id === anchored,
    });
    const anchored = await makeMissionChannel(svc, 'mission-anchored');
    await svc.trash({ channelId: anchored, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    setClock(T0 + 10_000 * HOUR);
    const first = await svc.sweepRetention();
    expect(first.destroyed).toEqual([]);
    expect(row(svc, anchored)).toBeDefined();

    // The mission closes → the anchor releases → the next sweep finishes the job.
    retained = false;
    const second = await svc.sweepRetention();
    expect(second.destroyed).toEqual([anchored]);
    expect(row(svc, anchored)).toBeUndefined();
  });

  it('reports refused ops instead of swallowing them', async () => {
    const { svc, setClock } = makeService({ trashTtlHours: 1 });
    const id = await makeMissionChannel(svc, 'mission-stuck');
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    vi.spyOn(svc, 'destroy').mockResolvedValue({
      ok: false,
      error: { code: 'PERSIST_FAILED', message: 'disk full' },
    });

    setClock(T0 + 10_000 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.destroyed).toEqual([]);
    expect(swept.failed).toEqual([{ id, op: 'destroy', code: 'PERSIST_FAILED' }]);
  });
});

describe('retention knob coercion', () => {
  it('a deliberate sub-hour TTL rounds UP to 1h instead of flooring to "off"', async () => {
    // 0.5 h floored to 0 would read "delete aggressively" as "never delete" —
    // the exact opposite of what the operator asked for.
    const { svc, setClock } = makeService({ trashTtlHours: 0.5 });
    const id = await makeMissionChannel(svc);
    await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    setClock(T0 + 2 * HOUR);
    const swept = await svc.sweepRetention();

    expect(swept.destroyed).toEqual([id]);
  });
});

describe('destroy — runtime hygiene + audit', () => {
  it('drops the per-channel runtime idempotency LRU', async () => {
    // The applier clears `state.idempotency[channelId]`, but the service's
    // private runtime Map is keyed by the same id and nothing else evicts it —
    // up to 1000 entries per channel would outlive the channel for the daemon's
    // whole life. Not observable through the public API, so pin the source.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/daemon/channels/ChannelService.ts'), 'utf8');
    expect(src).toContain('this.idempotency.delete(channel.id);');
  });

  it('stamps the audit fields on the destroy event (the only surviving trace)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/daemon/channels/ChannelService.ts'), 'utf8');
    expect(src).toContain('destroyedBy: params.verifiedWorkspaceId');
    expect(src).toContain('destroyedAt: this.now()');
  });
});
