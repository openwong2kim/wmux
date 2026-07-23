// ─── ChannelStateWriter × event-log mode (PR3) ───────────────────────
// Locks down §6.4c watermark stamp applied at **write time** (hash-content match),
// §6.4b shutdown flush durable promotion, and legacy-mode invariants.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ChannelStateWriter } from '../ChannelStateWriter';
import {
  stampWatermark,
  evaluateWatermark,
} from '../../eventlog/migrateToEventLog';
import { EMPTY_CHANNEL_STATE, type ChannelState } from '../../../shared/channels';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-writer-eventlog-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function freshState(): ChannelState {
  return { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} };
}

describe('ChannelStateWriter Event log mode', () => {
  it('Stamps are applied at the time of writing — the hash matches the recorded content even if the state changes after the schedule.(§6.4c)', () => {
    const writer = new ChannelStateWriter(dir);
    let lamport = 7;
    writer.enableEventLogDualWrite({
      stamp: (s) => stampWatermark(s, lamport),
      durableFlush: true,
    });
    const state = freshState();
    writer.saveDebounced(state); // scheduled (30s debounce — not yet written)
    // After schedule, before write: advance state and lamport (live-ref capture window).
    state.channels.push({
      id: 'c1', companyId: 'co', name: 'late', visibility: 'public',
      status: 'active', createdAt: 1, createdBy: 'ws-1', nextSeq: 1,
    });
    state.members['c1'] = [];
    state.messages['c1'] = [];
    state.idempotency['c1'] = {};
    lamport = 9;
    writer.flushSync(); // §6.4b path — stamp at write time

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'));
    // Written content includes late channel + watermark matches write-time values (lamport 9, hash match).
    expect(raw.channels).toHaveLength(1);
    expect(raw.eventLogWatermark.lamport).toBe(9);
    expect(evaluateWatermark(raw).kind).toBe('unchanged');
  });

  it('shutdown flush(§6.4b): durableFlush Via fsync when active', () => {
    const writer = new ChannelStateWriter(dir);
    writer.enableEventLogDualWrite({
      stamp: (s) => stampWatermark(s, 1),
      durableFlush: true,
    });
    writer.saveDebounced(freshState());
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    writer.flushSync();
    expect(fsyncSpy).toHaveBeenCalled(); // §2.3 durable sequence
  });

  it('legacy mode(Not set): no stamp + flush Non-durable — unchanged from existing behavior', () => {
    const writer = new ChannelStateWriter(dir);
    writer.saveDebounced(freshState());
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    writer.flushSync();
    expect(fsyncSpy).not.toHaveBeenCalled();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'channels.json'), 'utf8'));
    expect(raw.eventLogWatermark).toBeUndefined();
  });

  it('saveImmediate({durable:true}): migration/reseed Durable promotion of rewrite path', () => {
    const writer = new ChannelStateWriter(dir);
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    expect(writer.saveImmediate(freshState(), { durable: true })).toBe(true);
    expect(fsyncSpy).toHaveBeenCalled();
    fsyncSpy.mockClear();
    // Legacy call sites without options remain non-durable.
    expect(writer.saveImmediate(freshState())).toBe(true);
    expect(fsyncSpy).not.toHaveBeenCalled();
  });
});
