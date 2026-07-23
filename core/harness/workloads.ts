// E0 conformance harness — six synthetic workloads (spec: engine-core-decision-2026-07-09.md §5-1)
//
// Determinism rule (§5-1): same script run twice must yield **identical bytes**. Workloads use
// no timestamps, PIDs, or system RNG (seeded PRNG only). Each workload pairs pure synthetic bytes,
// resize trail, and §5-2 ③ golden assertions ("script is the answer spec") beside the definition.
//
// Commit corpus — six cases (D4 — repo commits synthetic only):
//   ① scroll-flood      large scroll flood
//   ② resize-roundtrip  resize round-trip (80→79→80) — **non-reflow control** (40 chars, no wrap)
//   ②b resize-reflow    resize round-trip (80→79→80) — **reflow case that actually hits wrap** (120 chars, measured baseline frozen)
//   ③ alt-screen        alt-screen enter/exit
//   ④ cjk-emoji         CJK·emoji (ZWJ·VS16) width cases
//   ⑤ sgr-spectrum      SGR spectrum (16/256/truecolor·attribute flags)

import type { CellSnapshot, Geometry, GridSnapshot, RecordingEvent, ReflowMode } from './types';

/** SeededRng — same algorithm as mulberry32 in rig/harness/seed.ts (reposted here for harness self-sufficiency). */
export class SeededRng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
}

/** Golden assertion: workload receives grid snapshot and returns true/false verdict. */
export interface GoldenAssertion {
  /** Human-readable assertion name (what is correct). */
  readonly name: string;
  /** null if snapshot satisfies assertion, else failure reason string. */
  readonly check: (grid: GridSnapshot) => string | null;
}

/** Workload definition: name + pure synthetic bytes + resize trail + golden assertions (≥3). */
export interface Workload {
  readonly name: string;
  readonly initialGeometry: Geometry;
  readonly reflowMode: ReflowMode;
  /** Build deterministic byte stream from seed (non-deterministic output forbidden). */
  readonly build: (rng: SeededRng) => Uint8Array;
  /**
   * resize/reflow trail for recording.bin. byteOffset is absolute position in build() output.
   * init event is auto-prepended by recorder from initialGeometry/reflowMode — do not include here.
   */
  readonly trail: (bytes: Uint8Array) => RecordingEvent[];
  /** §5-2 ③ golden assertions (≥3 per corpus). Evaluated on final replay grid. */
  readonly golden: readonly GoldenAssertion[];
}

// ── ANSI helpers (synthetic — constants only) ──────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;
const enc = new TextEncoder();
function b(s: string): Uint8Array {
  return enc.encode(s);
}
/** Concatenate parts into one Uint8Array. */
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── Golden assertion helpers ──────────────────────────────────────────────────────
/** Extract row text (trailing whitespace trimmed). */
function rowText(grid: GridSnapshot, y: number): string {
  if (y < 0 || y >= grid.cells.length) return '';
  return grid.cells[y]
    .map((c: CellSnapshot) => (c.char === '' ? ' ' : c.char))
    .join('')
    .replace(/\s+$/, '');
}

// ── ① scroll-flood ────────────────────────────────────────────────────────
// 200 lines on 24-row screen forces scroll. Each line is deterministic number + repeat pattern.
// Last screen should show trailing 24 lines (scroll consistency).
const scrollFlood: Workload = {
  name: 'scroll-flood',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    const lines: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      // Deterministic body: line number + fixed fill (ASCII only for simple width math).
      const label = `line ${String(i).padStart(4, '0')}`;
      const fill = '.'.repeat(20);
      lines.push(b(`${label} ${fill}\r\n`));
    }
    return concat(lines);
  },
  trail: () => [],
  golden: [
    {
      name: 'bottom visible row is line 0199',
      check: (g) => {
        const last = rowText(g, g.rows - 1);
        // Cursor may be on new line after final newline — find last non-empty row from bottom.
        for (let y = g.rows - 1; y >= 0; y--) {
          const t = rowText(g, y);
          if (t.length > 0) {
            return t.startsWith('line 0199') ? null : `bottom text row is not line 0199: "${t}"`;
          }
        }
        return `screen is empty(last="${last}")`;
      },
    },
    {
      name: 'initial line (line 0000) scrolled off top of screen',
      check: (g) => {
        for (let y = 0; y < g.rows; y++) {
          if (rowText(g, y).startsWith('line 0000')) return `line 0000 still on screen(y=${y})`;
        }
        return null;
      },
    },
    {
      name: 'viewport matches initial geometry (80×24)',
      check: (g) => (g.cols === 80 && g.rows === 24 ? null : `geometry mismatch: ${g.cols}×${g.rows}`),
    },
  ],
};

