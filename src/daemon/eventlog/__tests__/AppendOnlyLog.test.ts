import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../AppendOnlyLog';
import { makeEnvelope } from '../../../shared/eventlog';
import type {
  EventEnvelope,
  EventEnvelopeDraft,
} from '../../../shared/eventlog';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-eventlog-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** append input draft (ordering fields issued by append). */
function draft(payload: unknown = {}): EventEnvelopeDraft {
  return makeEnvelope({
    domain: 'channel',
    payload,
    origin: { machineId: 'm1', daemonEpoch: 1 },
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted',
    },
  });
}

/** One complete record line (for raw segment injection — crash state setup). */
function envLine(lamport: number, seq: number, payload: unknown = {}): string {
  const env: EventEnvelope = {
    eventId: `evt-${lamport}`,
    origin: { machineId: 'm1', daemonEpoch: 1, seq },
    lamport,
    wallClock: 1000 + lamport,
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted',
    },
    domain: 'channel',
    payload,
  };
  return `${JSON.stringify(env)}\n`;
}

function seg(n: number): string {
  return path.join(dir, `${String(n).padStart(8, '0')}.ndjson`);
}

const syncOk = (): void => {};

// ── T-crash: forward scan·first bad cut·at-least-once promotion ─────────────────

describe('T-crash recovery', () => {
  it('Commit prefix lossless + valid unsynced tail promotion + torn terminal cut', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    log.close();

    // Crash simulation: after 2 commits inject (a) one valid line (promotion candidate) + (b) torn incomplete line.
    fs.appendFileSync(seg(1), envLine(3, 3, { n: 3 }));
    fs.appendFileSync(seg(1), '{"lamport":4,"origin":{"seq":4'); // no trailing newline

    const log2 = new AppendOnlyLog({ dir });
    log2.open();
    // 1,2 committed + 3 promoted → lossless. torn 4 → discarded.
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3]);
    // Promoted record reflected in hwm scan (no reuse).
    expect(log2.lamportHwm).toBe(3);
    log2.close();
  });

  it('Middle of coalescing placement torn(out of order writeback) → After defect, the valid line is also discarded.(Partial promotion prohibited)', () => {
    fs.writeFileSync(
      seg(1),
      envLine(1, 1, { n: 1 }) + 'GARBAGE-not-json\n' + envLine(3, 3, { n: 3 }),
    );
    const log = new AppendOnlyLog({ dir });
    log.open();
    // Cut at first bad (middle garbage) → valid after (lamport 3) also discarded.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1]);
    expect(log.lamportHwm).toBe(1);
    // Active segment physically truncated (bytes after bad removed).
    expect(fs.readFileSync(seg(1), 'utf8')).toBe(envLine(1, 1, { n: 1 }));
    log.close();
  });

  it('fsync eve kill(full amount valid unsynced tail) → full promotion(not cut), No partial promotion', () => {
    fs.writeFileSync(
      seg(1),
      envLine(1, 1) + envLine(2, 2) + envLine(3, 3),
    );
    const log = new AppendOnlyLog({ dir });
    log.open();
    // Truncate or promote — all valid so promotion.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3]);
    expect(log.lamportHwm).toBe(3);
    log.close();
  });
});

// ── T-fsync failure: batch single rollback ─────────────────────────────────────────

describe('T-fsyncfailed injection', () => {
  it('entire batch ftruncate(batchStartOffset) 1episode + everyone false + replay non-appearance', async () => {
    let failSync = true;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject fsync failure');
      },
    });
    log.open();

    // Truncate is path-based (close→truncate→reopen — avoids win32 'a' fd ftruncate EPERM).
    const truncSpy = vi.spyOn(fs, 'truncateSync');
    const results = await Promise.all([
      log.append(draft({ n: 1 })),
      log.append(draft({ n: 2 })),
      log.append(draft({ n: 3 })),
    ]);

    // Entire batch Promise resolves false.
    expect(results).toEqual([false, false, false]);
    // Single truncate removes entire batch physically (no order-dependent null tombstones).
    expect(truncSpy).toHaveBeenCalledTimes(1);
    expect(truncSpy).toHaveBeenCalledWith(expect.any(String), 0);
    // No rollback events on disk.
    expect(log.readAllRecords()).toEqual([]);

    // After rollback, normal append resumes after consumed hwm (gap), no reuse.
    failSync = false;
    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    const recs = log.readAllRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].lamport).toBe(4);
    log.close();
    truncSpy.mockRestore();

    // Reboot replay must not show rollback events.
    const log2 = new AppendOnlyLog({ dir });
    log2.open();
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([4]);
    log2.close();
  });
});

