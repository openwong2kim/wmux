// ─── ChannelService × event log (PR3 integration) ────────────────────────────
// envelope-design §5 commit-path inversion contract lock:
//   - 1 commit = 1 envelope, commit failure (injected fsync) → PERSIST_FAILED + rollback + no event
//   - reboot = snapshot fallback chain + tail replay → converges with live projection
//   - stale snapshot marker → converges via idempotent re-apply
//   - dual-write watermark (§6.4c): zero false reseed on normal reboot / old-daemon write detection

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ChannelService } from '../ChannelService';
import type { ChannelServiceEventLog } from '../ChannelService';
import { ChannelStateWriter } from '../ChannelStateWriter';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import {
  SnapshotStore,
  SNAPSHOT_DIRNAME,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
} from '../../eventlog/SnapshotStore';
import { evaluateWatermark, stampWatermark } from '../../eventlog/migrateToEventLog';
import { EMPTY_CHANNEL_STATE, type ChannelState } from '../../../shared/channels';

let dir: string;
let eventsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-svc-eventlog-'));
  eventsDir = path.join(dir, 'events');
  // Simulate post-migration state: genesis (empty state, lamport 0) exists.
  const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  store.writeDurableSync(
    GENESIS_CHANNEL_REF,
    { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} },
    0,
    ChannelStateWriter.isChannelState,
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  svc: ChannelService;
  writer: ChannelStateWriter;
  log: AppendOnlyLog;
  snapshots: SnapshotStore;
  emit: ReturnType<typeof vi.fn>;
  deps: ChannelServiceEventLog;
}

function makeHarness(opts: { fsync?: (fd: number) => void } = {}): Harness {
  const writer = new ChannelStateWriter(dir);
  const log = new AppendOnlyLog({
    dir: eventsDir,
    fsync: opts.fsync ?? ((): void => {}),
  });
  log.open();
  const snapshots = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  writer.enableEventLogDualWrite({
    // Same wiring as index.ts boot gate — write-time watermark (§6.4c).
    stamp: (s) => stampWatermark(s, log.lamportHwm),
    durableFlush: true,
  });
  const deps: ChannelServiceEventLog = {
    log,
    snapshots,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    machineId: 'machine-test',
  };
  const emit = vi.fn();
  const svc = new ChannelService({
    writer,
    eventLog: deps,
    companyId: 'co-test',
    emit,
    now: (() => {
      let t = 1_700_000_000_000;
      return () => ++t;
    })(),
  });
  return { svc, writer, log, snapshots, emit, deps };
}

/** Live projection snapshot (deep clone for comparison). */
function stateOf(svc: ChannelService): ChannelState {
  return JSON.parse(
    JSON.stringify((svc as unknown as { state: ChannelState }).state),
  ) as ChannelState;
}