// ── ② resize-roundtrip (non-reflow control) ────────────────────────────────────
// **Honesty (R2 ①): this workload is a control that does NOT hit reflow path.** 40-char mark does not
// wrap at shrunk width 79 (fits single row), so 80→79→80 round-trip never runs xterm.js rewrap logic.
// This case verifies NOT "reflow idempotency" but "resize round-trip leaves content unchanged when
// there is no wrap" — baseline control. Actual wrap/reflow path is covered by resize-reflow below
// (120+ char mark). Control kept so reflow vs non-reflow behavior can be compared side by side.
const RESIZE_MARK = 'ABCDEFGHIJ'.repeat(4); // 40 chars — no wrap at 79 cols (control).
const resizeRoundtrip: Workload = {
  name: 'resize-roundtrip',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    // Home → write 40-char mark.
    return concat([b(`${CSI}H`), b(RESIZE_MARK)]);
  },
  trail: (bytes) => {
    const end = bytes.length;
    // After all bytes fed, resize round-trip (80→79→80). Same offset(end), applied in order (stable sort preserved).
    return [
      { type: 'resize', byteOffset: end, geometry: { cols: 79, rows: 24 } },
      { type: 'resize', byteOffset: end, geometry: { cols: 80, rows: 24 } },
    ];
  },
  golden: [
    {
      name: 'non-reflow control: after 80→79→80 round trip first row is unchanged 40-char mark (no wrap, content invariant)',
      check: (g) => {
        const t = rowText(g, 0);
        return t === RESIZE_MARK ? null : `first row restore failed: "${t}" (len=${t.length})`;
      },
    },
    {
      name: 'column count restored to 80 after round trip',
      check: (g) => (g.cols === 80 ? null : `cols=${g.cols} (expected 80)`),
    },
    {
      name: 'second row is empty (40 chars do not wrap — no fold residue, control trait)',
      check: (g) => {
        const t = rowText(g, 1);
        return t === '' ? null : `residue on second row: "${t}"`;
      },
    },
  ],
};

// ── ②b resize-reflow (new — reflow case that actually hits wrap) ─────────────────
// **R2: actually verifies reflow path.** 120-char continuous mark from home at 80 cols yields
// wrapped 2 rows from start (row0 80 full + row1 40). Then 80→79→80 round-trip.
//
// **Golden freezes xterm.js U11 measured deterministic state, not "ideal restoration after round-trip"** (R2 ②).
// Local measurement (2026-07-09, @xterm/headless 6 + Unicode11Addon activeVersion='11'):
//   - Right after 80-col write: row0=80 full, row1=40, cursor (40,1).
//   - After 80→79→80 round-trip (frozen baseline): row0=**79 chars** (col79 empty — last 'J' not
//     restored at wrap boundary), row1=40 unchanged, cursor (40,1). Only **119 of 120** original chars remain.
//   - Round-trip determinism: same (gate① determinism holds — but not "ideal restoration").
// This 79-char remnant is xterm.js reflow not fully restoring wrap-pending cells on round-trip;
// ideal reflow idempotency (full 120-char restore) is **E1 core (d) intended improvement target**
// reserved in intended-diffs.json (R4). This workload's golden freezes the measured baseline for
// that reservation — not claiming xterm.js behavior as "the answer".
const REFLOW_MARK = 'ABCDEFGHIJ'.repeat(12); // 120 chars — wrapped 2 rows from start at 80 cols.
// Measured row0 after round-trip (79 chars): first 79 of 120-char mark (col0..78). Period 10 → col78 = 'I' (78 % 10 = 8).
const REFLOW_ROW0_AFTER = REFLOW_MARK.slice(0, 79);
// Measured row1 after round-trip (40 chars): mark 80..119 (original row1 40 chars unchanged).
const REFLOW_ROW1_AFTER = REFLOW_MARK.slice(80, 120);
const resizeReflow: Workload = {
  name: 'resize-reflow',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    // Home → 120-char continuous mark (wrapped 2 rows from start).
    return concat([b(`${CSI}H`), b(REFLOW_MARK)]);
  },
  trail: (bytes) => {
    const end = bytes.length;
    // After all bytes fed, resize round-trip (80→79→80). Wrap present — hits actual rewrap path.
    return [
      { type: 'resize', byteOffset: end, geometry: { cols: 79, rows: 24 } },
      { type: 'resize', byteOffset: end, geometry: { cols: 80, rows: 24 } },
    ];
  },
  golden: [
    {
      name: 'column count restored to 80 after round trip',
      check: (g) => (g.cols === 80 ? null : `cols=${g.cols} (expected 80)`),
    },
    {
      name: 'measured freeze: after round trip row0 is 79 chars (wrap-boundary cell not restored — xterm.js U11 observed state)',
      check: (g) => {
        const t = rowText(g, 0);
        return t === REFLOW_ROW0_AFTER
          ? null
          : `row0 measured mismatch: "${t}" (len=${t.length}, expected len=79)`;
      },
    },
    {
      name: 'measured freeze: after round trip row1 retains original trailing 40 chars',
      check: (g) => {
        const t = rowText(g, 1);
        return t === REFLOW_ROW1_AFTER
          ? null
          : `row1 measured mismatch: "${t}" (len=${t.length}, expected len=40)`;
      },
    },
    {
      name: 'measured freeze: after round trip wrap-boundary col79 cell is empty (last J not restored — reflow non-idempotency evidence)',
      check: (g) => {
        const c79 = g.cells[0]?.[79];
        if (!c79) return 'row0 col79 cell missing';
        // Original would be col79 = 'J' (120-char mark index 79 = 'J', 79 % 10 = 9). Measured: empty cell.
        return c79.char === '' ? null : `col79 char="${c79.char}" (measured expected: empty cell — J not restored)`;
      },
    },
  ],
};

