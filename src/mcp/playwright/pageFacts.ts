import type { Page } from 'playwright-core';

// ---------------------------------------------------------------------------
// One-round-trip page facts for snapshot annotation.
//
// Mirrors browser-use's two separate ideas — the readiness heuristics of
// agent/prompts.py:_get_browser_state_description (page_stats) and the
// scrollable-container reporting of dom/views.py is_actually_scrollable /
// should_show_scroll_info — reimplemented as a SINGLE in-page evaluation so a
// snapshot pays one round trip, not three.
//
// Nothing here mints refs or mutates the DOM: the scrollable list is reported
// as CSS selectors in the snapshot footer. A node marker was rejected on
// purpose — a page eval cannot hand back a backendNodeId, and any attribute
// marker is stripped by the interactive-only filter and the overflow retry.
// ---------------------------------------------------------------------------

/** Bounds so a pathological page cannot turn a snapshot into a DOM crawl. */
export const PAGE_FACTS_LIMITS = {
  /** Elements visited by the scan; beyond this the walk stops. */
  MAX_SCAN_NODES: 5000,
  /** Scrollable containers reported in the footer. */
  MAX_SCROLLABLES: 20,
} as const;

export interface ScrollableInfo {
  /** CSS selector that re-finds the container from the document root. */
  selector: string;
  width: number;
  height: number;
  scrollHeight: number;
  /** iframes are always reported — see isReportableScrollable. */
  isIframe: boolean;
}

export interface PageFacts {
  totalElements: number;
  interactiveElements: number;
  textChars: number;
  scrollables: ScrollableInfo[];
  /** True when the walk hit MAX_SCAN_NODES, so the counts are lower bounds. */
  scanTruncated: boolean;
  /** True when more scrollers existed than MAX_SCROLLABLES. */
  scrollablesTruncated: boolean;
}

/**
 * Should this container appear in the footer list?
 *
 * Kept pure and self-contained so the same source runs in the page (via
 * String(), the redact.ts PASSWORD_FIELD_PREDICATE_JS idiom) and in unit tests.
 * Mirrors browser-use dom/views.py `is_actually_scrollable` (+1px rounding
 * guard, overflow restricted to auto/scroll/overlay) and `should_show_scroll_info`
 * (iframes always shown, nested scrollers suppressed).
 */
