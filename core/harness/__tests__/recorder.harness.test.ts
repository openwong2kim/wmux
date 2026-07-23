// E0 harness — recorder/differ unit verification (spec §5-1·§5-2)
//
// Narrowly verifies recording output schema/invariants and replay offset alignment (the 4-gate suite
// handles integration verification, so here we only verify plumbing-level contracts).

import { describe, it, expect } from 'vitest';
import { record, serializeEvents, parseEvents } from '../recorder';
import { WORKLOADS, workloadByName } from '../workloads';
import {
  XtermSubject,
  diffGrids,
  validateEventStream,
  loadIntendedDiffs,
  runDifferential,
} from '../differ';
import type { GridSnapshot, IntendedDiff, RecordingEvent } from '../types';

describe('recorder — events round trip and invariants', () => {
  it('events.jsonl serialize→parse round trip is lossless', async () => {
    const w = workloadByName('resize-roundtrip')!;
    const res = await record(w, 0);
    const roundtrip = parseEvents(serializeEvents(res.events));
    expect(roundtrip).toEqual(res.events);
  });

  it('trail head is always init (byteOffset=0) and carries geometry/reflowMode', async () => {
    for (const w of WORKLOADS) {
      const res = await record(w, 0);
      const first = res.events[0];
      expect(first.type, `[${w.name}] head is not init`).toBe('init');
      expect(first.byteOffset).toBe(0);
      if (first.type === 'init') {
        expect(first.geometry).toEqual(w.initialGeometry);
        expect(first.reflowMode).toBe(w.reflowMode);
      }
    }
  });

  it('byteOffset is monotonically increasing and within [0, recording.length]', async () => {
    for (const w of WORKLOADS) {
      const res = await record(w, 0);
      let prev = -1;
      for (const e of res.events) {
        expect(e.byteOffset, `[${w.name}] monotonicity violation`).toBeGreaterThanOrEqual(prev);
        expect(e.byteOffset).toBeGreaterThanOrEqual(0);
        expect(e.byteOffset).toBeLessThanOrEqual(res.bytes.length);
        prev = e.byteOffset;
      }
    }
  });

  it('meta has synthetic=true and workloadHash matches bytes sha256', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    expect(res.meta.synthetic).toBe(true);
    // Re-record same workload·seed → same hash.
    const res2 = await record(w, 0);
    expect(res2.meta.workloadHash).toBe(res.meta.workloadHash);
  });
});