// ── ③ alt-screen ────────────────────────────────────────────────────────────
// Text in normal buffer → alt-screen enter (1049h) → different text in alt → exit (1049l).
// After exit, normal buffer text must be restored.
const altScreen: Workload = {
  name: 'alt-screen',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    return concat([
      b(`${CSI}H`),
      b('NORMAL-BUFFER-LINE'),
      b(`${CSI}?1049h`), // alt-screen enter.
      b(`${CSI}H`),
      b('ALT-BUFFER-LINE'),
      b(`${CSI}?1049l`), // alt-screen exit → normal restored.
    ]);
  },
  trail: () => [],
  golden: [
    {
      name: 'active buffer is normal after exit',
      check: (g) => (g.activeBuffer === 'normal' ? null : `active buffer=${g.activeBuffer}`),
    },
    {
      name: 'normal buffer first row restored after exit(NORMAL-BUFFER-LINE)',
      check: (g) => {
        const t = rowText(g, 0);
        return t === 'NORMAL-BUFFER-LINE' ? null : `normal first row not restored: "${t}"`;
      },
    },
    {
      name: 'alt text (ALT-BUFFER-LINE) absent from screen after exit',
      check: (g) => {
        for (let y = 0; y < g.rows; y++) {
          if (rowText(g, y).includes('ALT-BUFFER-LINE')) return `alt text remains(y=${y})`;
        }
        return null;
      },
    },
  ],
};

// ── ④ cjk-emoji ──────────────────────────────────────────────────────────────
// CJK width-2·range emoji width-2·VS16 width case·ZWJ sequence. Each wide glyph followed by width-0 spacer cell.
//
// Golden uses xterm.js **U11 baseline observed behavior** as canonical (not human ideal width).
// Measurement basis:
//   - CJK U+AC00 (Hangul syllable) → width 2 + spacer w0 (U11 answer clear).
//   - Range emoji U+1F600(😀) → width 2 + spacer w0 (codepoint is Emoji_Presentation).
//   - U+2764+VS16(❤️) → **width 1** in xterm.js U11. VS16 emoji-presentation width promotion not
//     reflected in U11 table. This cell is concrete seed for our core (E1, U16+grapheme) (d) intended
//     width-2 improvement; intended-diffs.json will list (cjk-emoji, VS16 coord, width) then.
const CJK = '한글'; // Each char width 2.
const EMOJI_RANGE = '\u{1F600}'; // 😀 — codepoint itself width 2.
const EMOJI_VS16 = '❤️'; // ❤️ heart + VS16 → xterm U11 baseline width 1 (observed).
const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 👨‍👩‍👧 ZWJ family.
const cjkEmoji: Workload = {
  name: 'cjk-emoji',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    return concat([
      b(`${CSI}H`),
      b(CJK), // row0: Hangul (cell 0=U+AC00 w2, cell1='' w0, cell2=U+AE00 w2, cell3='' w0).
      b('\r\n'),
      b(EMOJI_RANGE), // row1: 😀 (cell0 w2, cell1 w0).
      b('\r\n'),
      b(EMOJI_VS16), // row2: ❤️ (U11 baseline cell0 w1).
      b('\r\n'),
      b(`X${ZWJ_FAMILY}Y`), // row3: X + ZWJ family + Y.
    ]);
  },
  trail: () => [],
  golden: [
    {
      name: 'first CJK char (한) has width 2, next cell is width-0 spacer',
      check: (g) => {
        const c0 = g.cells[0]?.[0];
        const c1 = g.cells[0]?.[1];
        if (!c0 || !c1) return 'row0 cells missing';
        if (c0.width !== 2) return `cell0 width=${c0.width} (expected 2), char="${c0.char}"`;
        if (c1.width !== 0) return `cell1 (spacer) width=${c1.width} (expected 0)`;
        return c0.char === '한' ? null : `cell0 char="${c0.char}" (expected 한)`;
      },
    },
    {
      name: 'wide spacer pair alignment: two 한글 chars → 4 cells (w2,w0,w2,w0)',
      check: (g) => {
        const w = [0, 1, 2, 3].map((x) => g.cells[0]?.[x]?.width);
        return w[0] === 2 && w[1] === 0 && w[2] === 2 && w[3] === 0
          ? null
          : `width column=${JSON.stringify(w)} (expected [2,0,2,0])`;
      },
    },
    {
      name: 'range emoji (😀) is width 2 + width-0 spacer (U11 answer)',
      check: (g) => {
        const c0 = g.cells[1]?.[0];
        const c1 = g.cells[1]?.[1];
        if (!c0 || !c1) return 'row1 cells missing';
        if (c0.width !== 2) return `emoji width=${c0.width} (expected 2), char="${c0.char}"`;
        return c1.width === 0 ? null : `spacer width=${c1.width} (expected 0)`;
      },
    },
    {
      name: 'VS16 heart (❤️) is width 1 in xterm.js U11 baseline (VS16 promotion not applied — (d) improvement seed)',
      check: (g) => {
        const c0 = g.cells[2]?.[0];
        if (!c0) return 'row2 cells missing';
        // Baseline canonical: width 1 in U11. If our core goes width 2, approve via intended-diff then.
        return c0.width === 1 ? null : `VS16 heart width=${c0.width} (U11 baseline expected 1)`;
      },
    },
    {
      name: 'ZWJ family flanked by ASCII (X…Y) alignment — X at row3 cell0',
      check: (g) => {
        const c0 = g.cells[3]?.[0];
        if (!c0) return 'row3 cells missing';
        return c0.char === 'X' && c0.width === 1 ? null : `row3 cell0="${c0.char}" w=${c0.width}`;
      },
    },
  ],
};

