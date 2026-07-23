import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readManifest,
  writeManifest,
  manifestPath,
  isEventLogManifest,
  pingFormatVersionField,
  EVENTLOG_FORMAT_VERSION,
  type EventLogManifest,
} from '../EventLogManifest';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-manifest-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sample(overrides: Partial<EventLogManifest> = {}): EventLogManifest {
  return {
    formatVersion: EVENTLOG_FORMAT_VERSION,
    machineId: 'm-abc',
    genesisRef: 'genesis-channel.json',
    reseedRefs: [],
    snapshotLamport: 0,
    activeSegment: 1,
    ...overrides,
  };
}

describe('EventLogManifest read/write(durable)', () => {
  it('write → read round trip(Full field preservation)', () => {
    const m = sample({ reseedRefs: ['reseed-1.json'], snapshotLamport: 7, activeSegment: 3 });
    writeManifest(dir, m);
    const read = readManifest(dir);
    expect(read).toEqual(m);
  });

  it('In absence null', () => {
    expect(readManifest(dir)).toBeNull();
  });

  it('durable Write file actually created', () => {
    writeManifest(dir, sample());
    expect(fs.existsSync(manifestPath(dir))).toBe(true);
  });

  it('primary impairment → .bak fallback', () => {
    writeManifest(dir, sample({ machineId: 'm-first' }));
    writeManifest(dir, sample({ machineId: 'm-second' })); // .bak=first, primary=second
    fs.writeFileSync(manifestPath(dir), 'CORRUPT{');
    const read = readManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.machineId).toBe('m-first'); // recovered from .bak
  });
});

describe('isEventLogManifest guard', () => {
  it('Valid manifest passed', () => {
    expect(isEventLogManifest(sample())).toBe(true);
  });

  it('Reject missing required fields', () => {
    expect(isEventLogManifest({ ...sample(), machineId: undefined })).toBe(false);
    expect(isEventLogManifest({ ...sample(), reseedRefs: 'x' })).toBe(false);
    expect(isEventLogManifest({ ...sample(), genesisRef: '' })).toBe(false);
    expect(isEventLogManifest(null)).toBe(false);
    expect(isEventLogManifest([])).toBe(false);
  });

  it('Do not reject additional fields(additive-only)', () => {
    expect(
      isEventLogManifest({ ...sample(), futureField: 'x', keyId: 'k' }),
    ).toBe(true);
  });
});

// ── §6.4a eventLogFormatVersion additive field on daemon.ping ─────────────
describe('pingFormatVersionField (§6.4a)', () => {
  it('log active(active=formatVersion) → field exposure(value=active formatVersion)', () => {
    expect(pingFormatVersionField(EVENTLOG_FORMAT_VERSION)).toEqual({
      eventLogFormatVersion: EVENTLOG_FORMAT_VERSION,
    });
    // Expose active manifest.formatVersion as-is — future generations get the real value (not hardcoded).
    expect(pingFormatVersionField(2)).toEqual({ eventLogFormatVersion: 2 });
  });

  it('log inactive(undefined — Legacy Fallback/Migration incomplete) → absence of field', () => {
    const field = pingFormatVersionField(undefined);
    expect(field).toEqual({});
    expect('eventLogFormatVersion' in field).toBe(false);
  });

  it('spread additive contract: When absent, no key is created in the response object.(absence = legacy generation)', () => {
    const active = { status: 'ok', ...pingFormatVersionField(EVENTLOG_FORMAT_VERSION) };
    const legacy = { status: 'ok', ...pingFormatVersionField(undefined) };
    expect(active.eventLogFormatVersion).toBe(EVENTLOG_FORMAT_VERSION);
    expect('eventLogFormatVersion' in legacy).toBe(false);
  });
});
