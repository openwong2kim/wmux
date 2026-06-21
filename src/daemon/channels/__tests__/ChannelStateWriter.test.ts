import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChannelStateWriter } from '../ChannelStateWriter';
import {
  EMPTY_CHANNEL_STATE,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelState,
} from '../../../shared/channels';

let tmpDir: string;
let writer: ChannelStateWriter;

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-test-1',
    companyId: 'co-1',
    name: 'general',
    visibility: 'public',
    status: 'active',
    createdAt: Date.now(),
    createdBy: 'ws-creator',
    nextSeq: 1,
    ...overrides,
  };
}

function makeMember(overrides: Partial<ChannelMember> = {}): ChannelMember {
  return {
    workspaceId: 'ws-1',
    memberId: 'm-1',
    joinedAt: Date.now(),
    historyFromSeq: 0,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-test-1',
    seq: 1,
    workspaceId: 'ws-1',
    memberId: 'm-1',
    memberName: 'Alice',
    text: 'hello',
    postedAt: Date.now(),
    deliveryStatus: 'pending',
    ...overrides,
  };
}

function makeState(
  channels: Channel[] = [],
  members: Record<string, ChannelMember[]> = {},
  messages: Record<string, ChannelMessage[]> = {},
): ChannelState {
  return {
    version: 1,
    channels,
    members,
    messages,
    idempotency: {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-channelstate-test-'));
  writer = new ChannelStateWriter(tmpDir);
});

afterEach(() => {
  writer.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ChannelStateWriter', () => {
  it('saveImmediate creates channels.json', () => {
    const state = makeState([makeChannel()]);
    writer.saveImmediate(state);

    const filePath = path.join(tmpDir, 'channels.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(loaded.version).toBe(1);
    expect(loaded.channels).toHaveLength(1);
    expect(loaded.channels[0].id).toBe('ch-test-1');
  });

  it('load restores saved data', () => {
    const state = makeState(
      [makeChannel({ id: 'ch-abc', name: 'design' })],
      { 'ch-abc': [makeMember({ memberId: 'm-1' })] },
      { 'ch-abc': [makeMessage({ seq: 1, text: 'first' })] },
    );
    writer.saveImmediate(state);

    const loaded = writer.load();
    expect(loaded.version).toBe(1);
    expect(loaded.channels).toHaveLength(1);
    expect(loaded.channels[0].id).toBe('ch-abc');
    expect(loaded.members['ch-abc']).toHaveLength(1);
    expect(loaded.messages['ch-abc'][0].text).toBe('first');
  });

  it('load falls back to .bak when primary is corrupt', () => {
    // Save valid state, then save again (first becomes .bak).
    writer.saveImmediate(
      makeState([makeChannel({ id: 'ch-good' })]),
    );
    writer.saveImmediate(
      makeState([makeChannel({ id: 'ch-good2' })]),
    );

    // Corrupt the primary.
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(filePath, '{{not valid json', 'utf-8');

    const loaded = writer.load();
    // .bak had the first save; recovery should still find channels.
    expect(loaded.channels).toHaveLength(1);
    expect(loaded.channels[0].id).toBe('ch-good');
  });

  it('saveDebounced does not write immediately', async () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(makeState([makeChannel()]));

      const filePath = path.join(tmpDir, 'channels.json');
      expect(fs.existsSync(filePath)).toBe(false);

      vi.advanceTimersByTime(30_000);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 50));

    const filePath = path.join(tmpDir, 'channels.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('saveDebounced coalesces multiple calls within debounce window', async () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(makeState([makeChannel({ name: 'v1' })]));
      vi.advanceTimersByTime(10_000);
      writer.saveDebounced(makeState([makeChannel({ name: 'v2' })]));
      vi.advanceTimersByTime(10_000);
      writer.saveDebounced(makeState([makeChannel({ name: 'v3' })]));
      vi.advanceTimersByTime(10_000);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 50));

    const filePath = path.join(tmpDir, 'channels.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(loaded.channels[0].name).toBe('v3');
  });

  it('flush writes pending state immediately', () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(makeState([makeChannel({ name: 'flushed' })]));

      const filePath = path.join(tmpDir, 'channels.json');
      expect(fs.existsSync(filePath)).toBe(false);

      writer.flush();
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.channels[0].name).toBe('flushed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose clears timers and flushes pending', () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(makeState([makeChannel({ name: 'disposed' })]));
      writer.dispose();

      const filePath = path.join(tmpDir, 'channels.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.channels[0].name).toBe('disposed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('load prunes channels empty longer than the TTL', () => {
    const HOUR = 60 * 60 * 1000;
    const now = Date.now();
    // Empty 8 days ago, 7d default TTL — should be pruned.
    const stale = makeChannel({
      id: 'ch-stale',
      emptySince: now - 8 * 24 * HOUR,
    });
    // Empty 3 days ago — survives.
    const fresh = makeChannel({
      id: 'ch-fresh',
      emptySince: now - 3 * 24 * HOUR,
    });
    // Has a member — never pruned by empty-TTL.
    const live = makeChannel({ id: 'ch-live' });
    writer.saveImmediate(
      makeState(
        [stale, fresh, live],
        { 'ch-live': [makeMember()] },
      ),
    );

    const loaded = writer.load();
    const ids = loaded.channels.map((c) => c.id);

    expect(ids).not.toContain('ch-stale');
    expect(ids).toContain('ch-fresh');
    expect(ids).toContain('ch-live');
  });

  it('load keeps a channel with 0 members and no emptySince (never joined)', () => {
    // A real channel that exists on disk but has no members yet must
    // survive the empty-channel reaper — its TTL clock only starts
    // when a member leaves, which is when `emptySince` is set.
    const ch = makeChannel({ id: 'ch-never-joined' });
    writer.saveImmediate(makeState([ch]));

    const ids = writer.load().channels.map((c) => c.id);
    expect(ids).toContain('ch-never-joined');
  });

  it('honours a custom emptyChannelTtlHours from the constructor', () => {
    const HOUR = 60 * 60 * 1000;
    const now = Date.now();
    // 48h custom TTL — channel empty for 72h must be pruned.
    const customWriter = new ChannelStateWriter(tmpDir, 48);
    const stale = makeChannel({
      id: 'ch-stale-3d',
      emptySince: now - 3 * 24 * HOUR,
    });
    const fresh = makeChannel({
      id: 'ch-fresh-1d',
      emptySince: now - 24 * HOUR,
    });
    customWriter.saveImmediate(makeState([stale, fresh]));

    const ids = customWriter.load().channels.map((c) => c.id);
    expect(ids).not.toContain('ch-stale-3d');
    expect(ids).toContain('ch-fresh-1d');
  });

  it('default constructor keeps the 7-day empty TTL (no config passed)', () => {
    const HOUR = 60 * 60 * 1000;
    const ch = makeChannel({
      id: 'ch-three-day',
      emptySince: Date.now() - 3 * 24 * HOUR,
    });
    writer.saveImmediate(makeState([ch]));
    expect(writer.load().channels.map((c) => c.id)).toContain('ch-three-day');
  });

  it('rejects prototype pollution keys in JSON', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    const poisoned = JSON.stringify({
      version: 1,
      channels: [],
      members: {},
      messages: {},
      idempotency: {},
      '__proto__': { admin: true },
      'constructor': { prototype: { isAdmin: true } },
    });
    fs.writeFileSync(filePath, poisoned, 'utf-8');

    const loaded = writer.load();
    expect(loaded.version).toBe(1);
    expect(loaded.channels).toHaveLength(0);

    const plain: Record<string, unknown> = {};
    expect(plain['admin']).toBeUndefined();
    expect(plain['isAdmin']).toBeUndefined();
  });

  it('load returns empty state when no files exist', () => {
    const loaded = writer.load();
    expect(loaded.version).toBe(1);
    expect(loaded.channels).toHaveLength(0);
    expect(loaded.members).toEqual({});
    expect(loaded.messages).toEqual({});
    expect(loaded.idempotency).toEqual({});
  });

  it('atomic write creates .bak file', () => {
    writer.saveImmediate(makeState([makeChannel({ id: 'first' })]));
    writer.saveImmediate(makeState([makeChannel({ id: 'second' })]));

    const bakPath = path.join(tmpDir, 'channels.json.bak');
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakData = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
    expect(bakData.channels[0].id).toBe('first');
  });

  it('no .tmp residue after successful save', () => {
    writer.saveImmediate(makeState([makeChannel()]));
    const tmpPath = path.join(tmpDir, 'channels.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('rotation chain: three saves populate .bak and .bak.1', () => {
    writer.saveImmediate(makeState([makeChannel({ id: 'g1' })]));
    writer.saveImmediate(makeState([makeChannel({ id: 'g2' })]));
    writer.saveImmediate(makeState([makeChannel({ id: 'g3' })]));

    const primary = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'channels.json'), 'utf-8'),
    );
    const bak = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'channels.json.bak'), 'utf-8'),
    );
    const bak1Path = path.join(tmpDir, 'channels.json.bak.1');
    expect(fs.existsSync(bak1Path)).toBe(true);
    const bak1 = JSON.parse(fs.readFileSync(bak1Path, 'utf-8'));

    expect(primary.channels[0].id).toBe('g3');
    expect(bak.channels[0].id).toBe('g2');
    expect(bak1.channels[0].id).toBe('g1');
  });

  it('flushSync: with no queued task, writes pending state inline', () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(
        makeState([makeChannel({ id: 'fsync-pending' })]),
      );
      // Debounce timer has NOT fired yet.
      writer.flushSync();

      const filePath = path.join(tmpDir, 'channels.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.channels[0].id).toBe('fsync-pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushSync: drives queue.flushSync before any inline fallback', () => {
    vi.useFakeTimers();
    try {
      writer.saveDebounced(
        makeState([makeChannel({ id: 'fsync-queue' })]),
      );
      vi.advanceTimersByTime(30_000);
      // Timer fired → queue has a pending task; flushSync must drive
      // the queue's sync fallback rather than race it.
      writer.flushSync();

      const filePath = path.join(tmpDir, 'channels.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.channels[0].id).toBe('fsync-queue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('load survives a channels.json that is missing a top-level key (recover to empty)', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    // Only `version` and `channels` — the validator rejects this and
    // we should fall through to empty state, not crash.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, channels: [] }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.version).toBe(1);
    expect(loaded.channels).toEqual([]);
    // The validator rejects the malformed shape; load returns the
    // EMPTY_CHANNEL_STATE fallback.
    expect(loaded.members).toEqual({});
  });

  it('load rejects a channel with bad visibility/status', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [
          { id: 'ch-bad', companyId: 'co-1', name: 'x', visibility: 'public', status: 'weird' },
        ],
        members: {},
        messages: {},
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
  });

  it('EMPTY_CHANNEL_STATE is a valid empty shape', () => {
    expect(EMPTY_CHANNEL_STATE.version).toBe(1);
    expect(EMPTY_CHANNEL_STATE.channels).toEqual([]);
    expect(EMPTY_CHANNEL_STATE.members).toEqual({});
    expect(EMPTY_CHANNEL_STATE.messages).toEqual({});
    expect(EMPTY_CHANNEL_STATE.idempotency).toEqual({});
  });

  // ── U1 validator hardening ──────────────────────────────────────

  it('load rejects channels.json where members is a top-level array', () => {
    // typeof [] === 'object', so without the Array.isArray guard the
    // validator would silently accept a corrupt file.
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [],
        members: [],
        messages: {},
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
    expect(loaded.members).toEqual({});
  });

  it('load rejects channels.json where messages is a top-level array', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [],
        members: {},
        messages: [],
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.messages).toEqual({});
  });

  it('load rejects channels.json where idempotency is a top-level array', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [],
        members: {},
        messages: {},
        idempotency: [],
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.idempotency).toEqual({});
  });

  it('load rejects channels.json with a malformed member row (workspaceId wrong type)', () => {
    // Spot-check on the first non-empty member row catches uniform row
    // corruption even though the channel list itself is valid.
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            id: 'ch-x',
            companyId: 'co-1',
            name: 'x',
            visibility: 'public',
            status: 'active',
            createdAt: 0,
            createdBy: 'ws',
            nextSeq: 1,
          },
        ],
        members: { 'ch-x': [{ workspaceId: 1, memberId: 'm-1', joinedAt: 0, historyFromSeq: 0 }] },
        messages: {},
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
  });

  it('load rejects channels.json with a malformed message row (bad deliveryStatus)', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            id: 'ch-x',
            companyId: 'co-1',
            name: 'x',
            visibility: 'public',
            status: 'active',
            createdAt: 0,
            createdBy: 'ws',
            nextSeq: 1,
          },
        ],
        members: {},
        messages: {
          'ch-x': [
            {
              channelId: 'ch-x',
              seq: 1,
              workspaceId: 'ws-1',
              memberId: 'm-1',
              memberName: 'Alice',
              text: 'hi',
              postedAt: 0,
              deliveryStatus: 'weird',
            },
          ],
        },
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
  });

  it('load rejects channels.json where idempotency value is not a number', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [],
        members: {},
        messages: {},
        idempotency: { 'ch-x': { 'k': 'not-a-number' } },
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.idempotency).toEqual({});
  });

  // ── U2 prototype-pollution hardening ─────────────────────────────

  it('load rejects a channel whose id is a prototype-chain key (__proto__)', () => {
    // The id is a value (not a key), so the JSON.parse reviver does not
    // strip it — the validator's isSafeObjectKey check is what catches
    // it here.
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            id: '__proto__',
            companyId: 'co-1',
            name: 'x',
            visibility: 'public',
            status: 'active',
            createdAt: 0,
            createdBy: 'ws',
            nextSeq: 1,
          },
        ],
        members: {},
        messages: {},
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
  });

  it('load rejects a channel whose id is the constructor prototype key', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            id: 'constructor',
            companyId: 'co-1',
            name: 'x',
            visibility: 'public',
            status: 'active',
            createdAt: 0,
            createdBy: 'ws',
            nextSeq: 1,
          },
        ],
        members: {},
        messages: {},
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
  });

  it('load rejects a channel whose id is the prototype key', () => {
    const filePath = path.join(tmpDir, 'channels.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            id: 'prototype',
            companyId: 'co-1',
            name: 'x',
            visibility: 'public',
            status: 'active',
            createdAt: 0,
            createdBy: 'ws',
            nextSeq: 1,
          },
        ],
        members: {},
        messages: {},
        idempotency: {},
      }),
      'utf-8',
    );
    const loaded = writer.load();
    expect(loaded.channels).toEqual([]);
  });

  it('load returns a null-prototype members object via pruneKeys', () => {
    // A channel with members survives pruning — the surviving members
    // list is pruneKeys output, which uses Object.create(null).
    const ch = makeChannel({ id: 'ch-live' });
    const member = makeMember();
    writer.saveImmediate(
      makeState([ch], { 'ch-live': [member] }),
    );
    const loaded = writer.load();
    expect(Object.getPrototypeOf(loaded.members)).toBeNull();
    expect(loaded.members['ch-live']).toHaveLength(1);
  });

  // ── U3 empty-channel GC createdAt fallback ───────────────────────

  it('load prunes a never-joined channel whose createdAt is older than the TTL', () => {
    const HOUR = 60 * 60 * 1000;
    const ch = makeChannel({
      id: 'ch-orphan-8d',
      createdAt: Date.now() - 8 * 24 * HOUR,
    });
    writer.saveImmediate(makeState([ch]));

    const ids = writer.load().channels.map((c) => c.id);
    expect(ids).not.toContain('ch-orphan-8d');
  });

  it('load keeps a never-joined channel whose createdAt is within the TTL', () => {
    const HOUR = 60 * 60 * 1000;
    const ch = makeChannel({
      id: 'ch-fresh-3d',
      createdAt: Date.now() - 3 * 24 * HOUR,
    });
    writer.saveImmediate(makeState([ch]));

    const ids = writer.load().channels.map((c) => c.id);
    expect(ids).toContain('ch-fresh-3d');
  });

  it('load prunes a long-orphaned channel (lost emptySince, created 30d ago)', () => {
    // The "lost emptySince" recovery case — without the createdAt
    // fallback, this channel would be immortal.
    const HOUR = 60 * 60 * 1000;
    const ch = makeChannel({
      id: 'ch-long-orphan',
      createdAt: Date.now() - 30 * 24 * HOUR,
    });
    writer.saveImmediate(makeState([ch]));

    const ids = writer.load().channels.map((c) => c.id);
    expect(ids).not.toContain('ch-long-orphan');
  });

  it('honours a custom emptyChannelTtlHours for the createdAt fallback', () => {
    const HOUR = 60 * 60 * 1000;
    const customWriter = new ChannelStateWriter(tmpDir, 48);
    const stale = makeChannel({
      id: 'ch-stale-3d-fallback',
      createdAt: Date.now() - 3 * 24 * HOUR,
    });
    const fresh = makeChannel({
      id: 'ch-fresh-1d-fallback',
      createdAt: Date.now() - 24 * HOUR,
    });
    customWriter.saveImmediate(makeState([stale, fresh]));

    const ids = customWriter.load().channels.map((c) => c.id);
    expect(ids).not.toContain('ch-stale-3d-fallback');
    expect(ids).toContain('ch-fresh-1d-fallback');
  });

  it('load keeps a channel with an explicit emptySince within the TTL', () => {
    // Regression: the explicit emptySince path still works.
    const HOUR = 60 * 60 * 1000;
    const ch = makeChannel({
      id: 'ch-explicit-emptySince',
      emptySince: Date.now() - 3 * 24 * HOUR,
    });
    writer.saveImmediate(makeState([ch]));

    const ids = writer.load().channels.map((c) => c.id);
    expect(ids).toContain('ch-explicit-emptySince');
  });

  it('load prunes a channel with an explicit emptySince older than the TTL', () => {
    // Regression: the explicit emptySince path still prunes when stale.
    const HOUR = 60 * 60 * 1000;
    const ch = makeChannel({
      id: 'ch-stale-emptySince',
      emptySince: Date.now() - 8 * 24 * HOUR,
    });
    writer.saveImmediate(makeState([ch]));

    const ids = writer.load().channels.map((c) => c.id);
    expect(ids).not.toContain('ch-stale-emptySince');
  });

  // ── U2 (a2a-channels): saveImmediate boolean return ──────────────
  // The post path needs a real failure signal so the renderer can
  // surface a typed PERSIST_FAILED error instead of silently losing
  // the message. See docs/plans/2026-06-21-001-feat-a2a-channels-u2-plan.md
  // U1 for the rationale.
  describe('saveImmediate return value (U2 boolean contract)', () => {
    it('returns true on a successful write', () => {
      const ret = writer.saveImmediate(makeState([makeChannel()]));
      expect(typeof ret).toBe('boolean');
      expect(ret).toBe(true);
      // Synchronous, non-throwing contract preserved: no Promise.
      expect((ret as unknown as { then?: unknown })?.then).toBeUndefined();
    });

    it('returns false and logs the error when atomicWriteJSONSync throws', () => {
      // Force a real write failure by making the *parent* of the
      // target file be a regular file (not a directory). The writer
      // constructs `path.join(baseDir, 'channels.json')` and the
      // atomic write's `fs.writeFileSync(tmp, ...)` fails with
      // ENOTDIR/ENOENT because `<file>/channels.json.tmp` cannot be
      // created when the parent is a file. The writer must catch the
      // throw and return `false` (not re-throw).
      const blocker = path.join(tmpDir, 'blocker');
      fs.writeFileSync(blocker, 'this is a regular file, not a directory');

      const failingWriter = new ChannelStateWriter(blocker);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const ret = failingWriter.saveImmediate(makeState([makeChannel()]));

      expect(ret).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        '[ChannelStateWriter] Failed to save state:',
        expect.any(Error),
      );
      errSpy.mockRestore();
      failingWriter.dispose();
    });

    it('a load after a successful saveImmediate round-trips the data', () => {
      const ch = makeChannel({ id: 'ch-roundtrip', name: 'rt' });
      const ret = writer.saveImmediate(makeState([ch]));
      expect(ret).toBe(true);

      const loaded = writer.load();
      expect(loaded.channels).toHaveLength(1);
      expect(loaded.channels[0].id).toBe('ch-roundtrip');
    });

    it('call sites that ignore the return value continue to work (no throw, file is written)', () => {
      // Mirrors the existing call-site pattern: callers that don't
      // capture the return value (ChannelService.prePersist hook in
      // U3 will explicitly check, but legacy call sites don't).
      const filePath = path.join(tmpDir, 'channels.json');
      expect(fs.existsSync(filePath)).toBe(false);

      // Discard the return value explicitly.
      void writer.saveImmediate(makeState([makeChannel()]));

      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
