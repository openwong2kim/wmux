// E0 harness — four-way baseline gate (spec: engine-core-decision-2026-07-09.md section 5-2)
//
// Matching itself (1) is not enough to pass the gate; all four conditions are required:
//   1. Determinism — two xterm.js runs produce identical snapshots.
//   2. No crashes — the entire corpus completes without a crash or panic.
//   3. Golden results — xterm.js output passes at least three workload assertions per corpus.
//   4. Reproducibility — recording and replay are stable round trips with identical bytes and results.
//
// Meaning of this gate (explicitly defined in section 5-2): establish a differential
// baseline (denominator) and demonstrate that the harness itself is trustworthy.
// Core accuracy belongs to E1 (at least 99.9%) and E4 (99.99%), not this gate.
//
// --- Remove gate 4 tautology (R1) ---------------------------------------------
// This test never writes to the repository corpus directory (CORPUS_DIR). It first
// preserves the committed corpus files (recording.bin, events.jsonl, meta.json) in
// memory, writes regenerated output to a separate temporary directory, then compares
// bytes and structure with the committed copy. This prevents the drift check from
// becoming a self-comparison against values it just overwrote. Corpus generation is
// reserved for the harness:gen-corpus script (the default path of generate-corpus.ts).

import { describe, it, beforeAll, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { record, parseEvents, serializeEvents, sha256Hex } from '../recorder';
import { WORKLOADS, workloadByName } from '../workloads';
import { XtermSubject, snapshotsEqual } from '../differ';
import { generateCorpus, CORPUS_DIR } from '../generate-corpus';
import type { CellSnapshot, GridSnapshot, RecordingEvent, ThroughputMetrics } from '../types';

/** Read the three raw files for a committed corpus case (repository read-only — no writes). */
interface CommittedCase {
  readonly recordingBin: Uint8Array;
  readonly eventsJsonlText: string;
  readonly metaJsonText: string;
  readonly events: RecordingEvent[];
}
function readCommittedCase(name: string): CommittedCase {
  const dir = path.join(CORPUS_DIR, name);
  const recordingBin = new Uint8Array(readFileSync(path.join(dir, 'recording.bin')));
  const eventsJsonlText = readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const metaJsonText = readFileSync(path.join(dir, 'meta.json'), 'utf8');
  return {
    recordingBin,
    eventsJsonlText,
    metaJsonText,
    events: parseEvents(eventsJsonlText),
  };
}

describe('E0 four-way baseline gate — xterm.js', () => {
  const subject = new XtermSubject();
  const metrics: ThroughputMetrics[] = [];

  // Preserve the committed corpus in memory first (R1), before regeneration can alter it.
  const committed = new Map<string, CommittedCase>();

  beforeAll(() => {
    for (const w of WORKLOADS) {
      committed.set(w.name, readCommittedCase(w.name));
    }
  });

  // Gate 1: replay the same recording twice in xterm.js and require identical snapshots.
  it('gate 1: xterm.js two replay snapshots match 100% across the full corpus (determinism)', async () => {
    for (const w of WORKLOADS) {
      const { recordingBin, events } = committed.get(w.name)!;
      const r1 = await subject.replay(recordingBin, events);
      const r2 = await subject.replay(recordingBin, events);
      expect(
        snapshotsEqual(r1.grid, r2.grid),
        `[${w.name}] xterm.js two replays mismatch (non-deterministic)`,
      ).toBe(true);
    }
  });

  // Gate 1 reinforcement (R10): chunk-boundary robustness; one-byte and whole-input feeds
  // must produce the same layout.
  // Verify that the parser preserves state at chunk boundaries, including when multibyte
  // UTF-8 and ESC sequences are split arbitrarily. Compare a one-byte feed with whole replay.
  //
  // Measured observation (2026-07-09): one honest exception occurs for the cjk-emoji ZWJ
  // family. If the trailing ZWJ (U+200D) arrives in another write call, it does not attach
  // to the preceding cell's grapheme string. Only char/code differ in two cells; width,
  // cursor, color, flags, buffer, and layout remain identical. This is xterm.js behavior,
  // not a harness bug. Therefore tolerate only a pure trailing-ZWJ attachment difference.
  const subjectByByte = new XtermSubject({ feedChunkBytes: 1 });
  it('gate 1-b: one-byte feed vs whole feed yields identical layout (chunk-boundary robustness)', async () => {
    for (const w of WORKLOADS) {
      const { recordingBin, events } = committed.get(w.name)!;
      const whole = await subject.replay(recordingBin, events);
      const chunked = await subjectByByte.replay(recordingBin, events);
      const diff = chunkBoundaryDiff(whole.grid, chunked.grid);
      expect(
        diff,
        `[${w.name}] chunk-boundary robustness violation (divergence beyond pure ZWJ attachment): ${diff ?? ''}`,
      ).toBeNull();
    }
  });

  // Gate 2: complete the entire corpus without crashes.
  it('gate 2: full corpus completes without crash/throw (no-crash)', async () => {
    for (const w of WORKLOADS) {
      const { recordingBin, events } = committed.get(w.name)!;
      // A thrown replay fails the test before this assertion; completion itself is the gate.
      const res = await subject.replay(recordingBin, events);
      metrics.push(res.metrics); // Reused for throughput measurements.
      expect(res.grid.cells.length, `[${w.name}] grid has no rows`).toBeGreaterThan(0);
    }
    expect(metrics.length, 'full corpus must complete').toBe(WORKLOADS.length);
  });

  // Gate 3: xterm.js output must pass the golden workload specification (at least three per corpus).
  it('gate 3: xterm.js output passes all golden assertions (≥3 per corpus)', async () => {
    for (const w of WORKLOADS) {
      // Invariant: every corpus has at least three golden assertions (specification section 5-2.3).
      expect(w.golden.length, `[${w.name}] fewer than 3 golden assertions`).toBeGreaterThanOrEqual(3);
      const { recordingBin, events } = committed.get(w.name)!;
      const res = await subject.replay(recordingBin, events);
      for (const g of w.golden) {
        const failure = g.check(res.grid);
        expect(failure, `[${w.name}] golden failure: ${g.name} → ${failure}`).toBeNull();
      }
    }
  });

  // Gate 4: reproducibility — recording→replay round trip is stable (tautology removed — R1).
  // (a) Recording regeneration yields identical bytes (two record() hashes match).
  // (b) **Committed corpus files == artifacts regenerated into a separate tmp dir**
  //     (compare without writing to the repository). recording.bin is compared by
  //     bytes; events.jsonl and meta.json by structure (parse then deep-equal).
  // (c) Replaying the committed recording passes the workload's golden assertions
  //     (round-trip stability).
  it('gate 4: record→replay round trip stable (two recordings identical bytes + tmp regen == committed + replay golden pass)', async () => {
    // Regeneration goes only to a **separate tmp directory** — never touch CORPUS_DIR.
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'wmux-harness-gate4-'));
    try {
      // Regenerate all workloads into tmp (same path as harness:gen-corpus; only the output root differs).
      const genDirs = await generateCorpus(tmpDir);
      expect(genDirs.length, 'regeneration must emit all workloads').toBe(WORKLOADS.length);

      for (const w of WORKLOADS) {
        const c = committed.get(w.name)!;
        // (a) Two recordings yield identical bytes (detect non-deterministic recording).
        const rec1 = await record(w, 0);
        const rec2 = await record(w, 0);
        expect(rec1.meta.workloadHash, `[${w.name}] two recording hashes mismatch (non-deterministic recording)`).toBe(
          rec2.meta.workloadHash,
        );

        // (b) Committed vs tmp regeneration — recording.bin bytes match.
        const tmpCaseDir = path.join(tmpDir, w.name);
        const tmpBin = new Uint8Array(readFileSync(path.join(tmpCaseDir, 'recording.bin')));
        expect(
          sha256Hex(c.recordingBin),
          `[${w.name}] committed corpus recording.bin drift (byte mismatch vs tmp regen)`,
        ).toBe(sha256Hex(tmpBin));
        // Regenerated artifact also matches the deterministic bytes from record() (cross-check).
        expect(sha256Hex(tmpBin), `[${w.name}] tmp regen != record() output`).toBe(
          rec1.meta.workloadHash,
        );

        // (b') events.jsonl — structural compare (parse then deep-equal). Robust to serialization whitespace.
        const tmpEventsText = readFileSync(path.join(tmpCaseDir, 'events.jsonl'), 'utf8');
        expect(
          parseEvents(tmpEventsText),
          `[${w.name}] committed events.jsonl structural drift`,
        ).toEqual(c.events);
        // Committed events.jsonl has a stable reserialize round trip (parser contract).
        expect(serializeEvents(c.events), `[${w.name}] events.jsonl reserialize round trip unstable`).toBe(
          tmpEventsText,
        );

        // (b'') meta.json — structural compare (parse then deep-equal). Committed and regenerated hold the same meta.
        const tmpMetaText = readFileSync(path.join(tmpCaseDir, 'meta.json'), 'utf8');
        expect(
          JSON.parse(c.metaJsonText),
          `[${w.name}] committed meta.json structural drift`,
        ).toEqual(JSON.parse(tmpMetaText));

        // (c) Replaying the committed artifact passes golden assertions (round-trip stability).
        const res = await subject.replay(c.recordingBin, c.events);
        for (const g of w.golden) {
          expect(g.check(res.grid), `[${w.name}] replay round-trip golden failure: ${g.name}`).toBeNull();
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Throughput measurement (section 5-2 requirement — xterm.js baseline numbers).
  it('throughput measurement: record xterm.js feed MB/s and full-cell extract time as baseline', async () => {
    // Measurement is observation, not a gate — print numbers for the report (budget checks arrive with E1 core).
    let totalBytes = 0;
    let totalFeedMs = 0;
    for (const m of metrics) {
      totalBytes += m.bytesTotal;
      totalFeedMs += m.feedMs;
      // eslint-disable-next-line no-console
      console.log(
        `[throughput] ${m.subject} / ${m.bytesTotal}B feed=${m.feedMs.toFixed(2)}ms ` +
          `(${m.feedMBps.toFixed(1)} MB/s) extract=${m.extractMs.toFixed(2)}ms cells=${m.cellCount}`,
      );
    }
    const aggMBps = totalFeedMs > 0 ? totalBytes / 1e6 / (totalFeedMs / 1000) : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[throughput] AGGREGATE(corpus) xterm.js: ${totalBytes}B / ${totalFeedMs.toFixed(2)}ms = ${aggMBps.toFixed(1)} MB/s`,
    );

    // Representative steady-state numbers: the committed corpus is small (≤6.4KB), so fixed
    // overhead dominates and understates MB/s. Generate a multi-MB flood on the fly (not
    // committed) to check budget order of magnitude (500/150 MB/s).
    const bigLines: string[] = [];
    for (let i = 0; i < 60000; i++) {
      bigLines.push(`line ${String(i).padStart(6, '0')} ${'.'.repeat(40)}\r\n`);
    }
    const bigBytes = new TextEncoder().encode(bigLines.join(''));
    const bigEvents = [
      { type: 'init' as const, byteOffset: 0 as const, geometry: { cols: 80, rows: 24 }, reflowMode: 'self' as const },
    ];
    const bigRes = await subject.replay(bigBytes, bigEvents);
    // eslint-disable-next-line no-console
    console.log(
      `[throughput] STEADY-STATE xterm.js: ${(bigBytes.length / 1e6).toFixed(2)}MB feed=${bigRes.metrics.feedMs.toFixed(1)}ms ` +
        `(${bigRes.metrics.feedMBps.toFixed(1)} MB/s) extract=${bigRes.metrics.extractMs.toFixed(2)}ms`,
    );

    // Assert only that measurements were collected (non-zero) — absolute numbers are environment-dependent, not a gate.
    expect(metrics.length).toBe(WORKLOADS.length);
    expect(totalBytes).toBeGreaterThan(0);
    expect(bigRes.metrics.feedMBps).toBeGreaterThan(0);
  });

  // Workload coverage invariant: committed corpus is exactly six synthetic cases (D4).
  it('corpus governance: committed corpus is exactly six synthetic cases, all synthetic=true', () => {
    expect(WORKLOADS.length, 'committed corpus is six synthetic cases').toBe(6);
    const names = WORKLOADS.map((w) => w.name).sort();
    expect(names).toEqual(
      ['alt-screen', 'cjk-emoji', 'resize-reflow', 'resize-roundtrip', 'scroll-flood', 'sgr-spectrum'].sort(),
    );
    for (const name of names) {
      const meta = JSON.parse(committed.get(name)!.metaJsonText) as {
        synthetic: boolean;
        createdVia: string;
      };
      expect(meta.synthetic, `[${name}] meta.synthetic`).toBe(true);
      expect(meta.createdVia, `[${name}] createdVia`).toBe('synthetic-generator');
      expect(workloadByName(name), `[${name}] workload definition exists`).toBeTruthy();
    }
  });
});

const ZWJ = '‍'; // Zero-Width Joiner.

/** Strip a trailing ZWJ (U+200D) from a char string for comparison. */
function stripTrailingZwj(s: string): string {
  return s.endsWith(ZWJ) ? s.slice(0, -1) : s;
}

/**
 * Chunk-boundary robustness compare (R10). Returns a divergence reason string, or null if robust.
 * Layout (shape, cursor, buffer, width, color, flags) must match exactly. char/code differences
 * are tolerated only when they are **pure trailing U+200D attachment** (measured xterm.js ZWJ
 * behavior — see gate 1-b comment above).
 */
function chunkBoundaryDiff(a: GridSnapshot, b: GridSnapshot): string | null {
  if (a.cols !== b.cols || a.rows !== b.rows) {
    return `grid-shape ${a.cols}×${a.rows} vs ${b.cols}×${b.rows}`;
  }
  if (a.activeBuffer !== b.activeBuffer) return `activeBuffer ${a.activeBuffer} vs ${b.activeBuffer}`;
  if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) {
    return `cursor (${a.cursor.x},${a.cursor.y}) vs (${b.cursor.x},${b.cursor.y})`;
  }
  // Layout fields (everything forced except char/code). Any mismatch here is a robustness violation.
  const layoutFields: (keyof CellSnapshot)[] = [
    'width', 'fg', 'bg', 'fgPalette', 'fgRGB', 'fgDefault', 'bgPalette', 'bgRGB', 'bgDefault',
    'bold', 'italic', 'dim', 'underline', 'blink', 'inverse', 'invisible', 'strikethrough', 'overline',
  ];
  for (let y = 0; y < a.rows; y++) {
    for (let x = 0; x < a.cols; x++) {
      const ca = a.cells[y]?.[x];
      const cb = b.cells[y]?.[x];
      if (!ca || !cb) continue;
      for (const f of layoutFields) {
        if (ca[f] !== cb[f]) return `(${x},${y}) layout ${f}: ${String(ca[f])} vs ${String(cb[f])}`;
      }
      // char/code: tolerate pure trailing-ZWJ differences only; any other divergence is a violation.
      if (ca.char !== cb.char && stripTrailingZwj(ca.char) !== stripTrailingZwj(cb.char)) {
        return `(${x},${y}) char "${ca.char}" vs "${cb.char}" (not pure ZWJ attachment)`;
      }
      if (ca.code !== cb.code) {
        // Confirm the code difference comes only from ZWJ attachment: if only trailing ZWJ on char differs, so does code.
        const onlyZwj =
          stripTrailingZwj(ca.char) === stripTrailingZwj(cb.char) &&
          (ca.char.endsWith(ZWJ) || cb.char.endsWith(ZWJ));
        if (!onlyZwj) return `(${x},${y}) code ${ca.code} vs ${cb.code} (not pure ZWJ attachment)`;
      }
    }
  }
  return null;
}
