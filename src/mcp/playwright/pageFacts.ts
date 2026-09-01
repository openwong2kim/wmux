import type { Page } from 'playwright-core';
import { evaluateIsolated } from './isolated-eval';

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
 * Exported so a jsdom test can run the REAL source instead of a copy of it.
 */
export function buildPageFactsExpression(): string {
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
    // documentElement/body are excluded on purpose: the page itself scrolls on
    // nearly every long document, and counting it as an ancestor scroller
    // suppressed EVERY inner container (the list came back empty).
    if (el !== document.documentElement && el !== document.body && el.scrollHeight > el.clientHeight + 1) scrollerSet.add(el);
  }
  const cssPath = (el) => {
    // Build from the element upward, and STOP as soon as the accumulated path
    // matches exactly this element. A fixed-depth path can match a different
    // node entirely, which would send a scroll to the wrong container.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][-\\w]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
      } else {
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
      }
      const candidate = parts.join(' > ');
      try {
        const matches = document.querySelectorAll(candidate);
        if (matches.length === 1 && matches[0] === el) return candidate;
      } catch (e) { /* unusable selector — keep widening */ }
      node = node.parentElement;
    }
    // No selector uniquely identifies it; the caller omits the entry rather
    // than printing something that resolves elsewhere.
    return null;
  };
  for (const el of window0) {
    // The document itself is not a "container" worth listing: the page scroll
    // is what browser_scroll does by default.
    if (el === document.documentElement || el === document.body) continue;
    const tagName = el.tagName;
    let hasScrollableAncestor = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (scrollerSet.has(p)) { hasScrollableAncestor = true; break; }
    }
    let overflowY = 'visible';
    try { overflowY = getComputedStyle(el).overflowY || 'visible'; } catch (e) { /* detached */ }
    if (!isReportable({ tagName, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY, hasScrollableAncestor })) continue;
    if (scrollers.length >= ${MAX_SCROLLABLES}) { scrollablesTruncated = true; break; }
    const selector = cssPath(el);
    if (!selector) continue;
    const rect = el.getBoundingClientRect();
    scrollers.push({
      selector: selector,
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

/**
 * Upper bound on the facts collection. A snapshot must not hang on it: the
 * footer is an annotation, and a page busy enough to stall a DOM walk is
 * exactly the page an agent most needs the snapshot itself back from.
 */
export const PAGE_FACTS_TIMEOUT_MS = 300;

/** Collect the facts in ONE page round trip. Null on any failure (fail-open). */
export async function collectPageFacts(
  page: Page,
  timeoutMs = PAGE_FACTS_TIMEOUT_MS,
): Promise<PageFacts | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The evaluation keeps running in the page after a timeout — there is no
    // way to cancel it — but its promise is deliberately dropped, so attach a
    // catch to it here or an eventual rejection becomes an unhandled one.
    // Isolated world: reads only DOM/layout, which the isolated world shares.
    const evaluation = evaluateIsolated(page, buildPageFactsExpression());
    evaluation.catch(() => undefined);
    const raw = (await Promise.race([
      evaluation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ])) as PageFacts | null;
    if (!raw || typeof raw.totalElements !== 'number') return null;
    return raw;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the snapshot knows that the page-level measurements cannot.
 *
 * The facts themselves are still collected exactly as before — this only tells
 * the formatter how to read them.
 */
export interface PageFactsFooterOptions {
  /** The snapshot grafted iframe content that contributed at least one ref. */
  hasFrameContent?: boolean;
}

/** Interactive-element count below which a page reads as "not there yet". */
const NEARLY_EMPTY_INTERACTIVE = 10;
/**
 * ...but only when there is little text to read either. An article, a docs
 * page or a search result has almost no controls and is perfectly finished, so
 * the control count alone called every one of them "still loading".
 */
const NEARLY_EMPTY_TEXT_CHARS = 200;
/** Above this element count a low text density is worth calling out. */
const SKELETON_MIN_ELEMENTS = 20;
/** chars-per-element below which the DOM is mostly empty boxes. */
const SKELETON_TEXT_PER_ELEMENT = 5;

/**
 * The readiness note, or '' when the page looks normal.
 *
 * Mirrors browser-use agent/prompts.py:229-241.
 *
 * The skeleton verdict is GATED on `pendingRequests`, not merely strengthened
 * by it. Density alone does not separate "still painting" from "an application
 * UI", and measurement says the two sit on opposite sides of any threshold you
 * pick for the wrong reason: a finished GitHub pull-request list reads 0.78
 * chars per element while the Node docs read 8.39. Ungated, the note fired on
 * every app-shaped page — icons, nav, and chrome are elements without text —
 * and told the agent a fully rendered page was still loading.
 *
 * The cost of gating is that the builtin backend, which never attaches
 * pageCapture and so always reports zero in flight, no longer produces this
 * note at all. Saying nothing there is the better failure: the nearly-empty
 * verdict below still covers a genuinely blank page, and it does not depend on
 * request counts.
 */
export function describePageReadiness(
  facts: PageFacts,
  pendingRequests: number,
  options?: PageFactsFooterOptions,
): string {
  // Every count above is taken in the MAIN document, so a page whose content
  // lives in an iframe measures as empty however finished it is. That used to
  // be honest — frame contents were not in the snapshot either — and stopped
  // being so once they were grafted in: the tree would list a frame's controls
  // while the footer called the page nearly empty. The caller says when it
  // grafted frame content, and this defers to it.
  //
  // Only the nearly-empty verdict is suppressed. The skeleton verdict reads
  // element density rather than absolute counts, and a host document full of
  // empty boxes around a frame is still worth calling out.
  if (
    !options?.hasFrameContent &&
    facts.interactiveElements < NEARLY_EMPTY_INTERACTIVE &&
    facts.textChars < NEARLY_EMPTY_TEXT_CHARS
  ) {
    return pendingRequests > 0
      ? `nearly empty — ${pendingRequests} request(s) in flight, may still be loading`
      : 'nearly empty — may still be loading';
  }
  if (
    pendingRequests > 0 &&
    facts.totalElements > SKELETON_MIN_ELEMENTS &&
    facts.textChars < facts.totalElements * SKELETON_TEXT_PER_ELEMENT
  ) {
    return `skeleton screen likely — ${pendingRequests} request(s) in flight and little text rendered`;
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
  options?: PageFactsFooterOptions,
): string {
  const lines: string[] = [];
  const readiness = describePageReadiness(facts, pendingRequests, options);
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