/** Representative mutation battery — covers all event kinds. */
async function runBattery(svc: ChannelService): Promise<string> {
  const created = await svc.create({
    name: 'general',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
    verifiedWorkspaceId: 'ws-1',
  });
  if (!created.ok) throw new Error('create failed');
  const chId = created.channel.id;
  expect((await svc.join({
    channelId: chId,
    member: { workspaceId: 'ws-2', memberId: 'm-2' },
    includeHistory: true,
    verifiedWorkspaceId: 'ws-2',
  })).ok).toBe(true);
  expect((await svc.invite({
    channelId: chId,
    invitedMember: { workspaceId: 'ws-3', memberId: 'm-3' },
    verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.post({
    channelId: chId,
    sender: { workspaceId: 'ws-1', memberId: 'm-1' },
    text: 'hello @ws-2',
    verifiedWorkspaceId: 'ws-1',
    clientMsgId: 'cli-1',
    mentions: [{ workspaceId: 'ws-2', name: 'two' }],
  })).ok).toBe(true);
  expect((await svc.post({
    channelId: chId,
    sender: { workspaceId: 'ws-2', memberId: 'm-2' },
    text: 'reply',
    verifiedWorkspaceId: 'ws-2',
  })).ok).toBe(true);
  expect((await svc.ack({
    channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: 2, memberId: 'm-2',
  })).ok).toBe(true);
  expect((await svc.ack({
    channelId: chId, verifiedWorkspaceId: 'ws-3', uptoSeq: 2, // receipt-only
  })).ok).toBe(true);
  expect((await svc.leave({
    channelId: chId, workspaceId: 'ws-3', memberId: 'm-3', verifiedWorkspaceId: 'ws-3',
  })).ok).toBe(true);
  const second = await svc.create({
    name: 'ops',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
    verifiedWorkspaceId: 'ws-1',
    members: [{ workspaceId: 'ws-2', memberId: 'm-2b' }],
  });
  if (!second.ok) throw new Error('second create failed');
  expect((await svc.kick({
    channelId: second.channel.id,
    targetWorkspaceId: 'ws-2',
    targetMemberId: 'm-2b',
    verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.purgeMembership({
    workspaceId: 'ws-2', verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.archive({
    channelId: second.channel.id, archivedBy: 'ws-1', verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  return chId;
}

describe('ChannelService × Event log (§5 Invert commit path)', () => {
  it('1 commit = 1 envelope — The number of commits in the battery matches the number and kind of log records.', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    const kinds = h.log.readAllRecords().map(
      (r) => (r.payload as { kind: string }).kind,
    );
    // create/join/invite/post/post/ack/ack/leave/create/kick/purge/archive = 12 commits.
    expect(kinds).toEqual([
      'create', 'join', 'invite', 'post', 'post', 'ack', 'ack', 'leave',
      'create', 'kick', 'purge', 'archive',
    ]);
    // domain·origin stamp (§1): every record channel domain + machineId.
    for (const rec of h.log.readAllRecords()) {
      expect(rec.domain).toBe('channel');
      expect(rec.origin.machineId).toBe('machine-test');
      expect(rec.authContext.verifiedWorkspaceId.length).toBeGreaterThan(0);
    }
    h.log.close();
  });

  it('reboot(No snapshots): genesis + Full replay converges with live projection', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    // lamport hwm restored too (no reuse after restart — §3).
    expect(h2.log.lamportHwm).toBe(12);
    h2.log.close();
  });

  it('operator-join: seat+System messages are committed to 1 envelope and reboot replays converge.', async () => {
    const h = makeHarness();
    // private channel created by agent.
    const created = await h.svc.create({
      name: 'secret',
      visibility: 'private',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error('create failed');
    const before = h.log.readAllRecords().length;
    const res = await h.svc.operatorJoin({
      channelId: created.channel.id,
      verifiedWorkspaceId: 'ws-human',
    });
    expect(res.ok).toBe(true);
    // seat push + system message append is a single operator-join envelope (1 commit = 1 envelope).
    const recs = h.log.readAllRecords();
    expect(recs.length).toBe(before + 1);
    expect((recs.at(-1)?.payload as { kind: string }).kind).toBe('operator-join');
    const live = stateOf(h.svc);
    h.log.close();

    // reboot: genesis + full replay converges exactly with live projection (atomic re-apply).
    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    h2.log.close();
  });

  it('reboot(Snapshot Acceleration): flushsnapshot + tail replayconverge', async () => {
    const h = makeHarness();
    const chId = await runBattery(h.svc);
    // snapshot flush (marker = current hwm 12) then 2 more commits (tail).
    h.snapshots.flushSync();
    await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'after snapshot', verifiedWorkspaceId: 'ws-1',
    });
    await h.svc.ack({ channelId: chId, verifiedWorkspaceId: 'ws-1', uptoSeq: 3, memberId: 'm-1' });
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    h2.log.close();
  });

  it('Snapshot marker delay(detail > marker): Convergence with idempotent reapplication — no double application', async () => {
    const h = makeHarness();
    const chId = await runBattery(h.svc);
    // simulate race artifact: write full content (hwm 12) with old marker (lamport 4) —
    // boot re-applying lamport 5..12 over already-applied content must still converge.
    h.snapshots.writeDurableSync(
      CHANNEL_PROJECTION_REF,
      (h.svc as unknown as { state: ChannelState }).state,
      4,
      ChannelStateWriter.isChannelState,
    );
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    const replayed = stateOf(h2.svc);
    expect(replayed).toEqual(live);
    // no double-apply symptom: no duplicate messages.
    const msgs = replayed.messages[chId] ?? [];
    expect(new Set(msgs.map((m) => m.seq)).size).toBe(msgs.length);
    h2.log.close();
  });

  it('commit failed(fsync injection): PERSIST_FAILED + In-memory rollback + No event + No log records, then resume', async () => {
    let fail = false;
    const h = makeHarness({
      fsync: () => {
        if (fail) throw new Error('inject');
      },
    });
    const created = await h.svc.create({
      name: 'general', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('setup create failed');
    const before = stateOf(h.svc);
    h.emit.mockClear();

    fail = true;
    const r = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'doomed', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    // in-memory rollback: nextSeq·messages·idempotency entry restored (preserve existing rollback block shape).
    expect(stateOf(h.svc)).toEqual(before);
    // no event emission (persist-first contract).
    expect(h.emit).not.toHaveBeenCalled();
    // no rollback record on disk (§2.4-4 batch rollback).
    expect(h.log.readAllRecords()).toHaveLength(1); // create only

    // resume after failure: lamport gap allowed, reuse forbidden (§3 pitfall).
    fail = false;
    const retry = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'retry', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-x',
    });
    expect(retry.ok).toBe(true);
    const recs = h.log.readAllRecords();
    expect(recs).toHaveLength(2);
    expect(recs[1].lamport).toBe(3); // 2 is gap (consumed then rolled back), no reuse
    h.log.close();
  });

  it('Idempotent replay reconstruction(§4): Retrying same clientMsgId after reboot returns original(No duplicate commits)', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'general', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('setup');
    const first = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-dup',
    });
    if (!first.ok) throw new Error('post');
    h.log.close();

    const h2 = makeHarness();
    const retry = await h2.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'twice', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-dup',
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.idempotent).toBe(true);
      expect(retry.message.seq).toBe(first.message.seq);
      expect(retry.message.text).toBe('once');
    }
    // only one post in log (retry returns original without append).
    expect(
      h2.log.readAllRecords().filter((r) => (r.payload as { kind: string }).kind === 'post'),
    ).toHaveLength(1);
    h2.log.close();
  });

  it('watermark(§6.4c): flushThe dual-write is unchanged(Misfire 0), Gu-daemon write copy is detected', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    // forced dual-write flush (§6.4b shutdown path) — write-time stamp.
    h.writer.flushSync();
    const channelsJson = path.join(dir, 'channels.json');
    const raw1 = JSON.parse(fs.readFileSync(channelsJson, 'utf8')) as Record<string, unknown>;
    expect(evaluateWatermark(raw1).kind).toBe('unchanged'); // normal reboot — zero false reseed

    // simulate old-daemon write: content change + watermark fields round-tripped (§6.4c detection basis).
    (raw1['channels'] as Array<{ name: string }>)[0].name = 'renamed-by-old-daemon';
    fs.writeFileSync(channelsJson, JSON.stringify(raw1));
    const raw2 = JSON.parse(fs.readFileSync(channelsJson, 'utf8'));
    const verdict = evaluateWatermark(raw2);
    expect(verdict.kind).toBe('downgrade-write');
    if (verdict.kind === 'downgrade-write') expect(verdict.reason).toBe('hash-mismatch');
    h.log.close();
  });

  // ─── G1 — commit-then-apply (append-then-apply): structurally eliminate dirty read ─────────
  // legacy saveOrFail was sync (no yield in mutation critical section) but append introduced await.
  // G1 defers apply until after fsync barrier so sync reads without mutex during that await
  // window (list/getMessages) never see uncommitted optimistic state.
  describe('G1 Commit-Post-Apply', () => {
    it('① in-flight Invisible ② Invisible even after fsync reject(No roll bag) ③ resolve after thorns', async () => {
      // manual fsync gate: test holds each barrier resolve/reject directly.
      let release: (() => void) | null = null;
      let fail: ((err: Error) => void) | null = null;
      const gate = (): Promise<void> =>
        new Promise<void>((res, rej) => {
          release = res;
          fail = rej;
        });
      let gated = false;
      const h = makeHarness({
        fsync: () => (gated ? gate() : Promise.resolve()) as never,
      });
      const created = await h.svc.create({
        name: 'general', visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('setup create failed');
      const chId = created.channel.id;
      const before = stateOf(h.svc);
      h.emit.mockClear();

      // ① in-flight: append write done but barrier unresolved — projection invisible.
      gated = true;
      const postPromise = h.svc.post({
        channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
        text: 'optimistic', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-g1',
      });
      await new Promise((r) => setTimeout(r, 10)); // wait for write+barrier entry
      expect(h.svc.getMessages(chId, undefined, 'ws-1')).toHaveLength(0); // no dirty read
      expect(stateOf(h.svc)).toEqual(before);
      expect(h.emit).not.toHaveBeenCalled();

      // ② barrier reject: still unapplied — no rollback-needed state exists.
      fail!(new Error('inject barrier failure'));
      const r1 = await postPromise;
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe('PERSIST_FAILED');
      expect(h.svc.getMessages(chId, undefined, 'ws-1')).toHaveLength(0);
      expect(stateOf(h.svc)).toEqual(before);
      expect(h.emit).not.toHaveBeenCalled();

      // ③ barrier resolve: apply·visible + event emission.
      const postPromise2 = h.svc.post({
        channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
        text: 'committed', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-g1', // retry (same key)
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(h.svc.getMessages(chId, undefined, 'ws-1')).toHaveLength(0); // still invisible
      release!();
      const r2 = await postPromise2;
      expect(r2.ok).toBe(true);
      const visible = h.svc.getMessages(chId, undefined, 'ws-1');
      expect(visible).toHaveLength(1);
      expect(visible[0].text).toBe('committed');
      expect(visible[0].seq).toBe(1); // failed attempt did not consume seq (pre-decided·unapplied)
      expect(h.emit).toHaveBeenCalled();
      h.log.close();
    });

    it('Membership series(join)Also invisible before barrier — applies after commit', async () => {
      let release: (() => void) | null = null;
      let gated = false;
      const h = makeHarness({
        fsync: () =>
          (gated
            ? new Promise<void>((res) => {
                release = res;
              })
            : Promise.resolve()) as never,
      });
      const created = await h.svc.create({
        name: 'general', visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('setup');
      gated = true;
      const joinPromise = h.svc.join({
        channelId: created.channel.id,
        member: { workspaceId: 'ws-2', memberId: 'm-2' },
        verifiedWorkspaceId: 'ws-2',
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(h.svc.getMembers(created.channel.id, 'ws-1')).toHaveLength(1); // uncommitted join invisible
      release!();
      expect((await joinPromise).ok).toBe(true);
      expect(h.svc.getMembers(created.channel.id, 'ws-1')).toHaveLength(2);
      h.log.close();
    });
  });
});

// ─── panel follow-ups: trim history guard (CL-3) + log-mode semantic parity (CL-4 extension) ─────

import { applyChannelEvent } from '../channelEvents';

describe('replay trim history guard (panel CL-3)', () => {
  it('Past before conservation scope post(seq < nextSeq, msgsNone in) Reapply all no-op', () => {
    const state: ChannelState = JSON.parse(JSON.stringify(EMPTY_CHANNEL_STATE));
    state.channels.push({
      id: 'ch-1', name: 'g', visibility: 'public', createdBy: 'ws-1',
      createdAt: 1, nextSeq: 101, companyId: 'co',
    } as unknown as ChannelState['channels'][number]);
    // simulate history cap keeping only seq 100 (50 already trimmed).
    state.messages['ch-1'] = [
      { seq: 100, workspaceId: 'ws-1', memberId: 'm-1', memberName: 'a', text: 'newest', ts: 100 } as unknown as NonNullable<ChannelState['messages']['x']>[number],
    ];
    const before = JSON.parse(JSON.stringify(state));
    applyChannelEvent(state, {
      kind: 'post', channelId: 'ch-1',
      message: { seq: 50, workspaceId: 'ws-1', memberId: 'm-1', memberName: 'a', text: 'trimmed-old', ts: 50 },
    });
    // no order collapse·preserved-range eviction·cursor/idempotency side effects.
    expect(state).toEqual(before);
  });

  it('nextSeq New posts above are applied normally.(Guard does not block new players)', () => {
    const state: ChannelState = JSON.parse(JSON.stringify(EMPTY_CHANNEL_STATE));
    state.channels.push({
      id: 'ch-1', name: 'g', visibility: 'public', createdBy: 'ws-1',
      createdAt: 1, nextSeq: 101, companyId: 'co',
    } as unknown as ChannelState['channels'][number]);
    state.messages['ch-1'] = [];
    applyChannelEvent(state, {
      kind: 'post', channelId: 'ch-1',
      message: { seq: 101, workspaceId: 'ws-1', memberId: 'm-1', memberName: 'a', text: 'new', ts: 101 },
    });
    expect(state.messages['ch-1'].map((m) => m.seq)).toEqual([101]);
    expect(state.channels[0].nextSeq).toBe(102);
  });
});

describe('Log Mode Semantic Parity — Core Surface (Panel CL-4 extension)', () => {
  it('per-member cursor: ack of one member does not interfere with unread of another member + Stay after reboot', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'cur', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    expect((await h.svc.join({
      channelId: chId, member: { workspaceId: 'ws-2', memberId: 'm-2' },
      includeHistory: true, verifiedWorkspaceId: 'ws-2',
    })).ok).toBe(true);
    expect((await h.svc.join({
      channelId: chId, member: { workspaceId: 'ws-3', memberId: 'm-3' },
      includeHistory: true, verifiedWorkspaceId: 'ws-3',
    })).ok).toBe(true);
    expect((await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'one', verifiedWorkspaceId: 'ws-1',
    })).ok).toBe(true);
    expect((await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'two', verifiedWorkspaceId: 'ws-1',
    })).ok).toBe(true);
    expect((await h.svc.ack({
      channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: 2, memberId: 'm-2',
    })).ok).toBe(true);

    const rows = stateOf(h.svc).members[chId];
    // sender m-1 auto-reads own posts (live semantic) — parity target is third-party
    // non-ack member m-3 non-interference.
    const m3Before = rows.find((r) => r.memberId === 'm-3')?.lastReadSeq;
    expect(rows.find((r) => r.memberId === 'm-2')?.lastReadSeq).toBe(2);
    expect(m3Before).not.toBe(2); // other member ack does not touch m-3 cursor

    // cursor preserved after reboot (no snapshot → genesis+replay).
    h.log.close();
    const h2 = makeHarness();
    const rows2 = stateOf(h2.svc).members[chId];
    expect(rows2.find((r) => r.memberId === 'm-2')?.lastReadSeq).toBe(2);
    expect(rows2.find((r) => r.memberId === 'm-3')?.lastReadSeq).toBe(m3Before);
    h2.log.close();
  });

  it('existence-hiding: non-member list()Private channels not exposed — even after reboot', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'secret', visibility: 'private',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    expect(created.ok).toBe(true);
    expect(h.svc.list('ws-1').map((c) => c.name)).toContain('secret');
    expect(h.svc.list('ws-9').map((c) => c.name)).not.toContain('secret');
    h.log.close();
    const h2 = makeHarness();
    expect(h2.svc.list('ws-9').map((c) => c.name)).not.toContain('secret');
    expect(h2.svc.list('ws-1').map((c) => c.name)).toContain('secret');
    h2.log.close();
  });

  it('Idempotent retry: Same clientMsgId repost → 1 message — 1 message even after reboot replay', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'g', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    const p1 = await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'dup-1',
    });
    const p2 = await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'dup-1',
    });
    expect(p1.ok && p2.ok).toBe(true);
    expect(stateOf(h.svc).messages[chId]).toHaveLength(1);
    h.log.close();
    const h2 = makeHarness();
    expect(stateOf(h2.svc).messages[chId]).toHaveLength(1); // one in log too (idempotent no-append)
    h2.log.close();
  });
});

