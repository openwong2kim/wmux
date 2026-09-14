// ---------------------------------------------------------------------------
// Ref boxes for a screenshot.
//
// `browser_screenshot { refs: true }` answers "which ref is that thing in the
// picture" without a second round trip. Nothing is drawn into the page: the
// boxes are measured fresh after the capture, from the refs the latest
// snapshot on that page minted, and printed as text beside the image.
//
// No box is stored anywhere a snapshot writes (RefEntry and IndexedElement
// carry none), and a stored one would be stale by the time a screenshot is
// taken anyway, so every row is a live boundingBox() read under one shared
// time budget.
// ---------------------------------------------------------------------------

import type { Page } from 'playwright-core';
import { listRefEntries, resolveRef } from './snapshot';
import { listSmartElementsOnPage, resolveSmartRefLocator } from './dom-intelligence';
import type { Box } from './pointer-path';

/** Total wall time for measuring every box. */
export const REF_BOX_BUDGET_MS = 1500;
/** Most refs measured per screenshot. */
export const REF_BOX_MEASURE_CAP = 150;
/** Most rows printed per screenshot. */
export const REF_BOX_ROW_CAP = 60;
/** Refs measured per batch, and the size of the first spread-out sample. */
const BATCH_SIZE = 50;
const NAME_MAX_CHARS = 60;

export interface RefBoxCandidate {
  /** The argument name the ref goes in: browser_snapshot `ref`, or `smartRef`. */
  param: 'ref' | 'smartRef';
  ref: number;
  role: string;
  name: string;
  /**
   * A fresh box in viewport CSS px, or null when the element has none. Must
   * stop waiting after `timeoutMs` and release anything it acquired.
   */
  measure: (timeoutMs: number) => Promise<Box | null>;
}

export const NO_SNAPSHOT_REFS_LINE =
  'No snapshot refs for this page yet — call browser_snapshot (or browser_smart_snapshot) first, then screenshot with refs:true.';

export const UNKNOWN_AREA_LINE =
  'The viewport size could not be read, so these boxes were not filtered to the capture.';

/**
 * Merge two document-ordered lists by relative position, so neither ref kind
 * crowds the other out of the measure cap and each keeps its own order.
 */
export function interleaveByPosition<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && (i + 0.5) / a.length <= (j + 0.5) / b.length)) {
      out.push(a[i++]);
    } else {
      out.push(b[j++]);
    }
  }
  return out;
}

/**
 * Every ref the latest snapshots minted on `page`, as measurable candidates:
 * browser_snapshot refs interleaved with smart refs when the smart snapshot
 * record belongs to this page.
 */
export function refBoxCandidates(page: Page): RefBoxCandidate[] {
  const refs: RefBoxCandidate[] = listRefEntries(page).map((entry) => ({
    param: 'ref',
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    // Frame refs resolve to their element too; an ElementHandle's box is in
    // main-frame viewport coordinates either way. The handle is disposed as
    // soon as its box is read — nothing else holds it.
    measure: async (timeoutMs) => {
      const handle = await resolveRef(page, String(entry.ref), { timeout: timeoutMs });
      if (!handle) return null;
      try {
        return await handle.boundingBox();
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    },
  }));
  const smart: RefBoxCandidate[] = listSmartElementsOnPage(page).map((element) => ({
    param: 'smartRef',
    ref: element.ref,
    role: element.role,
    name: element.name,
    // A Locator waits for its element by default; bound it by what is left of
    // the budget so an absent element cannot outlive the screenshot call.
    measure: async (timeoutMs) =>
      (await resolveSmartRefLocator(page, element.ref)).boundingBox({ timeout: timeoutMs }),
  }));
  return interleaveByPosition(refs, smart);
}

function intersects(box: Box, area: Box | null): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  if (!area) return true;
  return (
    box.x < area.x + area.width &&
    box.x + box.width > area.x &&
    box.y < area.y + area.height &&
    box.y + box.height > area.y
  );
}