// ── T-roll crash: empty new segment must not be mistaken for first-boot ──────────────────

describe('T-Crash immediately after roll', () => {
  it('Empty new segment → Restore hwm from the previous segment(No reset/reuse)', async () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(3, 3));
    fs.writeFileSync(seg(2), ''); // empty new segment from roll, crash before write

    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(3); // value that would be 0 if misread as first-boot
    expect(log.seqHwm).toBe(3);

    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 4]);
    // New records go to active (highest-number=2) segment.
    expect(fs.readFileSync(seg(2), 'utf8')).toContain('"lamport":4');
    log.close();
  });

  it('torn Partial write new segment → beam after cutting → restore previous segment', async () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(3, 3));
    fs.writeFileSync(seg(2), '{"lamport":4,"orig'); // torn partial write

    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(3);
    expect(fs.readFileSync(seg(2), 'utf8')).toBe(''); // torn truncated

    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 4]);
    log.close();
  });

  it('segment roll: New segment when threshold is exceeded, Preservation of order and continuity beyond boundaries', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk, maxSegmentBytes: 300 });
    log.open();
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await log.append(draft({ i }));
    }
    const segs = fs
      .readdirSync(dir)
      .filter((f) => /^\d{8}\.ndjson$/.test(f));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    log.close();
  });
});

// ── T-lamport: resume·gap·promotion reflection ──────────────────────────────────────

describe('T-lamport resumption', () => {
  it('First new after restart = eve max+1 (No off-by-one)', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    await log.append(draft({ n: 3 }));
    expect(log.lamportHwm).toBe(3);
    expect(log.seqHwm).toBe(3);
    log.close();

    const log2 = new AppendOnlyLog({ dir, fsync: syncOk });
    log2.open();
    expect(log2.lamportHwm).toBe(3); // disk round-trip restore
    expect(log2.seqHwm).toBe(3);
    await log2.append(draft({ n: 4 }));
    const recs = log2.readAllRecords();
    expect(recs.map((r) => r.lamport)).toEqual([1, 2, 3, 4]); // first new = max+1
    expect(recs[recs.length - 1].origin.seq).toBe(4);
    log2.close();
  });

  it('After placement failure, hwm gap is allowed and reuse is prohibited.', async () => {
    let failSync = false;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject');
      },
    });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    await log.append(draft({ n: 3 })); // 1,2,3 committed

    failSync = true;
    const failed = await Promise.all([
      log.append(draft({ n: 'a' })),
      log.append(draft({ n: 'b' })),
    ]);
    expect(failed).toEqual([false, false]); // 4,5 consumed but uncommitted (rollback)

    failSync = false;
    await log.append(draft({ n: 6 }));
    // gap(4,5) allowed but no reuse → next success value is 6.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 6]);
    expect(log.lamportHwm).toBe(6);
    log.close();
  });

  it('The lamport of the promotion record is reflected in the hwm scan.', () => {
    // Commits 1,2 + promotion (unsynced valid) 5 → hwm scan max=5.
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(5, 5));
    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(5);
    expect(log.seqHwm).toBe(5);
    log.close();
  });
});

// ── Panel reflection: issued fields·fail-stop·async barrier·roll·close contract ─────────────

/** Manual-gate async fsync — deterministically reproduces late-arrival interleaving in the await window. */
function gatedFsync(): {
  fsync: () => Promise<void>;
  gates: Array<{ resolve: () => void; reject: (e: Error) => void }>;
} {
  const gates: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  return {
    gates,
    fsync: () =>
      new Promise<void>((resolve, reject) => {
        gates.push({ resolve, reject });
      }),
  };
}