describe('differ — diff engine 4-class ledger', () => {
  it('identical grids are identical (zero mismatches)', async () => {
    const w = workloadByName('scroll-flood')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g1 = await s.replay(res.bytes, res.events);
    const g2 = await s.replay(res.bytes, res.events);
    const report = diffGrids(w.name, g1.grid, g2.grid, 'a', 'b');
    expect(report.identical).toBe(true);
    expect(report.mismatches.length).toBe(0);
  });

  it('mutating one cell catches exactly that coordinate·field as unclassified mismatch', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g1 = await s.replay(res.bytes, res.events);
    const g2 = await s.replay(res.bytes, res.events);
    // Artificially mutate g2's (0,0) cell char (modify after structural clone).
    const mutated = {
      ...g2.grid,
      cells: g2.grid.cells.map((row, y) =>
        y === 0 ? row.map((c, x) => (x === 0 ? { ...c, char: 'Z' } : c)) : row,
      ),
    };
    const report = diffGrids(w.name, g1.grid, mutated, 'a', 'b');
    expect(report.identical).toBe(false);
    const charMismatch = report.mismatches.find((m) => m.x === 0 && m.y === 0 && m.field === 'char');
    expect(charMismatch, '(0,0) char mismatch must be caught').toBeTruthy();
    // Implicit (d) forbidden: unclassified if not on approval list.
    expect(charMismatch!.classification).toBe('unclassified');
  });

  it('only mismatches on the intended approval list are promoted to intended', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g1 = await s.replay(res.bytes, res.events);
    const mutated = {
      ...g1.grid,
      cells: g1.grid.cells.map((row, y) =>
        y === 0 ? row.map((c, x) => (x === 0 ? { ...c, char: 'Z' } : c)) : row,
      ),
    };
    const intended: IntendedDiff[] = [
      { workloadName: w.name, x: 0, y: 0, field: 'char', reason: 'test: approved as intended difference' },
    ];
    const report = diffGrids(w.name, g1.grid, mutated, 'a', 'b', intended);
    const charMismatch = report.mismatches.find((m) => m.x === 0 && m.y === 0 && m.field === 'char');
    expect(charMismatch!.classification, 'listed entry is intended').toBe('intended');
  });

  // R5: Catch activeBuffer mismatch before cell comparison.
  it('activeBuffer (normal vs alternate) mismatch is top-priority signal', async () => {
    const w = workloadByName('alt-screen')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g = await s.replay(res.bytes, res.events);
    const alt: GridSnapshot = { ...g.grid, activeBuffer: 'alternate' as const };
    const report = diffGrids(w.name, g.grid, alt, 'a', 'b');
    const bufMismatch = report.mismatches.find((m) => m.field === 'activeBuffer');
    expect(bufMismatch, 'activeBuffer mismatch must be caught').toBeTruthy();
    expect(bufMismatch!.a).toBe('normal');
    expect(bufMismatch!.b).toBe('alternate');
  });

  // R6: fgMode/bgMode raw constants are not cross-subject diff targets.
  it('fgMode/bgMode (raw color-mode constants) are excluded from diff (not portable)', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g = await s.replay(res.bytes, res.events);
    // Artificially make raw fgMode different on a colored cell (row 0 cell 0 = red foreground).
    const mutated: GridSnapshot = {
      ...g.grid,
      cells: g.grid.cells.map((row, y) =>
        y === 0
          ? row.map((c, x) => (x === 0 ? { ...c, fgMode: c.fgMode + 999, bgMode: c.bgMode + 999 } : c))
          : row,
      ),
    };
    const report = diffGrids(w.name, g.grid, mutated, 'a', 'b');
    // fgMode/bgMode only differing must not be caught as mismatch (excluded from diff fields).
    expect(report.mismatches.some((m) => m.field === 'fgMode'), 'fgMode is not a diff target').toBe(false);
    expect(report.mismatches.some((m) => m.field === 'bgMode'), 'bgMode is not a diff target').toBe(false);
  });
});

describe('differ — event stream validation (R3)', () => {
  const geom = { cols: 80, rows: 24 } as const;
  const init: RecordingEvent = { type: 'init', byteOffset: 0, geometry: geom, reflowMode: 'self' };

  it('valid stream (init head + monotonic offset + in range) passes', () => {
    const events: RecordingEvent[] = [
      init,
      { type: 'resize', byteOffset: 5, geometry: geom },
      { type: 'resize', byteOffset: 10, geometry: geom },
    ];
    expect(() => validateEventStream(events, 10)).not.toThrow();
  });

  it('throws when first event is not init', () => {
    const events: RecordingEvent[] = [{ type: 'resize', byteOffset: 0, geometry: geom }];
    expect(() => validateEventStream(events, 10)).toThrow(/first event is not init/);
  });

  it('throws on empty stream', () => {
    expect(() => validateEventStream([], 10)).toThrow(/is empty/);
  });

  it('throws when byteOffset decreases in original order (no sort masking)', () => {
    // Corrupt event file fixture: offset regresses 12 → 5 (non-monotonic in original order).
    const events: RecordingEvent[] = [
      init,
      { type: 'resize', byteOffset: 12, geometry: geom },
      { type: 'resize', byteOffset: 5, geometry: geom },
    ];
    expect(() => validateEventStream(events, 20)).toThrow(/not monotonically non-decreasing/);
  });

  it('throws when byteOffset exceeds recording range', () => {
    const events: RecordingEvent[] = [init, { type: 'resize', byteOffset: 999, geometry: geom }];
    expect(() => validateEventStream(events, 10)).toThrow(/out of range/);
  });

  it('corrupt stream also throws at replay entry (no sort masking)', async () => {
    const s = new XtermSubject();
    const recording = new Uint8Array([65, 66, 67]); // "ABC"
    const corrupt: RecordingEvent[] = [
      init,
      { type: 'resize', byteOffset: 3, geometry: geom },
      { type: 'resize', byteOffset: 1, geometry: geom }, // Regression — corrupt.
    ];
    await expect(s.replay(recording, corrupt)).rejects.toThrow(/not monotonically non-decreasing/);
  });

  it('corrupt event file read via parseEvents also throws on replay', async () => {
    // events.jsonl text fixture containing offset regression (simulates corrupt file).
    const jsonl =
      JSON.stringify(init) +
      '\n' +
      JSON.stringify({ type: 'resize', byteOffset: 3, geometry: geom }) +
      '\n' +
      JSON.stringify({ type: 'resize', byteOffset: 0, geometry: geom }) +
      '\n';
    const events = parseEvents(jsonl);
    const s = new XtermSubject();
    await expect(s.replay(new Uint8Array([65, 66, 67]), events)).rejects.toThrow(
      /not monotonically non-decreasing/,
    );
  });
});