// ── ⑤ sgr-spectrum ────────────────────────────────────────────────────────────
// 16-color·256-color·truecolor·attribute flags. Each cell's color mode/value/flags must match.
const sgrSpectrum: Workload = {
  name: 'sgr-spectrum',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    return concat([
      b(`${CSI}H`),
      // row0: 16-color — red foreground (31), then blue background (44).
      b(`${CSI}31mR${CSI}0m`),
      b(`${CSI}44mB${CSI}0m`),
      b('\r\n'),
      // row1: 256-color palette — foreground 196 (bright red).
      b(`${CSI}38;5;196mP${CSI}0m`),
      b('\r\n'),
      // row2: truecolor — foreground RGB(0x123456).
      b(`${CSI}38;2;18;52;86mT${CSI}0m`),
      b('\r\n'),
      // row3: attribute flags — bold+underline+italic.
      b(`${CSI}1;3;4mA${CSI}0m`),
    ]);
  },
  trail: () => [],
  golden: [
    {
      name: '16-color: row0 cell0 (R) has palette foreground color 1 (red)',
      check: (g) => {
        const c = g.cells[0]?.[0];
        if (!c) return 'row0 cell0 missing';
        if (!c.fgPalette) return `not palette foreground(fgPalette=${c.fgPalette})`;
        return c.fg === 1 ? null : `fg=${c.fg} (expected 1)`;
      },
    },
    {
      name: '256-color: row1 cell0 (P) has palette foreground 196',
      check: (g) => {
        const c = g.cells[1]?.[0];
        if (!c) return 'row1 cell0 missing';
        if (!c.fgPalette) return `not palette foreground(fgPalette=${c.fgPalette})`;
        return c.fg === 196 ? null : `fg=${c.fg} (expected 196)`;
      },
    },
    {
      name: 'truecolor: row2 cell0 (T) is RGB 0x123456',
      check: (g) => {
        const c = g.cells[2]?.[0];
        if (!c) return 'row2 cell0 missing';
        if (!c.fgRGB) return `not RGB foreground(fgRGB=${c.fgRGB})`;
        return c.fg === 0x123456 ? null : `fg=0x${c.fg.toString(16)} (expected 0x123456)`;
      },
    },
    {
      name: 'attribute flags: row3 cell0 (A) is bold+italic+underline',
      check: (g) => {
        const c = g.cells[3]?.[0];
        if (!c) return 'row3 cell0 missing';
        if (!c.bold) return 'bold not set';
        if (!c.italic) return 'italic not set';
        if (!c.underline) return 'underline not set';
        return null;
      },
    },
  ],
};

/** Commit corpus — six workloads (D4 — repo commits synthetic only). */
export const WORKLOADS: readonly Workload[] = [
  scrollFlood,
  resizeRoundtrip,
  resizeReflow,
  altScreen,
  cjkEmoji,
  sgrSpectrum,
];

/** Look up workload by name. */
export function workloadByName(name: string): Workload | undefined {
  return WORKLOADS.find((w) => w.name === name);
}
