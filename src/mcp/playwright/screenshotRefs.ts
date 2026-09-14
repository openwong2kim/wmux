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
const NAME_MAX_CHARS = 60;

export interface RefBoxCandidate {
  /** The argument name the ref goes in: browser_snapshot `ref`, or `smartRef`. */
  param: 'ref' | 'smartRef';
  ref: number;
  role: string;
  name: string;
  /** A fresh box in viewport CSS px, or null when the element has none. */
  measure: () => Promise<Box | null>;
}

export const NO_SNAPSHOT_REFS_LINE =
  'No snapshot refs for this page yet — call browser_snapshot (or browser_smart_snapshot) first, then screenshot with refs:true.';

/**
 * Every ref the latest snapshots minted on `page`, as measurable candidates:
 * browser_snapshot refs first, then smart refs when the smart snapshot record
 * belongs to this page.
 */
export function refBoxCandidates(page: Page): RefBoxCandidate[] {
  const out: RefBoxCandidate[] = [];
  for (const entry of listRefEntries(page)) {
    out.push({
      param: 'ref',
      ref: entry.ref,
      role: entry.role,
      name: entry.name,
      // Frame refs resolve to their element too; an ElementHandle's box is in
      // main-frame viewport coordinates either way.
      measure: async () => (await resolveRef(page, String(entry.ref)))?.boundingBox() ?? null,
    });
  }
  for (const element of listSmartElementsOnPage(page)) {
    out.push({
      param: 'smartRef',
      ref: element.ref,
      role: element.role,
      name: element.name,
      // A Locator waits for its element by default; bound it by the budget so
      // an absent element cannot outlive the screenshot call.
      measure: async () =>
        (await resolveSmartRefLocator(page, element.ref)).boundingBox({ timeout: REF_BOX_BUDGET_MS }),
    });
  }
  return out;
}

function intersects(box: Box, area: Box): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
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
  return ` "${capped.replace(/"/g, '\\"')}"`;
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

/**
 * The refs table: measure at most `measureCap` candidates in parallel under
 * one `budgetMs` budget, keep boxes intersecting `area`, sort top-to-bottom
 * then left-to-right, cut at `rowCap`, and say in a trailer what was left out.
 */
export async function formatRefBoxTable(
  candidates: readonly RefBoxCandidate[],
  area: Box,
  options: RefBoxTableOptions,
): Promise<string> {
  if (candidates.length === 0) return NO_SNAPSHOT_REFS_LINE;
  const budgetMs = options.budgetMs ?? REF_BOX_BUDGET_MS;
  const measureCap = options.measureCap ?? REF_BOX_MEASURE_CAP;
  const rowCap = options.rowCap ?? REF_BOX_ROW_CAP;
  const offset = options.offset ?? { x: 0, y: 0 };

  const measured = candidates.slice(0, measureCap);
  let unmeasured = candidates.length - measured.length;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  const results = await Promise.all(
    measured.map((candidate) =>
      Promise.race([
        candidate.measure().catch(() => null),
        expired,
      ]),
    ),
  );
  clearTimeout(timer);

  let timedOut = 0;
  let outside = 0;
  const rows: { candidate: RefBoxCandidate; box: Box }[] = [];
  results.forEach((result, i) => {
    if (result === 'timeout') {
      timedOut++;
      return;
    }
    const box = result
      ? { x: result.x + offset.x, y: result.y + offset.y, width: result.width, height: result.height }
      : null;
    if (!box || !intersects(box, area)) {
      outside++;
      return;
    }
    rows.push({ candidate: measured[i], box });
  });

  rows.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (rows.length > rowCap) {
    unmeasured += rows.length - rowCap;
    rows.length = rowCap;
  }

  const lines = [`Refs in this capture (${options.basis}: x,y,w,h):`];
  for (const { candidate, box } of rows) {
    lines.push(
      `${candidate.param}=${candidate.ref} ${candidate.role}${quotedName(candidate.name)} ` +
        `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`,
    );
  }
  if (rows.length === 0) lines.push('(none of the snapshot refs is inside the captured area)');
  if (timedOut + outside + unmeasured > 0) {
    lines.push(
      `Not listed: ${timedOut} timed out, ${outside} outside the capture or without a box, ${unmeasured} cut by the ${rowCap}-row / ${measureCap}-measure caps.`,
    );
  }
  return lines.join('\n');
}