/** Pump microtasks until barrier start (gates filled). */
async function untilGates(gates: unknown[], n: number): Promise<void> {
  for (let i = 0; i < 50 && gates.length < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  expect(gates.length).toBeGreaterThanOrEqual(n);
}

describe('Issue field @ append (eventId uniqueness)', () => {
  it('Reuse the same draft(Retry Copy)Even if a new eventId is issued for each commit record', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    const d = draft({ n: 1 });
    expect('eventId' in d).toBe(false); // draft has no issuance fields
    await log.append(d);
    await log.append(d);
    const recs = log.readAllRecords();
    expect(recs).toHaveLength(2);
    expect(typeof recs[0].eventId).toBe('string');
    expect(typeof recs[0].wallClock).toBe('number');
    expect(recs[0].eventId).not.toBe(recs[1].eventId); // global uniqueness preserved
    log.close();
  });
});

describe('fail-stop: rollback ftruncate failed (3model agreement)', () => {
  it('cutting failure → broken: arrangement false + After append, immediately false, no record, reopenresume with', async () => {
    let failSync = false;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject fsync');
      },
    });
    log.open();
    await log.append(draft({ n: 1 })); // commit

    failSync = true;
    const truncSpy = vi
      .spyOn(fs, 'truncateSync')
      .mockImplementationOnce(() => {
        throw new Error('inject truncate failure');
      });
    const r2 = await log.append(draft({ n: 2 }));
    expect(r2).toBe(false);

    // broken — no writes when coordinate invariants are violated.
    failSync = false;
    const sizeBefore = fs.statSync(seg(1)).size;
    const r3 = await log.append(draft({ n: 3 }));
    expect(r3).toBe(false);
    expect(fs.statSync(seg(1)).size).toBe(sizeBefore); // zero additional bytes
    log.close();
    truncSpy.mockRestore();

    // Resume is reopen — untruncated tail (n:2) is valid line so at-least-once promotion (§2.6 contract).
    const log2 = new AppendOnlyLog({ dir, fsync: syncOk });
    log2.open();
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([1, 2]);
    expect(log2.lamportHwm).toBe(2);
    log2.close();
  });
});

describe('fail-closed: Boot recovery truncation failure (3model agreement)', () => {
  it('If you can't cut open()This throw — do not open on bad tail', () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + 'GARBAGE-tail\n');
    const truncSpy = vi.spyOn(fs, 'truncateSync').mockImplementation(() => {
      /* Simulate worst case where truncate is silently ineffective */
    });
    const log = new AppendOnlyLog({ dir });
    expect(() => log.open()).toThrow(/recovery truncate failed/);
    truncSpy.mockRestore();
  });
});

describe('Asynchronous barrier interleaving (Corelessing Contract)', () => {
  it('Barrier Success Rolls at Boundary — Segment rolls at critical even under sustained load', async () => {
    const { fsync, gates } = gatedFsync();
    const log = new AppendOnlyLog({ dir, fsync, maxSegmentBytes: 1 });
    log.open();

    const p1 = log.append(draft({ n: 1 }));
    await untilGates(gates, 1); // barrier1 in-flight
    const p2 = log.append(draft({ n: 2 })); // await window arrival → next barrier

    gates[0].resolve();
    await expect(p1).resolves.toBe(true);
    // At barrier1 success unsynced(p2) non-empty so no roll → barrier2.
    await untilGates(gates, 2);
    gates[1].resolve();
    await expect(p2).resolves.toBe(true);

    // Roll succeeds at barrier2 success boundary (unsynced beam) — no starvation.
    expect(log.activeSegment).toContain('00000002');
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2]);
    log.close();
  });

  it('Barrier failure occurs until the await window arrives. false + single ftruncate, Normal resume afterward', async () => {
    const { fsync, gates } = gatedFsync();
    const log = new AppendOnlyLog({ dir, fsync });
    log.open();

    const p1 = log.append(draft({ n: 1 }));
    await untilGates(gates, 1);
    const p2 = log.append(draft({ n: 2 })); // late-arrival — outside barrier1

    const truncSpy = vi.spyOn(fs, 'truncateSync');
    gates[0].reject(new Error('inject barrier failure'));
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false); // all false including subsequent waiters (§2.4-4)
    expect(truncSpy).toHaveBeenCalledTimes(1); // single truncate (path-based)
    truncSpy.mockRestore();

    const p3 = log.append(draft({ n: 3 }));
    await untilGates(gates, 2);
    gates[1].resolve();
    await expect(p3).resolves.toBe(true);
    expect(log.readAllRecords().map((r) => r.payload)).toEqual([{ n: 3 }]);
    log.close();
  });

  it('close()Confirms unconfirmed append to false.(No permanent pending)', async () => {
    const log = new AppendOnlyLog({
      dir,
      fsync: () => new Promise<void>(() => {}), // permanently pending barrier
    });
    log.open();
    const p = log.append(draft({ n: 1 }));
    await Promise.resolve(); // barrier start
    log.close();
    await expect(p).resolves.toBe(false);
  });
});