describe('Coalescing Batch Rollback — Service Level (panel 2R INFO)', () => {
  it('Same tick multiple post(3 channels) → Shared barrier failure → power PERSIST_FAILED + No log retention', async () => {
    let fail = false;
    const h = makeHarness({
      fsync: () => {
        if (fail) throw new Error('inject barrier failure');
      },
    });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const created = await h.svc.create({
        name, visibility: 'public',
        createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
        verifiedWorkspaceId: 'ws-1',
      });
      if (!created.ok) throw new Error('create failed');
      ids.push(created.channel.id);
    }
    const before = h.log.readAllRecords().length; // create 3
    fail = true;
    // different channels skip per-channel lock contention, same-tick append → one coalesced barrier.
    const results = await Promise.all(ids.map((channelId) =>
      h.svc.post({
        channelId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
        text: 'x', verifiedWorkspaceId: 'ws-1',
      }),
    ));
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    }
    // §2.4-4: batch fully physically removed — log returns to pre-barrier with no intermediate null tomb.
    expect(h.log.readAllRecords()).toHaveLength(before);
    // also unapplied in projection (G1 append-then-apply).
    for (const channelId of ids) {
      expect(stateOf(h.svc).messages[channelId] ?? []).toHaveLength(0);
    }
    fail = false;
    const retry = await h.svc.post({
      channelId: ids[0], sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'retry', verifiedWorkspaceId: 'ws-1',
    });
    expect(retry.ok).toBe(true);
    expect(stateOf(h.svc).messages[ids[0]].map((m) => m.seq)).toEqual([1]); // seq not consumed re-check
  });
});