export function isReportableScrollable(box: {
  tagName: string;
  scrollHeight: number;
  clientHeight: number;
  overflowY: string;
  hasScrollableAncestor: boolean;
}): boolean {
  if (String(box.tagName).toLowerCase() === 'iframe') return true;
  if (box.hasScrollableAncestor) return false;
  if (!(box.scrollHeight > box.clientHeight + 1)) return false;
  const overflow = String(box.overflowY).toLowerCase();
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

const REPORTABLE_SCROLLABLE_JS = String(isReportableScrollable);

/**
 * The in-page collector, as source text. Built as a string (rather than a
 * passed function) so the same expression can run over either transport.
 */
function buildPageFactsExpression(): string {
  const { MAX_SCAN_NODES, MAX_SCROLLABLES } = PAGE_FACTS_LIMITS;
  return `(() => {
  const isReportable = ${REPORTABLE_SCROLLABLE_JS};
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="menuitem"],[onclick],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const all = document.querySelectorAll('*');
  const limit = Math.min(all.length, ${MAX_SCAN_NODES});
  const scanTruncated = all.length > ${MAX_SCAN_NODES};
  let interactiveElements = 0;
  const scrollers = [];
  let scrollablesTruncated = false;
  const scrollerSet = new Set();
  // First pass over the capped window: count interactive nodes and note which
  // elements scroll at all (the ancestor test below reads this set).
  const window0 = [];
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    window0.push(el);
    if (el.matches(INTERACTIVE)) interactiveElements++;
    if (el.scrollHeight > el.clientHeight + 1) scrollerSet.add(el);
  }
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][-\\w]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        return parts.join(' > ');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  for (const el of window0) {
    const tagName = el.tagName;
    let hasScrollableAncestor = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (scrollerSet.has(p)) { hasScrollableAncestor = true; break; }
    }
    let overflowY = 'visible';
    try { overflowY = getComputedStyle(el).overflowY || 'visible'; } catch (e) { /* detached */ }
    if (!isReportable({ tagName, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY, hasScrollableAncestor })) continue;
    if (scrollers.length >= ${MAX_SCROLLABLES}) { scrollablesTruncated = true; break; }
    const rect = el.getBoundingClientRect();
    scrollers.push({
      selector: cssPath(el),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      scrollHeight: el.scrollHeight,
      isIframe: tagName.toLowerCase() === 'iframe',
    });
  }
  const textChars = (document.body && document.body.innerText ? document.body.innerText : '').length;
  return {
    totalElements: all.length,
    interactiveElements: interactiveElements,
    textChars: textChars,
    scrollables: scrollers,
    scanTruncated: scanTruncated,
    scrollablesTruncated: scrollablesTruncated,
  };
})()`;
}

/** Collect the facts in ONE page round trip. Null on any failure (fail-open). */
export async function collectPageFacts(page: Page): Promise<PageFacts | null> {
  try {
    const raw = (await page.evaluate(buildPageFactsExpression())) as PageFacts | null;
    if (!raw || typeof raw.totalElements !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

/** Interactive-element count below which a page reads as "not there yet". */
const NEARLY_EMPTY_INTERACTIVE = 10;
/** Above this element count a low text density is worth calling out. */
const SKELETON_MIN_ELEMENTS = 20;
/** chars-per-element below which the DOM is mostly empty boxes. */
const SKELETON_TEXT_PER_ELEMENT = 5;

/**
 * The readiness note, or '' when the page looks normal.
 *
 * Mirrors browser-use agent/prompts.py:229-241, with one deliberate change:
 * `pendingRequests` only STRENGTHENS the skeleton verdict, never gates it. The
 * builtin backend does not attach pageCapture at all, so a pending-gated hint
 * would simply never fire there.
 */
export function describePageReadiness(
  facts: PageFacts,
  pendingRequests: number,
): string {
  if (facts.interactiveElements < NEARLY_EMPTY_INTERACTIVE) {
    return 'nearly empty — may still be loading';
  }
  if (
    facts.totalElements > SKELETON_MIN_ELEMENTS &&
    facts.textChars < facts.totalElements * SKELETON_TEXT_PER_ELEMENT
  ) {
    return pendingRequests > 0
      ? `skeleton screen likely — ${pendingRequests} request(s) in flight and little text rendered`
      : 'skeleton screen likely — little text rendered for this many elements';
  }
  return '';
}

/**
 * The full footer appended to a snapshot: readiness note + scrollable list.
 * Returns '' when there is nothing to say, so the snapshot is byte-identical
 * to before on an ordinary page.
 */
export function formatPageFactsFooter(
  facts: PageFacts,
  pendingRequests: number,
): string {
  const lines: string[] = [];
  const readiness = describePageReadiness(facts, pendingRequests);
  if (readiness) lines.push(`(page: ${readiness})`);
  if (facts.scrollables.length > 0) {
    lines.push('scrollable containers (scroll one with browser_evaluate, e.g.');
    lines.push("  document.querySelector('<selector>').scrollBy(0, 500)):");
    for (const s of facts.scrollables) {
      lines.push(
        `  ${s.selector} (${s.width}x${s.height}, scrollHeight ${s.scrollHeight}${s.isIframe ? ', iframe' : ''})`,
      );
    }
    if (facts.scrollablesTruncated) lines.push('  ... (more scrollable containers not listed)');
  }
  if (lines.length === 0) return '';
  return `\n${lines.join('\n')}`;
}
