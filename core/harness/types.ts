// E0 conformance harness — shared types (spec: engine-core-decision-2026-07-09.md §5-1·§5-2)
//
// Shared data structures for recorder (M1) and differential runner (M2). Canonical schema for
// recording artifacts (events.jsonl) and grid snapshot · diff report schema. Does not touch product
// code (src/) — harness-internal only.

/**
 * PTY geometry (cols · rows). Initial geometry at record start and subsequent resize events use this type.
 */
export interface Geometry {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Reflow mode. §6-3 transition table skeleton — win32 · conpty use HostReflow (core reflow not run),
 * others SelfReflow. Recorded in the trail so replay knows which reflow rules to apply.
 * Synthetic corpus is macOS (openpty) so default 'self'.
 */
export type ReflowMode = 'self' | 'host';

/**
 * One line of the recording trail (events.jsonl). Records initial geometry · resize · reflow_mode
 * transitions with **monotonically increasing byte offsets**. Replay side (differ) streams recording.bin
 * byte-by-byte and applies each event (resize etc.) at its byteOffset.
 *
 * byteOffset meaning: "after feeding this many bytes from the start of recording.bin to the subject,
 * apply this event." So offset is an absolute position in [0, recording.bin.length].
 */
export type RecordingEvent =
  | {
      readonly type: 'init';
      readonly byteOffset: 0; // init is always stream head (0 bytes fed = nothing fed yet).
      readonly geometry: Geometry;
      readonly reflowMode: ReflowMode;
    }
  | {
      readonly type: 'resize';
      readonly byteOffset: number;
      readonly geometry: Geometry;
    }
  | {
      readonly type: 'reflow_mode';
      readonly byteOffset: number;
      readonly reflowMode: ReflowMode;
    };

/**
 * meta.json schema. Metadata for reproducibility · governance.
 * - seed: seed when workload uses deterministic PRNG (synthetic workloads use fixed seed → same bytes).
 * - workloadHash: sha256 of recording.bin produced by workload (verify two recordings = same hash).
 * - workloadName: corpus case name.
 * - synthetic: from synthetic generator (committed corpus always true — D4 governance).
 * - createdVia: output path ('synthetic-generator' | 'cli-recording').
 */
export interface RecordingMeta {
  readonly workloadName: string;
  readonly seed: number;
  readonly workloadHash: string;
  readonly synthetic: boolean;
  readonly createdVia: 'synthetic-generator' | 'cli-recording';
  readonly initialGeometry: Geometry;
}

/**
 * Full snapshot of one cell. Values extracted from @xterm/headless IBufferCell; our core (E1) and
 * third reference must emit the same shape for cell-level diff.
 *
 * Color mode: raw fgMode/bgMode are xterm.js internal constants (default=0, palette-16≠palette-256≠RGB).
 * These raw constants are **not portable** (our core · third reference may not emit the same integers) —
 * kept in snapshot **for reference only** and **excluded from cross-subject diff** (see differ.ts
 * CELL_FIELDS: fgMode/bgMode not diffed). Portable mode is the 3 booleans (palette/rgb/default); our
 * core (E1) also emits this boolean shape (IBufferCell.isFgPalette/isFgRGB/isFgDefault).
 * Style flags (9): bold/italic/dim/underline/blink/inverse/invisible/strikethrough/overline.
 */
export interface CellSnapshot {
  readonly char: string; // getChars() — empty string means blank / trailing wide cell.
  readonly width: number; // getWidth() — 1(normal) · 2(wide) · 0(wide following spacer).
  readonly code: number; // getCode() — UTF32 codepoint (combining chars = last char).
  readonly fgMode: number; // getFgColorMode() raw constant — reference field (not diffed, not portable).
  readonly fg: number; // getFgColor() — palette index / 0xRRGGBB / default -1.
  readonly bgMode: number; // getBgColorMode() raw constant — reference field (not diffed, not portable).
  readonly bg: number;
  readonly fgPalette: boolean; // isFgPalette() — 16-color · 256-color palette.
  readonly fgRGB: boolean; // isFgRGB() — truecolor.
  readonly fgDefault: boolean; // isFgDefault().
  readonly bgPalette: boolean;
  readonly bgRGB: boolean;
  readonly bgDefault: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly dim: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
}

/** Cursor position. Buffer coordinates (0-based). */
export interface CursorSnapshot {
  readonly x: number;
  readonly y: number;
}

/**
 * Full grid snapshot. All cells of active buffer (normal|alt) in rows×cols plus cursor position.
 * rows[y][x] = cell snapshot. Unit of cross-subject diff.
 */
export interface GridSnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly activeBuffer: 'normal' | 'alternate';
  readonly cursor: CursorSnapshot;
  readonly cells: CellSnapshot[][]; // [y][x]
}

/**
 * One mismatch. Same coordinate · same field differs between two subjects (e.g. xterm.js vs our core).
 * classification reflects the 4-bucket ledger (§5-2) directly.
 */
export interface DiffEntry {
  readonly x: number;
  readonly y: number;
  readonly field: keyof CellSnapshot | 'cursor' | 'grid-shape' | 'activeBuffer';
  readonly a: unknown; // subject A value.
  readonly b: unknown; // subject B value.
  readonly classification: DiffClassification;
}

/**
 * 4-bucket ledger (§5-2). (d) intended improvements forbid implicit classification — only entries on
 * the explicit approval list (intended-diffs.json) are marked 'intended'. Unlisted mismatches stay
 * 'unclassified' for human judgment.
 */
export type DiffClassification =
  | 'our-bug' // (a) our core bug.
  | 'xterm-bug' // (b) xterm.js bug (internalization marketing material).
  | 'spec-ambiguous' // (c) spec ambiguity — third reference / DEC spec adjudication.
  | 'intended' // (d) intended improvement — approval list only.
  | 'unclassified'; // undecided (default — implicit (d) forbidden).

/**
 * Diff report. Two subject names · snapshot summary · mismatch list · throughput metrics.
 */
export interface DiffReport {
  readonly workloadName: string;
  readonly subjectA: string;
  readonly subjectB: string;
  readonly gridShape: Geometry;
  readonly totalCells: number;
  readonly mismatches: readonly DiffEntry[];
  readonly identical: boolean;
}

/**
 * Throughput metrics. xterm.js baseline numbers (§5-2 requirement). feed MB/s · full-cell extract time (ms).
 */
export interface ThroughputMetrics {
  readonly subject: string;
  readonly bytesTotal: number;
  readonly feedMs: number;
  readonly feedMBps: number;
  readonly extractMs: number;
  readonly cellCount: number;
}

/**
 * One entry on the (d) intended-improvement approval list. intended-diffs.json holds this array.
 * Only mismatches matching workload · coordinate · field are promoted to 'intended'.
 */
export interface IntendedDiff {
  readonly workloadName: string;
  readonly x: number;
  readonly y: number;
  readonly field: string;
  readonly reason: string; // Why this is intentional difference, not a bug (human-written).
}