/** Page-controlled text on one line, quoted, capped. */
function quotedName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const capped = flat.length > NAME_MAX_CHARS ? `${flat.slice(0, NAME_MAX_CHARS)}…` : flat;
  return ` "${capped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface RefBoxTableOptions {
  /** Added to each measured box before the intersection test and printing. */
  offset?: { x: number; y: number };
  budgetMs?: number;
  measureCap?: number;
  rowCap?: number;
  /** What the coordinates are, for the header line. */
  basis: string;
}

type Outcome = Box | null | 'timeout';
type Band = 'in' | 'before' | 'after' | 'unknown';

/**
 * The refs table: measure at most `measureCap` candidates under one
 * `budgetMs` budget, keep boxes intersecting `area` (every box when the area
 * is unknown), sort top-to-bottom then left-to-right, cut at `rowCap`, and say
 * in a trailer what was left out.
 *
 * Which candidates get measured matters on a long page: refs run in document
 * order, so the first 150 of 400 can all sit above a scrolled viewport. When
 * there are more candidates than the cap, a spread-out sample is measured
 * first and the rest of the cap goes to the stretches of the list next to the
 * captured area.
 */
export async function formatRefBoxTable(
  candidates: readonly RefBoxCandidate[],
  area: Box | null,
  options: RefBoxTableOptions,
): Promise<string> {
  if (candidates.length === 0) return NO_SNAPSHOT_REFS_LINE;
  const budgetMs = options.budgetMs ?? REF_BOX_BUDGET_MS;
  const measureCap = options.measureCap ?? REF_BOX_MEASURE_CAP;
  const rowCap = options.rowCap ?? REF_BOX_ROW_CAP;
  const offset = options.offset ?? { x: 0, y: 0 };
  const deadline = Date.now() + budgetMs;
  const outcomes = new Map<number, Outcome>();

  const boxAt = (outcome: Outcome | undefined): Box | null =>
    outcome && outcome !== 'timeout'
      ? { x: outcome.x + offset.x, y: outcome.y + offset.y, width: outcome.width, height: outcome.height }
      : null;

  // One batch in parallel. Once the budget is spent nothing more is started;
  // what a batch was still waiting on is abandoned and counted as timed out,
  // and each measurement stops on its own timeout.
  const measureBatch = async (indices: readonly number[]): Promise<void> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      for (const i of indices) outcomes.set(i, 'timeout');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remaining);
    });
    const results = await Promise.all(
      indices.map((i) =>
        Promise.race([candidates[i].measure(remaining).catch(() => null), expired]),
      ),
    );
    clearTimeout(timer);
    indices.forEach((i, k) => outcomes.set(i, results[k]));
  };

  const range = (from: number, to: number): number[] =>
    Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);

  if (candidates.length <= measureCap) {
    await measureBatch(range(0, candidates.length));
  } else {
    const stride = Math.ceil(candidates.length / Math.min(BATCH_SIZE, measureCap));
    const samples = range(0, Math.ceil(candidates.length / stride)).map((k) => k * stride);
    await measureBatch(samples);

    const band = (outcome: Outcome | undefined): Band => {
      const box = boxAt(outcome);
      if (!box) return 'unknown';
      if (!area) return 'in';
      if (box.y + box.height <= area.y) return 'before';
      if (box.y >= area.y + area.height) return 'after';
      return 'in';
    };
    // Rank each stretch between two samples: 0 = touches the area or spans
    // it, 1 = cannot tell, skipped = entirely above or below it.
    const gaps: { from: number; to: number; rank: number }[] = [];
    samples.forEach((start, k) => {
      const end = k + 1 < samples.length ? samples[k + 1] : candidates.length;
      if (start + 1 >= end) return;
      const a = band(outcomes.get(start));
      const b = k + 1 < samples.length ? band(outcomes.get(end)) : 'unknown';
      let rank: number | null = 1;
      if (a === 'in' || b === 'in' || (a === 'before' && b === 'after')) rank = 0;
      else if (a === 'after' || b === 'before') rank = null;
      if (rank !== null) gaps.push({ from: start + 1, to: end, rank });
    });
    gaps.sort((g, h) => g.rank - h.rank);
    const next = gaps
      .flatMap((gap) => range(gap.from, gap.to))
      .slice(0, measureCap - samples.length);
    for (let s = 0; s < next.length; s += BATCH_SIZE) {
      await measureBatch(next.slice(s, s + BATCH_SIZE));
    }
  }

  let timedOut = 0;
  let outside = 0;
  const rows: { candidate: RefBoxCandidate; box: Box }[] = [];
  for (const [i, outcome] of outcomes) {
    if (outcome === 'timeout') {
      timedOut++;
      continue;
    }
    const box = boxAt(outcome);
    if (!box || !intersects(box, area)) {
      outside++;
      continue;
    }
    rows.push({ candidate: candidates[i], box });
  }
  let cut = candidates.length - outcomes.size;

  rows.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (rows.length > rowCap) {
    cut += rows.length - rowCap;
    rows.length = rowCap;
  }

  const lines = [`Refs in this capture (${options.basis}: x,y,w,h):`];
  if (!area) lines.push(UNKNOWN_AREA_LINE);
  for (const { candidate, box } of rows) {
    lines.push(
      `${candidate.param}=${candidate.ref} ${candidate.role}${quotedName(candidate.name)} ` +
        `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`,
    );
  }
  if (rows.length === 0) lines.push('(none of the snapshot refs is inside the captured area)');
  if (timedOut + outside + cut > 0) {
    lines.push(
      `Not listed: ${timedOut} timed out, ${outside} outside the capture or without a box, ${cut} cut by the ${rowCap}-row / ${measureCap}-measure caps.`,
    );
  }
  return lines.join('\n');
}