// ─── shared log integration (PR3×PR4 unification — §2.1 single logical stream) ───────────────

import { A2aTaskService } from '../../a2a/A2aTaskService';

describe('shared log: channel × A2A single instance', () => {
  it('Mixed domain commit → lamport global forge + Both replays only consume their own domain', async () => {
    const h = makeHarness();
    const a2a = new A2aTaskService({
      log: h.log,
      origin: { machineId: 'machine-test', daemonEpoch: 1 },
    });

    // interleave channel·A2A commits — one log, one lamport clock.
    const created = await h.svc.create({
      name: 'shared', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('create failed');
    const chId = created.channel.id;
    expect((await a2a.createTask({
      id: 'task-x', title: 'T',
      from: { workspaceId: 'ws-1', name: 'S' },
      to: { workspaceId: 'ws-2', name: 'R' },
    })).ok).toBe(true);
    expect((await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'hi', verifiedWorkspaceId: 'ws-1',
    })).ok).toBe(true);
    expect((await a2a.transition({
      taskId: 'task-x', to: 'working', callerWorkspaceId: 'ws-2',
    })).ok).toBe(true);

    // single stream: mixed domains + gapless monotonic lamport (1..4) — dual instance would
    // split hwm and issue duplicate lamports.
    const recs = h.log.readAllRecords();
    expect(recs.map((r) => r.domain)).toEqual(['channel', 'a2a', 'channel', 'a2a']);
    expect(recs.map((r) => r.lamport)).toEqual([1, 2, 3, 4]);

    // reboot: channel replay ignores a2a records, a2a restore ignores channel — mutual non-pollution.
    const channelLive = stateOf(h.svc);
    h.log.close();
    const h2 = makeHarness();
    const a2a2 = new A2aTaskService({
      log: h2.log,
      origin: { machineId: 'machine-test', daemonEpoch: 1 },
    });
    a2a2.restoreFromLog();
    expect(stateOf(h2.svc)).toEqual(channelLive);
    const restored = a2a2.queryTasks('ws-2', {});
    expect(restored).toHaveLength(1);
    expect(restored[0].status.state).toBe('working');
    expect(h2.log.lamportHwm).toBe(4);
    h2.log.close();
  });
});