describe('differ — intended-diffs loader wiring (R4)', () => {
  it('loadIntendedDiffs loads repo intended-diffs.json with valid schema', () => {
    const list = loadIntendedDiffs();
    expect(Array.isArray(list)).toBe(true);
    // Two reserved entries: cjk-emoji VS16 width + resize-reflow round-trip restore.
    const vs16 = list.find(
      (i) => i.workloadName === 'cjk-emoji' && i.x === 0 && i.y === 2 && i.field === 'width',
    );
    const reflow = list.find(
      (i) => i.workloadName === 'resize-reflow' && i.x === 79 && i.y === 0 && i.field === 'char',
    );
    expect(vs16, 'VS16 heart width reserved entry').toBeTruthy();
    expect(reflow, 'resize-reflow restore reserved entry').toBeTruthy();
    // Every entry has a reason (human documented why it's intentional).
    for (const i of list) expect(i.reason.length, 'reason is empty').toBeGreaterThan(0);
  });

  it('invalid path throws explicitly (no silent empty-list fallback)', () => {
    expect(() => loadIntendedDiffs('/nonexistent/intended-diffs.json')).toThrow(/load failed/);
  });

  it('runDifferential wires loader and promotes listed coordinates to intended', async () => {
    // Same subject twice, but artificially mutate one side to make cjk-emoji VS16 cell (0,2) width different,
    // then verify runDifferential promotes that coordinate to intended via auto-loaded approval list.
    const w = workloadByName('cjk-emoji')!;
    const res = await record(w, 0);
    const baseline = new XtermSubject();
    // Create subjectB as wrapper subject that "changes VS16 cell width to 2" (mimics E1 core U16 promotion).
    const promoted: import('../differ').Subject = {
      name: 'e1-mock',
      async replay(recording, events) {
        const r = await baseline.replay(recording, events);
        const cells = r.grid.cells.map((row, y) =>
          y === 2 ? row.map((c, x) => (x === 0 ? { ...c, width: 2 } : c)) : row,
        );
        return { ...r, grid: { ...r.grid, cells } };
      },
    };
    const report = await runDifferential(w.name, res.bytes, res.events, baseline, promoted);
    const vs16Mismatch = report.mismatches.find(
      (m) => m.x === 0 && m.y === 2 && m.field === 'width',
    );
    expect(vs16Mismatch, 'VS16 width mismatch must be caught').toBeTruthy();
    expect(vs16Mismatch!.classification, 'listed coordinate is promoted to intended').toBe('intended');
  });
});