describe('scan schema guard', () => {
  it('JSON line without issue field({})Silver is initially defective — then cut off., hwm unpolluted', () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + '{}\n' + envLine(3, 3));
    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1]);
    expect(log.lamportHwm).toBe(1);
    log.close();
  });
});

describe('roll open-then-swap', () => {
  it('Maintaining the current segment when opening a new segment fails(append continue to succeed), roll at the next border', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk, maxSegmentBytes: 1 });
    log.open();
    const openSpy = vi.spyOn(fs, 'openSync');
    openSpy.mockImplementationOnce(() => {
      throw new Error('inject roll open failure');
    });

    const r1 = await log.append(draft({ n: 1 })); // roll attempt at barrier success boundary fails
    expect(r1).toBe(true);
    expect(log.activeSegment).toContain('00000001'); // state unchanged — current segment retained

    const r2 = await log.append(draft({ n: 2 })); // roll succeeds at next boundary (append time)
    expect(r2).toBe(true);
    // r1 stays on seg1 (state unchanged on swap failure), r2 recorded on seg2 after roll.
    expect(fs.readFileSync(seg(1), 'utf8')).toContain('"lamport":1');
    expect(fs.readFileSync(seg(1), 'utf8')).not.toContain('"lamport":2');
    expect(fs.readFileSync(seg(2), 'utf8')).toContain('"lamport":2');
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2]);
    openSpy.mockRestore();
    log.close();
  });
});

// ── hwmFloor (§3-4 clamp, panel C): block reuse after compaction ───────────────────

describe('hwmFloor lower limit clamp', () => {
  it('Only empty segments remain(Compaction cutting simulation) + floor{5,5} → hwm 5, first new 6', async () => {
    // Compaction truncated all non-empty segments leaving only empty active segment.
    fs.writeFileSync(seg(3), '');
    const log = new AppendOnlyLog({
      dir,
      fsync: syncOk,
      hwmFloor: { lamport: 5, seq: 5 },
    });
    log.open();
    // Without floor scan hwm=0 → lamport/seq reuse (§6.L trap). floor blocks it.
    expect(log.lamportHwm).toBe(5);
    expect(log.seqHwm).toBe(5);

    const ok = await log.append(draft({ n: 'post-compaction' }));
    expect(ok).toBe(true);
    const recs = log.readAllRecords();
    expect(recs.map((r) => r.lamport)).toEqual([6]); // first new = floor+1
    expect(recs[0].origin.seq).toBe(6);
    log.close();
  });

  it('Segment Executive Director(first-boot channel)Also applied to floor', async () => {
    const log = new AppendOnlyLog({
      dir,
      fsync: syncOk,
      hwmFloor: { lamport: 7, seq: 7 },
    });
    log.open();
    expect(log.lamportHwm).toBe(7);
    await log.append(draft({ n: 1 }));
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([8]);
    log.close();
  });

  it('If scan hwm is greater than floor, scan value takes precedence(Clamp is only the lower limit)', () => {
    fs.writeFileSync(seg(1), envLine(9, 9));
    const log = new AppendOnlyLog({ dir, hwmFloor: { lamport: 5, seq: 5 } });
    log.open();
    expect(log.lamportHwm).toBe(9);
    expect(log.seqHwm).toBe(9);
    log.close();
  });
});
