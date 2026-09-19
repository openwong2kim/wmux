/**
 * "Is there a menu behind this nav item?" for browser_snapshot.
 *
 * A snapshot lists `link "Products"` and nothing under it, because the
 * submenu the site puts there only exists while the pointer is on the link:
 * a `:hover` rule flips a panel from `display:none`, or a framework mounts it
 * on `mouseenter`. The tree is telling the truth about the page as it stands,
 * and the agent reads it as "this site has no Products menu" — then goes
 * looking for a search box, or reports the feature missing. Mega-menus, avatar
 * / account menus and "more" (…) buttons are all this same shape, and
 * snapshot.ts had no notion of them at all.
 *
 * Two phases, because the cheap one is the one worth always paying for:
 *
 *   Phase 1 reads the page's OWN stylesheets and ARIA and marks the triggers
 *   it can prove are triggers (`has-submenu`). It never touches the page — no
 *   pointer, no DOM write — so it is on for every snapshot.
 *
 *   Phase 2 (`probeHover:true`) actually hovers the top few and lists what
 *   appeared. That moves the real pointer, so it is opt-in, hard-bounded, and
 *   restores the pointer afterwards.
 *
 * Precision is the constraint, same as occlusion.ts: a missing marker leaves
 * the agent exactly where it is today, a WRONG marker sends it hovering a
 * plain link and waiting for a menu that was never there. So every bound here
 * fails open — a stylesheet that throws, a scan that runs out of time, a
 * selector that will not parse, all produce "nothing to say" rather than a
 * guess — and the scorer needs corroboration (a CSS rule, an ARIA promise, a
 * native disclosure) before anything is marked.
 *
 * Mechanism credit: hover-revealed submenu detection was observed in
 * Tencent/BrowserSkill (MIT), referenced as prior art. No code copied.
 */

import {
  clickPointInBox,
  defaultStartPoint,
  pathPoints,
  type Box,
  type Point,
} from '../../shared/pointerPath';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Bounds on the always-on phase-1 scan.
 *
 * The rule budget and the wall clock are BOTH needed: a design-system page
 * ships tens of thousands of rules that are individually cheap, and a page
 * with a handful of rules can still hand each of them a selector that costs a
 * full-document `querySelectorAll`. Whichever runs out first stops the scan,
 * and a stopped scan reports the triggers it already found — never a partial
 * verdict dressed up as a complete one, since the marker's meaning ("there is
 * a menu here") does not depend on having seen every rule.
 */
export const HOVER_SCAN_LIMITS = {
  /** Style rules examined per scan, across all sheets and nested groups. */
  MAX_CSS_RULES: 4000,
  /** Wall-clock budget for the in-page scan. */
  SCAN_BUDGET_MS: 60,
  /** Triggers whose handles are kept for phase 2 / marked in the tree. */
  MAX_TRACKED_TRIGGERS: 24,
  /**
   * Upper bound on the WHOLE collection, round trips included. The in-page
   * budget above covers the scan; this covers the evaluate + getProperties +
   * describeNode chain that turns its handles into backendNodeIds, which is
   * what a slow-but-alive renderer actually stalls on (occlusion.ts's lesson).
   *
   * Generous on purpose. This is the ALWAYS-ON path, and expiring here does not
   * degrade the snapshot gracefully — it removes every marker from it, silently.
   * 800 ms was enough on a warm developer machine and not on a loaded CI runner,
   * where the whole suite came back with zero candidates and no way to tell that
   * from a page with no hover menus (CI, 2026-09-18). The in-page scan is still
   * capped at SCAN_BUDGET_MS, so this buys tolerance for slow round trips, not
   * for slow pages.
   */
  COLLECT_BUDGET_MS: 2500,
  /** Cleanup gets its own budget so a used-up collection still releases. */
  CLEANUP_BUDGET_MS: 500,
} as const;

/** Bounds on the opt-in phase-2 probe. */
export const HOVER_PROBE_LIMITS = {
  /** Triggers hovered, highest-scoring first. */
  MAX_TRIGGERS: 6,
  /**
   * Wall-clock ceiling on the WHOLE probe — every trigger, every settle wait,
   * every restore and every close check inside it.
   *
   * It used to bound only the per-trigger reads, with the restore and the close
   * check given budgets of their own on top; measured live that came to 5.2 s
   * for two triggers against a promise of ~2.5 s, and the overrun ate the second
   * trigger's turn so its menu was never listed at all (dogfood, 2026-09-18).
   * The only thing allowed past this line now is RESTORE_GRACE_MS.
   *
   * 2.5 s was a number this module invented, and measurement says the shipped
   * lane cannot keep it. What a probe costs is set by the renderer, not by this
   * code: on a 1500-element page in a HEADED window that is not the focused one
   * — which is what wmux's chrome backend drives — the first `before` alone is
   * ~1.0 s, because it forces the layout that a throttled compositor has not
   * done yet, and each `Input.dispatchMouseEvent` is ~107 ms against ~30 ms
   * headless. Two triggers measured ~3.0 s. Rather than keep a promise the code
   * misses (and silently drop the second menu), the ceiling is the number the
   * measured worst case needs, and `browser_snapshot`'s description says it.
   */
  TOTAL_BUDGET_MS: 4700,
  /** How long one trigger is given to reveal something. */
  REVEAL_WAIT_MS: 300,
  /** How often the reveal is re-checked inside that wait. */
  REVEAL_POLL_MS: 60,
  /**
   * How long the surface is given to close again once the pointer has left.
   * The mirror of REVEAL_WAIT_MS, and needed for the same reason: a panel with
   * `transition: opacity .2s` still has a box the instant the pointer moves,
   * and checking immediately reported every transitioned menu as stuck open.
   */
  CLOSE_WAIT_MS: 300,
  /**
   * The ONLY thing allowed past TOTAL_BUDGET_MS, and only for taking the pointer
   * off the page: a probe that spent every millisecond it had still has to
   * un-hover, because leaving a menu open changes what every later snapshot and
   * click on that page sees. Same split as occlusion.ts's CLEANUP_BUDGET_MS, and
   * the two together are the number the tool description promises.
   */
  RESTORE_GRACE_MS: 300,
  /**
   * Intermediate points on the approach to a trigger.
   *
   * `stepsForDistance` asks for 8–25, which is right for a click: the jittered
   * path is what keeps one separable from a synthetic one. A probe pays that per
   * point in CDP round trips, and one `Input.dispatchMouseEvent` costs about
   * 100 ms in a HEADED window that is not the focused one — measured on Chrome
   * 153, against ~15 ms headless, with the first move of a run paying ~370 ms of
   * compositor wake-up on top. At 8–25 points per move that is the whole probe
   * budget for one trigger, which is why the shipped headed lane listed the
   * account menu and never reached the nav submenu below it.
   */
  POINTER_STEPS: 4,
  /**
   * Points on a move that is not an approach.
   *
   * Two moves per trigger are not interactions and do not need a click's path:
   * the hop back onto a trigger after parking (the intruder is already closed —
   * only the arrival matters) and the park itself, which is a DEPARTURE. Halving
   * those is ~200 ms per trigger back in a headed window.
   */
  DEPARTURE_STEPS: 2,
  /** Accessible names listed per trigger. */
  MAX_ITEMS: 12,
} as const;

/**
 * Score at or above which a candidate is marked.
 *
 * 2 is "one strong signal, or two weak ones": a `:hover` rule that reveals
 * another element, an `aria-haspopup`, a `<summary>`, or a named-like
 * (`.dropdown-toggle`) element that is also `cursor:pointer`. An
 * `aria-expanded` alone does not reach it — plenty of accordions and toggle
 * buttons carry one and reveal nothing menu-shaped.
 */
export const HOVER_TRIGGER_SCORE_THRESHOLD = 2;

/**
 * Names that suggest a popup opener, matched against class / id /
 * data-testid / aria-label. Corroboration only — worth one point, never
 * enough on its own (see HOVER_TRIGGER_SCORE_THRESHOLD).
 */
export const HOVER_TRIGGER_NAME_HINT =
  /(menu|dropdown|popover|popup|avatar|profile|account|more|ellipsis|caret)/i;

/** The marker a phase-1 trigger earns in the a11y lane. */
export const HAS_SUBMENU_MARKER = 'has-submenu';

/** The same marker, as the DOM interactive listing spells it. */
export const HAS_SUBMENU_DOM_MARKER = ' [has-submenu]';

// ---------------------------------------------------------------------------
// Pure rules — shared with the page
// ---------------------------------------------------------------------------
//
// The functions below are deliberately self-contained: no imports, no module
// closure, no shared helpers. Each one is stringified into a page script, so a
// free identifier would resolve to nothing in the page (and the bundler is
// free to rename it on this side). Everything a function needs is declared
// inside it. Same rule, and the same reason, as redact.ts's
// PASSWORD_FIELD_PREDICATE_JS and pageFacts.ts's isReportableScrollable.

/**
 * Has the scan used up either half of its budget?
 *
 * Its own function so the bound is pinned by a unit test rather than only
 * observable against a live page, and so the page and this side cannot
 * disagree about where the line is.
 */
export function scanBudgetExhausted(rulesSeen: number, elapsedMs: number): boolean {
  return rulesSeen >= 4000 || elapsedMs >= 60;
}

/** One `:hover` rule, split into who is hovered and what that reveals. */
export interface HoverRuleMatch {
  /** Selector for the element the pointer has to be on. */
  trigger: string;
  /**
   * The combinator between them — `' '`, `'>'`, `'+'` or `'~'`.
   *
   * Carried because it is what ties a revealed element back to ITS OWN trigger:
   * the hovered selector alone matches every `li` in a nav, and only the one
   * that is the submenu's parent is a trigger (hoverTriggerForRevealed).
   */
  combinator: string;
  /** Selector for what the rule then shows — the whole rule minus `:hover`. */
  target: string;
}

/**
 * Does this style rule reveal a DIFFERENT element on hover, and if so, which
 * element has to be hovered?
 *
 * `.nav li:hover > .submenu { display: block }` is the shape that matters:
 * a `:hover` on one element changing a property that can hide or show
 * ANOTHER. Three things have to hold, and each one is a precision guard:
 *
 *   1. A revealing property is set. `a:hover { color: red }` is a hover rule
 *      about nothing an agent can act on.
 *   2. A combinator follows the `:hover`. `button:hover { opacity: 1 }`
 *      restyles the hovered element itself — there is no submenu.
 *   3. The `:hover` is at the top level of the selector. Inside `:not(...)` or
 *      `:has(...)` it describes a condition, not the element being hovered,
 *      and treating it as one would mark whatever the enclosing selector
 *      happened to match.
 *
 * Returns one match per comma-separated part that qualifies, and an empty
 * array for everything else — including anything it cannot parse confidently.
 */
export function classifyHoverRule(
  selectorText: string,
  declaredProperties: readonly string[],
): HoverRuleMatch[] {
  const HOVER = ':hover';
  const REVEAL = [
    'display',
    'visibility',
    'opacity',
    'max-height',
    'height',
    'transform',
    'pointer-events',
    'clip',
    'clip-path',
  ];
  /** Page-authored selector text; a pathological one is not worth running. */
  const MAX_SELECTOR_CHARS = 200;

  const text = typeof selectorText === 'string' ? selectorText : '';
  if (text.length === 0) return [];

  // ASCII-only lowercase, character for character, so an index into the
  // lowered copy is an index into the original. `toLowerCase()` is not
  // length-preserving for every input, and these are page-authored strings.
  const lowerAscii = (s: string): string => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s.charAt(i);
    }
    return out;
  };

  // Pseudo-classes and property names are both ASCII case-insensitive, and
  // `cssRules` hands back whatever the author wrote on some engines.
  if (lowerAscii(text).indexOf(HOVER) < 0) return [];

  let reveals = false;
  const props = declaredProperties || [];
  for (let i = 0; i < props.length; i++) {
    if (REVEAL.indexOf(lowerAscii(String(props[i]))) >= 0) {
      reveals = true;
      break;
    }
  }
  if (!reveals) return [];

  /**
   * Nesting depth per character: anything inside `(...)`, `[...]` or a quoted
   * string is above depth 0. The brackets themselves sit at the outer depth,
   * so a `~` in `[a~="b"]` never reads as a sibling combinator.
   */
  const depthsOf = (s: string): number[] => {
    const depths: number[] = [];
    let depth = 0;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (quote !== '') {
        depths.push(depth + 1);
        if (ch === quote && s.charAt(i - 1) !== '\\') quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        depths.push(depth + 1);
        continue;
      }
      if (ch === '(' || ch === '[') {
        depths.push(depth);
        depth += 1;
        continue;
      }
      if (ch === ')' || ch === ']') {
        depth = depth > 0 ? depth - 1 : 0;
        depths.push(depth);
        continue;
      }
      depths.push(depth);
    }
    return depths;
  };

  const classifyPart = (rawPart: string): HoverRuleMatch | null => {
    const part = rawPart.trim();
    if (part.length === 0 || part.length > MAX_SELECTOR_CHARS) return null;
    const lower = lowerAscii(part);
    const depths = depthsOf(part);

    // Top-level `:hover` occurrences, in order.
    const hits: number[] = [];
    for (let i = lower.indexOf(HOVER); i >= 0; i = lower.indexOf(HOVER, i + 1)) {
      if (depths[i] !== 0) continue;
      // `::hover` is not a thing, and `:hover-card` / `:hovered` are other
      // pseudo-classes entirely.
      if (i > 0 && part.charAt(i - 1) === ':') continue;
      const after = lower.charAt(i + HOVER.length);
      if (after !== '' && /[a-z0-9_-]/.test(after)) continue;
      hits.push(i);
    }
    if (hits.length === 0) return null;

    // The LAST top-level `:hover` is the one a combinator has to follow: in
    // `.a:hover .b:hover .c` the revealed element hangs off `.b`.
    const last = hits[hits.length - 1];
    const afterHover = last + HOVER.length;
    let combinator = -1;
    for (let i = afterHover; i < part.length; i++) {
      if (depths[i] !== 0) continue;
      const ch = part.charAt(i);
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~') {
        combinator = i;
        break;
      }
    }
    // No combinator: the rule restyles the hovered element itself.
    if (combinator < 0) return null;
    const joint = part.slice(combinator).replace(/^\s+/, '');
    // Whitespace around an explicit combinator is not itself the combinator:
    // `.a:hover > .b` reveals a CHILD, and reading the space as a descendant
    // relation would look for the panel in the wrong place.
    const kind = joint.charAt(0);
    const sign = kind === '>' || kind === '+' || kind === '~' ? kind : ' ';
    const revealed = part.slice(combinator).replace(/^[\s>+~]+/, '');
    if (revealed.length === 0) return null;

    /** The same text with every top-level `:hover` cut out of it. */
    const withoutHover = (upTo: number): string => {
      let out = '';
      let cursor = 0;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i] >= upTo) break;
        out += part.slice(cursor, hits[i]);
        cursor = hits[i] + HOVER.length;
      }
      return (out + part.slice(cursor, upTo)).trim();
    };

    const trigger = withoutHover(combinator);
    const target = withoutHover(part.length);
    // A bare `:hover .menu` names no element to hover, and `.a > :hover .menu`
    // leaves a dangling combinator. A pseudo-ELEMENT cannot be hovered at all.
    if (trigger.length === 0 || /[>+~]$/.test(trigger) || trigger.indexOf('::') >= 0) return null;
    if (target.length === 0) return null;
    return { trigger: trigger, combinator: sign, target: target };
  };

  // Split the selector list on top-level commas only — a comma inside
  // `:is(a, b)` does not start a new selector.
  const listDepths = depthsOf(text);
  const out: HoverRuleMatch[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !(text.charAt(i) === ',' && listDepths[i] === 0)) continue;
    const match = classifyPart(text.slice(start, i));
    if (match) out.push(match);
    start = i + 1;
  }
  return out;
}

/** What a candidate element is, as far as the exclusion rules care. */
export interface HoverTriggerElementFacts {
  tagName: string;
  disabled: boolean;
  ariaDisabled: boolean;
  inert: boolean;
  contentEditable: boolean;
}

/**
 * May this element be marked at all?
 *
 * A form field is never a submenu trigger — a `<select>` DOES open a popup,
 * but it is the browser's own, `browser_select` already drives it, and
 * `has-submenu` on a text input would be nonsense. A disabled or `inert`
 * element opens nothing whatever its stylesheet says, and marking it would
 * send the agent hovering something that cannot respond.
 */
export function isHoverTriggerEligible(el: HoverTriggerElementFacts): boolean {
  const tag = String(el.tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') return false;
  return !(el.disabled || el.ariaDisabled || el.inert || el.contentEditable);
}

/** Everything the scorer weighs, all of it read in the page. */
export interface HoverTriggerSignals {
  /** A phase-1 `:hover` rule reveals something from this element. */
  cssRule: boolean;
  /** `aria-haspopup` promising a menu, listbox or dialog. */
  ariaHaspopup: boolean;
  /** `aria-expanded` is present (either value). */
  ariaExpanded: boolean;
  /** A `<summary>` — the platform's own disclosure trigger. */
  nativeDisclosure: boolean;
  /** class / id / data-testid / aria-label matches HOVER_TRIGGER_NAME_HINT. */
  nameHint: boolean;
  cursorPointer: boolean;
  visible: boolean;
  hasArea: boolean;
}

/**
 * How strongly does this element look like a hover trigger?
 *
 * The three structural signals are worth the threshold on their own because
 * each is the page ASSERTING a popup: a stylesheet that reveals another
 * element, an ARIA promise, a native `<summary>`. The name and the cursor are
 * corroboration — every card in a grid is `cursor:pointer`, and `.more` is a
 * class name on plenty of plain links.
 *
 * Each penalty is deliberately bigger than every positive weight put together,
 * so it VETOES rather than merely discounts: an element that is not on screen
 * is not one the agent can put a pointer on, and no stack of hints should be
 * able to carry it over the line.
 */
export function scoreHoverTrigger(signals: HoverTriggerSignals): number {
  let score = 0;
  if (signals.cssRule) score += 2;
  if (signals.ariaHaspopup) score += 2;
  if (signals.nativeDisclosure) score += 2;
  if (signals.ariaExpanded) score += 1;
  if (signals.nameHint) score += 1;
  if (signals.cursorPointer) score += 1;
  if (!signals.visible) score -= 10;
  if (!signals.hasArea) score -= 10;
  return score;
}

// ---------------------------------------------------------------------------
// Phase 1 — the in-page scan
// ---------------------------------------------------------------------------

/**
 * Elements that can carry the marker.
 *
 * The marker has to land on a line the agent can act on. A `:hover` rule's
 * trigger is very often a structural element — `nav li:hover > ul.sub` marks the
 * `li` — and a `listitem` line has no ref, so the marker named something the
 * agent could not hover, and vanished entirely under `filter:"interactive"`
 * (live dogfood, 2026-09-18). So the trigger's own first visible interactive
 * descendant is marked instead, which for that `li` is `link "Products"`.
 *
 * Form fields are absent on purpose, for the same reason isHoverTriggerEligible
 * excludes them: `has-submenu` on a text input would be nonsense, and a trigger
 * whose only interactive descendant is one keeps the marker on itself.
 */
export const HOVER_ANCHOR_SELECTOR =
  'a[href],button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],' +
  'summary,[tabindex]:not([tabindex="-1"])';

/**
 * Where a hidden element's hover trigger is, given the combinator that reveals
 * it.
 *
 * Walking UP from the revealed element rather than down from every candidate is
 * both cheaper and the only way to get this right: the rule's hovered part is a
 * selector that may match hundreds of elements, and only the few that actually
 * own a hidden revealed element are triggers. Testing the selector alone marked
 * every `li` in a nav because ONE of them had a submenu (live dogfood,
 * 2026-09-18).
 *
 * For a descendant combinator the nearest matching ancestor wins: it is the one
 * whose hover a person would use to open that panel, and it is the only one of
 * the matching ancestors that is certain to be the intended trigger.
 *
 * Exported for a unit test; the same source runs in the page.
 */
export function hoverTriggerForRevealed(
  revealed: unknown,
  triggerSelector: string,
  combinator: string,
): unknown {
  const el = revealed as {
    parentElement: unknown;
    previousElementSibling: unknown;
    matches: (s: string) => boolean;
    closest: (s: string) => unknown;
  } | null;
  if (!el) return null;
  try {
    if (combinator === '>') {
      const parent = el.parentElement as { matches: (s: string) => boolean } | null;
      return parent && parent.matches(triggerSelector) ? parent : null;
    }
    if (combinator === ' ') {
      const parent = el.parentElement as { closest: (s: string) => unknown } | null;
      return parent ? parent.closest(triggerSelector) : null;
    }
    // A sibling combinator: climb to the level where the rule's subject (or the
    // ancestor of it that the rule hangs off) sits, then look backwards.
    for (
      let host = el as { parentElement: unknown; previousElementSibling: unknown } | null;
      host && host.parentElement;
      host = host.parentElement as { parentElement: unknown; previousElementSibling: unknown } | null
    ) {
      if (combinator === '+') {
        const prev = host.previousElementSibling as { matches: (s: string) => boolean } | null;
        if (prev && prev.matches(triggerSelector)) return prev;
      } else {
        for (
          let prev = host.previousElementSibling as
            | { matches: (s: string) => boolean; previousElementSibling: unknown }
            | null;
          prev;
          prev = prev.previousElementSibling as
            | { matches: (s: string) => boolean; previousElementSibling: unknown }
            | null
        ) {
          if (prev.matches(triggerSelector)) return prev;
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * The phase-1 scan, as source text.
 *
 * Built as a string so the SAME scan runs over both transports: snapshot.ts
 * evaluates it for remote handles (which resolve to the backendNodeIds the
 * a11y tree is indexed by), and dom-intelligence.ts inlines it into the DOM
 * interactive listing, where the result is only ever an in-page `Set`.
 *
 * `elementsOnly` returns the bare ANCHOR array — the elements to mark — which
 * is all the DOM listing can use: it has no way to hold a handle, and no phase
 * 2 to feed. The full shape returns the triggers alongside them, because the
 * element a rule hangs off and the element the agent hovers are not always the
 * same one (HOVER_ANCHOR_SELECTOR).
 */
export function buildHoverTriggerScanExpression(opts?: { elementsOnly?: boolean }): string {
  const elementsOnly = opts?.elementsOnly === true;
  return `(() => {
  const started = Date.now();
  const exhausted = ${String(scanBudgetExhausted)};
  const classify = ${String(classifyHoverRule)};
  const eligible = ${String(isHoverTriggerEligible)};
  const score = ${String(scoreHoverTrigger)};
  const triggerForRevealed = ${String(hoverTriggerForRevealed)};
  const THRESHOLD = ${JSON.stringify(HOVER_TRIGGER_SCORE_THRESHOLD)};
  const MAX_TRACKED = ${JSON.stringify(HOVER_SCAN_LIMITS.MAX_TRACKED_TRIGGERS)};
  const NAME_HINT = ${String(HOVER_TRIGGER_NAME_HINT)};
  const ANCHOR_SEL = ${JSON.stringify(HOVER_ANCHOR_SELECTOR)};
  // Per-trigger cap on the reveal selectors carried to phase 2, and on how
  // many elements one selector may nominate: a rule whose revealed part is
  // \`div\` must not turn the scan into a whole-document crawl.
  const MAX_TARGETS = 4;
  const MAX_MATCHES_PER_SELECTOR = 200;
  const MAX_SELECTOR_CHARS = 200;
  // Ceiling on the elements the scoring pass touches. Each one costs a style
  // recalc and a layout read, so an uncapped candidate set turns the 60 ms
  // budget into whatever the page's rule count makes it.
  const MAX_CANDIDATES = 400;
  /** Interactive descendants considered when picking an anchor. */
  const MAX_ANCHOR_SCAN = 20;

  /** Not on screen right now: no box, or nothing painted. */
  const isHiddenNow = (el) => {
    try {
      if (typeof el.checkVisibility === 'function'
          && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
      const r = el.getBoundingClientRect();
      return !(r.width > 0) || !(r.height > 0);
    } catch (e) {
      return false;
    }
  };

  /** The line the marker goes on: the trigger, or what the agent can act on. */
  const anchorFor = (el) => {
    try {
      if (el.matches(ANCHOR_SEL)) return el;
      const inner = el.querySelectorAll(ANCHOR_SEL);
      const limit = Math.min(inner.length, MAX_ANCHOR_SCAN);
      for (let i = 0; i < limit; i++) {
        // Skip the ones inside the panel this trigger reveals — they are hidden
        // right now, and the visible label is what the agent hovers.
        if (!isHiddenNow(inner[i])) return inner[i];
      }
      return el;
    } catch (e) {
      return el;
    }
  };

  // --- stylesheet scan -----------------------------------------------------
  // Element -> reveal selectors. A cross-origin sheet throws on cssRules and
  // is skipped; there is no way to read it and no way to fake it.
  const cssTargets = new Map();
  let rules = 0;
  const queue = [];
  const sheets = document.styleSheets || [];
  for (let i = 0; i < sheets.length; i++) {
    try { if (sheets[i].cssRules) queue.push(sheets[i].cssRules); } catch (e) { /* cross-origin */ }
  }
  while (queue.length > 0) {
    const list = queue.shift();
    for (let i = 0; i < list.length; i++) {
      rules++;
      // A scan that ran out reports the triggers it already found and says
      // nothing about having stopped: a missing marker leaves the agent exactly
      // where it is today, so there is no verdict here worth qualifying.
      if (exhausted(rules, Date.now() - started)) { queue.length = 0; break; }
      const rule = list[i];
      let nested = null;
      try { nested = rule.cssRules; } catch (e) { nested = null; }
      // @media / @supports / @layer wrap the rules that matter on a modern
      // site — most \`:hover\` menus live inside \`@media (hover: hover)\`.
      if (nested && nested.length > 0) queue.push(nested);
      const selectorText = typeof rule.selectorText === 'string' ? rule.selectorText : '';
      if (selectorText === '' || selectorText.toLowerCase().indexOf(':hover') < 0) continue;
      const style = rule.style;
      if (!style || typeof style.length !== 'number') continue;
      const props = [];
      for (let p = 0; p < style.length; p++) props.push(style[p]);
      const matches = classify(selectorText, props);
      for (let m = 0; m < matches.length; m++) {
        // Start from what the rule REVEALS, and only then look for the element
        // whose hover reveals it. Two precision gates in one walk:
        //
        //   * the revealed element has to be hidden right now, or the rule is a
        //     hover micro-interaction rather than a menu —
        //     \`a:hover svg { transform: translateX(2px) }\` reads as a reveal
        //     otherwise, and \`querySelectorAll('a')\` then nominates every link
        //     on the page;
        //   * the trigger has to be THIS revealed element's own trigger. Testing
        //     the hovered selector on its own marked all three \`li\` of a nav
        //     because one of them had a submenu.
        let shown = null;
        try { shown = document.querySelectorAll(matches[m].target); } catch (e) { continue; }
        const shownLimit = Math.min(shown.length, MAX_MATCHES_PER_SELECTOR);
        const target = matches[m].target.slice(0, MAX_SELECTOR_CHARS);
        for (let s = 0; s < shownLimit; s++) {
          if (!isHiddenNow(shown[s])) continue;
          const el = triggerForRevealed(shown[s], matches[m].trigger, matches[m].combinator);
          if (!el) continue;
          let targets = cssTargets.get(el);
          if (!targets) {
            if (cssTargets.size >= MAX_CANDIDATES) break;
            targets = [];
            cssTargets.set(el, targets);
          }
          if (targets.length < MAX_TARGETS && targets.indexOf(target) < 0) targets.push(target);
        }
      }
    }
  }

  // --- candidate set -------------------------------------------------------
  const candidates = [];
  const seen = new Set();
  const add = (el) => {
    if (el && !seen.has(el) && candidates.length < MAX_CANDIDATES) {
      seen.add(el);
      candidates.push(el);
    }
  };
  for (const el of cssTargets.keys()) add(el);
  // \`details\` itself is deliberately not a candidate: the thing you interact
  // with is its \`<summary>\`, and marking both would put two has-submenu lines
  // on one disclosure.
  let declared = [];
  try {
    declared = document.querySelectorAll(
      '[aria-haspopup], [aria-expanded], summary'
    );
  } catch (e) { declared = []; }
  for (let i = 0; i < declared.length; i++) add(declared[i]);

  // --- score ---------------------------------------------------------------
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    // The same budget as the rule walk, because this pass is the expensive one:
    // getComputedStyle + getBoundingClientRect per candidate forces a style
    // recalc and a layout. The rule count no longer moves here, so it is the
    // wall clock that stops this loop.
    if (exhausted(rules, Date.now() - started)) break;
    const el = candidates[i];
    const tag = String(el.tagName || '').toLowerCase();
    let inert = false;
    try { inert = el.closest('[inert]') !== null; } catch (e) { inert = false; }
    if (!eligible({
      tagName: tag,
      disabled: el.hasAttribute('disabled') || el.disabled === true,
      ariaDisabled: (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true',
      inert: inert,
      // The attribute as well as the property: \`isContentEditable\` is what
      // catches an INHERITED editing host, and not every engine exposes it.
      contentEditable: el.isContentEditable === true
        || (el.getAttribute('contenteditable') || '').toLowerCase() === 'true',
    })) continue;

    let cursor = '';
    try { cursor = getComputedStyle(el).cursor || ''; } catch (e) { cursor = ''; }
    const rect = el.getBoundingClientRect();
    const haspopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    // className is an SVGAnimatedString on SVG elements, not a string.
    const classes = typeof el.className === 'string' ? el.className : '';
    const hintText = classes + ' ' + (el.id || '') + ' '
      + (el.getAttribute('data-testid') || '') + ' '
      + (el.getAttribute('aria-label') || '');
    const targets = cssTargets.get(el) || [];
    const value = score({
      cssRule: targets.length > 0,
      ariaHaspopup: haspopup === 'true' || haspopup === 'menu'
        || haspopup === 'listbox' || haspopup === 'dialog',
      ariaExpanded: el.hasAttribute('aria-expanded'),
      nativeDisclosure: tag === 'summary',
      nameHint: NAME_HINT.test(hintText),
      cursorPointer: cursor === 'pointer',
      visible: typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : true,
      hasArea: rect.width > 0 && rect.height > 0,
    });
    if (value < THRESHOLD) continue;
    scored.push({ el: el, anchor: anchorFor(el), score: value, targets: targets });
  }
  // Highest score first: phase 2 only gets to hover a few, and they should be
  // the ones the page asserted hardest about.
  scored.sort((a, b) => b.score - a.score);
  // One mark per line: two triggers that share a visible label (a wrapper and
  // the element inside it) would otherwise put the marker on it twice.
  const anchors = new Set();
  const picked = [];
  for (let i = 0; i < scored.length && picked.length < MAX_TRACKED; i++) {
    if (anchors.has(scored[i].anchor)) continue;
    anchors.add(scored[i].anchor);
    picked.push(scored[i]);
  }
${
  elementsOnly
    ? '  return picked.map((c) => c.anchor);'
    : `  return {
    els: picked.map((c) => c.el),
    anchors: picked.map((c) => c.anchor),
    meta: JSON.stringify(picked.map((c) => ({ s: c.score, t: c.targets }))),
    count: picked.length,
  };`
}
})()`;
}

// ---------------------------------------------------------------------------
// Phase 1 — collection over CDP
// ---------------------------------------------------------------------------

/** The subset of a CDP session this module needs (also what fakes implement). */
export interface HoverCdpSender {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

/** One trigger the scan found, with the handles phase 2 needs. */
export interface HoverCandidate {
  /**
   * Remote handle for the TRIGGER — the element the `:hover` rule hangs off.
   * Valid until the collection's `release()` runs. It is what the reveal watch
   * is scoped from, and it is often not the element the agent can act on.
   */
  objectId: string;
  /**
   * Remote handle for the element that carries the marker and gets hovered: the
   * trigger's own visible interactive descendant, or the trigger itself.
   * Hovering it still triggers an ancestor's `:hover` rule, and it is the line
   * the snapshot points the agent at (HOVER_ANCHOR_SELECTOR).
   */
  anchorObjectId: string;
  /** The ANCHOR's index into the a11y tree; absent when it has no a11y node. */
  backendNodeId?: number;
  score: number;
  /** Selectors the phase-1 rules reveal from this trigger. */
  targets: string[];
}

export interface HoverTriggerCollection {
  candidates: HoverCandidate[];
  /**
   * Why the scan came back with nothing — `'found'` when it did not.
   *
   * An empty result has several very different causes and they used to look
   * identical from outside: a page with no hover menus, a budget that expired on
   * a slow machine, a renderer that refused the evaluate, a payload we could not
   * read back. A whole CI suite came back with zero candidates and the log could
   * not say which (CI, 2026-09-18). The marker still fails open either way; this
   * only makes the silence diagnosable.
   */
  note: 'found' | 'none-found' | 'evaluate-failed' | 'payload-unreadable' | 'budget-expired' | 'threw';
  /** Drop the remote handles. Safe to call more than once. */
  release: () => Promise<void>;
}

/** Nothing found (or nothing readable) — the shape every failure returns. */
function noTriggers(note: HoverTriggerCollection['note']): HoverTriggerCollection {
  return { candidates: [], note, release: () => Promise.resolve() };
}

/** Ceiling on the page-built meta payload, before it is parsed. */
const MAX_META_CHARS = 16_384;

type RemoteProp = { name: string; value?: { value?: unknown; objectId?: string } };

function propOf(props: RemoteProp[], name: string): RemoteProp['value'] {
  return props.find((p) => p.name === name)?.value;
}

/**
 * Run the phase-1 scan and resolve its triggers to backendNodeIds.
 *
 * Shaped exactly like collectOcclusion: `returnByValue: false`, because the
 * payload carries live Elements and the whole point of keeping them as remote
 * handles is that `DOM.describeNode` turns each one into the backendNodeId the
 * a11y tree is indexed by — and that phase 2 can hover them without having to
 * re-find them by selector.
 *
 * Every failure returns an empty collection rather than throwing: this is an
 * annotation on top of a snapshot, and a snapshot without it is exactly the
 * snapshot that shipped before this module existed.
 */
export async function collectHoverTriggers(
  client: HoverCdpSender,
  /** Isolated-world context to scan in; omitted (or null) means main world. */
  contextId?: number | null,
): Promise<HoverTriggerCollection> {
  const objectGroup = 'wmux-hover';
  const deadline = Date.now() + HOVER_SCAN_LIMITS.COLLECT_BUDGET_MS;

  /** Resolve, or give up when the shared budget runs out. */
  const bounded = <T>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p.catch(() => null),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())),
      ),
    ]);

  let acquired = false;
  const release = async (): Promise<void> => {
    if (!acquired) return;
    acquired = false;
    await Promise.race([
      client.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, HOVER_SCAN_LIMITS.CLEANUP_BUDGET_MS)),
    ]);
  };

  try {
    const evaluated = (await bounded(
      client.send('Runtime.evaluate', {
        expression: buildHoverTriggerScanExpression(),
        returnByValue: false,
        objectGroup,
        timeout: HOVER_SCAN_LIMITS.COLLECT_BUDGET_MS,
        // The scan reads stylesheets, attributes and layout, all of which the
        // isolated world shares — so the page can neither see the scan nor
        // hook the methods it uses.
        ...(typeof contextId === 'number' ? { contextId } : {}),
      }),
    )) as { result?: { objectId?: string } } | null;

    const rootId = evaluated?.result?.objectId;
    // Null covers both halves of the race: the renderer refused the evaluate, or
    // the shared budget ran out before it answered.
    if (!rootId) return noTriggers(Date.now() >= deadline ? 'budget-expired' : 'evaluate-failed');
    acquired = true;

    const rootProps = (await bounded(
      client.send('Runtime.getProperties', { objectId: rootId, ownProperties: true }),
    )) as { result?: RemoteProp[] } | null;
    const props = rootProps?.result;
    if (!props) {
      await release();
      return noTriggers(Date.now() >= deadline ? 'budget-expired' : 'payload-unreadable');
    }

    const rawMeta = propOf(props, 'meta')?.value;
    // The meta is built by our own isolated-world code, but its CONTENT is
    // page text (selectors lifted out of the page's stylesheets), so it is
    // capped on THIS side of the wire: a hostile page can patch
    // String.prototype.slice, and in the main-world fallback that patch runs.
    const meta = parseHoverMeta(typeof rawMeta === 'string' ? rawMeta : '');

    // The common case is a page with no hover-only menus at all, and it should
    // cost as little as possible: the count says so in the payload we already
    // have, which saves the array walk and every describeNode behind it.
    if (Number(propOf(props, 'count')?.value ?? 0) <= 0) {
      await release();
      return noTriggers('none-found');
    }

    /** The index slots of one of the payload's element arrays. */
    const handlesOf = async (name: string): Promise<string[]> => {
      const arrayId = propOf(props, name)?.objectId;
      if (!arrayId) return [];
      const items = (await bounded(
        client.send('Runtime.getProperties', { objectId: arrayId, ownProperties: true }),
      )) as { result?: RemoteProp[] } | null;
      const out: string[] = [];
      for (const item of items?.result ?? []) {
        // Own properties of an array include `length`; only the index slots
        // hold elements. The cap is re-applied here rather than trusted from
        // the page's own count, for the reason above.
        if (out.length >= HOVER_SCAN_LIMITS.MAX_TRACKED_TRIGGERS) break;
        if (!/^\d+$/.test(item.name)) continue;
        const objectId = item.value?.objectId;
        if (objectId) out.push(objectId);
      }
      return out;
    };

    // Issued together: they are two reads of the same payload, and serialising
    // them would cost the shared budget a second round trip's wait.
    const [objectIds, anchorIds] = await Promise.all([handlesOf('els'), handlesOf('anchors')]);
    if (objectIds.length === 0 || anchorIds.length !== objectIds.length) {
      await release();
      return noTriggers(Date.now() >= deadline ? 'budget-expired' : 'payload-unreadable');
    }

    // The ANCHOR's id, because that is the line the marker goes on. One round
    // trip each, but issued together: sequentially these are the dominant cost
    // of the whole collection.
    const described = await Promise.all(
      anchorIds.map((objectId) =>
        bounded(client.send('DOM.describeNode', { objectId })) as Promise<{
          node?: { backendNodeId?: number };
        } | null>,
      ),
    );

    const candidates: HoverCandidate[] = objectIds.map((objectId, index) => {
      const backendNodeId = described[index]?.node?.backendNodeId;
      return {
        objectId,
        anchorObjectId: anchorIds[index],
        ...(backendNodeId !== undefined && { backendNodeId }),
        score: meta[index]?.score ?? 0,
        targets: meta[index]?.targets ?? [],
      };
    });

    return { candidates, note: 'found', release };
  } catch {
    // No Runtime domain / detached target / hostile page — see fail-open above.
    await release().catch(() => undefined);
    return noTriggers('threw');
  }
}

/** The per-trigger meta, re-capped on this side. Never throws. */
function parseHoverMeta(raw: string): { score: number; targets: string[] }[] {
  if (raw === '' || raw.length > MAX_META_CHARS) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, HOVER_SCAN_LIMITS.MAX_TRACKED_TRIGGERS).map((entry) => {
    const row = (entry ?? {}) as { s?: unknown; t?: unknown };
    const targets = Array.isArray(row.t) ? row.t : [];
    return {
      score: typeof row.s === 'number' && Number.isFinite(row.s) ? row.s : 0,
      targets: targets
        .filter((t): t is string => typeof t === 'string')
        .slice(0, 4)
        .map((t) => t.slice(0, 200)),
    };
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What one trigger earns on its snapshot line. */
export interface HoverSurfaceMark {
  /** Accessible names the probe saw appear. Empty on a phase-1-only mark. */
  items: string[];
  /** More appeared than `items` lists. */
  truncated: boolean;
  /** The surface was still open after the pointer was moved away. */
  staysOpen: boolean;
}

/** backendNodeId → its mark. */
export type HoverSurfaceMarks = Map<number, HoverSurfaceMark>;

/** A phase-1-only mark: we know it is a trigger, not what is behind it. */
export function phaseOneMark(): HoverSurfaceMark {
  return { items: [], truncated: false, staysOpen: false };
}

/**
 * The probe's part of a trigger's line, or '' when there is nothing to add.
 *
 * `stays open` is only ever said alongside items, because it is a caveat about
 * THEM: a hover that revealed nothing has nothing left open, and reporting
 * that a page "stays open" would describe a state that does not exist.
 */
export function formatHoverItems(mark: HoverSurfaceMark | undefined): string {
  if (!mark || mark.items.length === 0) return '';
  const parts = mark.items.slice();
  if (mark.truncated) parts.push('…');
  if (mark.staysOpen) parts.push('stays open');
  return ` [hover first: ${parts.join(' | ')}]`;
}

/**
 * The one line a page with hover menus earns, in the snapshot's LEADING note
 * slot — beside `q`'s and `filter`'s notes, not after the tree.
 *
 * It was a footer first, and on a real page it was never seen: a 3030-line
 * snapshot is delivered in windows, and a trailer lands in the last one, which
 * an agent reading the top of the tree never reaches (live dogfood,
 * 2026-09-18). It is an instruction about a flag to pass on the NEXT call, so
 * it belongs where the other such notes already are.
 *
 * Only earned when phase 1 marked something AND the caller did not ask for the
 * probe: with `probeHover:true` the items are already on the lines below, and
 * telling the agent to pass a flag it just passed is noise.
 */
export function hoverMenusNote(triggerCount: number): string {
  if (triggerCount <= 0) return '';
  return `hover menus: ${triggerCount} triggers marked ${HAS_SUBMENU_MARKER}; pass probeHover:true to list their items`;
}

/**
 * What the probe could NOT answer, said out loud.
 *
 * A trigger the probe never reached looks exactly like a trigger whose menu is
 * empty: a `has-submenu` line with no items after it. The first reading is
 * right far more often, and the second is the one that sends an agent away
 * believing a menu it can see marked has nothing in it. The probe is bounded by
 * a wall clock it does not control — one read measured 18 ms headless and
 * 479 ms in a headed window that was not focused — so running out is a normal
 * outcome and has to be a reported one.
 */
export function hoverProbeShortfallNote(unanswered: number): string {
  if (unanswered <= 0) return '';
  const plural = unanswered === 1 ? 'trigger' : 'triggers';
  return `hover probe: no items for ${unanswered} marked ${plural} within the time budget — hover one with browser_hover and re-snapshot to see its menu`;
}

/**
 * How many `has-submenu` markers a rendered snapshot actually carries.
 *
 * The footer's count is taken from the OUTPUT rather than from the mark map,
 * because the two legitimately disagree: serialisation suppresses the marker on
 * an already-expanded node, and the length cap can strip marked lines entirely.
 * A footer that promised five triggers over a tree showing none would be the
 * same footer-contradicts-the-tree failure `hasFrameContent` exists to fix.
 */
export function countHasSubmenuMarkers(rendered: string): number {
  return rendered.split(` ${HAS_SUBMENU_MARKER}`).length - 1;
}

// ---------------------------------------------------------------------------
// Phase 2 — the hover probe
// ---------------------------------------------------------------------------

/**
 * One step of the probe, run in the page with the TRIGGER as `this`.
 *
 * Two modes rather than two functions so the "is it showing?" predicate has a
 * single definition: `before` records what is hidden, `after` asks which of
 * those exact elements is now showing, and the two must agree character for
 * character or the probe reports a reveal that never happened.
 *
 *   before(targetsJson, anchor)             -> { url, vw, vh, b*, hidden }
 *   after(hiddenArray, anchor, aimJson)     -> { url, ok, names, revealed, named, vw, vh, b* }
 *
 * `before`'s `hidden` comes back as live element handles; `after` is handed that
 * same array, so it asks about the same elements without re-querying — a
 * re-query after the hover would also pick up whatever the hover ADDED and could
 * not tell the two apart. `aimJson` carries `{x, y, cap}`: where the pointer was
 * put, and how many names to return.
 *
 * The box is the ANCHOR's, not the trigger's: the anchor is what the agent is
 * told to hover, and it is the element the hover is aimed at. Scoping still
 * comes from the trigger, because that is what the `:hover` rule hangs off.
 */
export function hoverProbeStep(
  this: unknown,
  mode: string,
  arg: unknown,
  extra?: unknown,
  aimJson?: unknown,
): unknown {
  const el = this as {
    querySelectorAll: (s: string) => ArrayLike<unknown>;
    getAttribute?: (n: string) => string | null;
    parentElement?: unknown;
    nextElementSibling?: unknown;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  };
  // `[tabindex="-1"]` is deliberately excluded: a dropdown panel routinely
  // carries one for focus management, and including it made the PANEL itself a
  // nameable item whose label is every entry run together.
  const INTERACTIVE =
    'a[href],button,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],' +
    '[role="option"],[role="link"],[role="button"],[role="tab"],summary,' +
    '[tabindex]:not([tabindex="-1"])';
  /** Elements one probe will consider, across the trigger and every target. */
  const MAX_POOL = 400;
  const MAX_MATCHES_PER_SELECTOR = 40;
  const MAX_NAME_CHARS = 60;

  /**
   * Is this element on screen right now?
   *
   * `checkVisibility` ONLY, and deliberately no `getBoundingClientRect`. A box
   * read forces layout, and forcing layout once per pool element is what made
   * this probe unaffordable in the mode wmux ships: on a 1500-element page in a
   * headed window that is not the focused one, the call carrying that sweep
   * measured ~1.0 s against ~20 ms headless, which was the whole probe budget
   * for one trigger (dogfood + CI, 2026-09-18). Style is cheap; layout is not.
   *
   * What that gives up: a panel hidden by `max-height: 0` with `overflow:
   * hidden`, or by a `clip`/`clip-path` inset, is laid out and passes this test,
   * so such a menu is not seen as opening. What it keeps is `display: none`,
   * `visibility: hidden`, `opacity: 0` and `content-visibility` — which is what
   * hover menus are actually built from, including both shapes on the dogfood
   * page. A feature that works on the common case within a bounded time beats
   * one that covers a rare case and times out on the shipped lane.
   */
  const isShowing = (node: unknown): boolean => {
    const n = node as { checkVisibility?: (o?: unknown) => boolean } | null;
    if (!n) return false;
    if (typeof n.checkVisibility !== 'function') return true;
    return n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) !== false;
  };

  /** The anchor's box and the viewport, as flat numbers. */
  const geometry = (node: unknown): Record<string, number> => {
    const host = node as {
      getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
    } | null;
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    try {
      if (host && typeof host.getBoundingClientRect === 'function') rect = host.getBoundingClientRect();
    } catch (e) { /* detached */ }
    return {
      vw: innerWidth,
      vh: innerHeight,
      bx: rect.left,
      by: rect.top,
      bw: rect.width,
      bh: rect.height,
    };
  };

  /**
   * Did the pointer land on the element we aimed at?
   *
   * It routinely does not, and the reason is this feature's own doing: the
   * approach path crosses the page, and crossing ANOTHER trigger opens its menu,
   * which is absolutely positioned and can be painted straight over the element
   * we were walking to. The hover then never happens and the read reports the
   * other menu's items under this trigger's name (live dogfood, 2026-09-18: the
   * nav submenu covered the account button below it).
   *
   * Same contract as browser.rpc.ts's approachElement: verify, let the caller
   * re-approach once, and refuse rather than report what happens to be there.
   * Answered by the SAME call that reads the reveal, so the two describe one
   * layout state and the check costs no round trip of its own.
   */
  const landedOn = (aimed: unknown, point: { x: number; y: number } | null): boolean => {
    if (!aimed || !point) return false;
    const host = aimed as { contains?: (n: Node) => boolean };
    let hit: unknown = null;
    try {
      hit = document.elementFromPoint(point.x, point.y);
    } catch (e) {
      hit = null;
    }
    if (!hit) return false;
    if (hit === aimed) return true;
    if (typeof host.contains === 'function' && host.contains(hit as Node)) return true;
    const contains = (hit as { contains?: (n: Node) => boolean }).contains;
    return typeof contains === 'function' && contains.call(hit, aimed as Node);
  };

  if (mode === 'before') {
    // Containers worth watching even when they hold nothing interactive: a
    // panel appearing IS the reveal, and that is what the close check measures.
    const SURFACE = '[role="menu"],[role="listbox"],[role="dialog"],[role="tooltip"],[popover]';
    // Elements that are never rendered, so they can never become "revealed".
    const NEVER_RENDERED = ' script style template link meta noscript title head ';

    // Only HIDDEN elements go in the pool, and they go in by proximity to the
    // trigger, because the cap decides what survives on a big page. Live
    // dogfood (2026-09-18) found the ordering mattered more than the size: the
    // menu an `aria-haspopup` button opens was a SIBLING of the button, so a
    // pool of "interactive descendants of the trigger" was empty and the probe
    // reported nothing on a page whose menu opened perfectly.
    const pool: unknown[] = [];
    const push = (node: unknown): void => {
      if (!node || pool.length >= MAX_POOL || pool.indexOf(node) >= 0) return;
      const tag = String((node as { tagName?: unknown }).tagName || '').toLowerCase();
      if (tag === '' || NEVER_RENDERED.indexOf(` ${tag} `) >= 0) return;
      if (isShowing(node)) return;
      pool.push(node);
    };
    /** `root` itself when it is a surface, plus its interactive descendants. */
    const harvest = (root: unknown): void => {
      const host = root as {
        querySelectorAll?: (s: string) => ArrayLike<unknown>;
        matches?: (s: string) => boolean;
      };
      if (!host || typeof host.querySelectorAll !== 'function') return;
      try {
        if (typeof host.matches === 'function' && host.matches(SURFACE)) push(host);
      } catch (e) { /* not matchable */ }
      let found: ArrayLike<unknown> = [];
      try {
        found = host.querySelectorAll(INTERACTIVE);
      } catch (e) {
        return;
      }
      const limit = Math.min(found.length, MAX_POOL);
      for (let i = 0; i < limit; i++) push(found[i]);
    };
    const byId = (raw: string): void => {
      const ids = raw.split(/\s+/);
      for (let i = 0; i < ids.length && i < 8; i++) {
        if (ids[i] === '') continue;
        let referenced = null;
        try { referenced = document.getElementById(ids[i]); } catch (e) { referenced = null; }
        if (referenced) { push(referenced); harvest(referenced); }
      }
    };

    // 1. Inside the trigger — a nav `li` holding its own `ul.sub`.
    harvest(el);
    // 2. What the trigger says it controls. The most precise signal there is,
    //    and it costs one getElementById.
    const attr = (name: string): string =>
      (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null) || '';
    byId(attr('aria-controls'));
    byId(attr('aria-owns'));
    // 3. What the phase-1 CSS rules point at.
    let targets: unknown = [];
    try {
      targets = JSON.parse(String(arg));
    } catch (e) {
      targets = [];
    }
    const list = Array.isArray(targets) ? targets : [];
    for (let i = 0; i < list.length; i++) {
      let matched: ArrayLike<unknown> = [];
      try {
        matched = document.querySelectorAll(String(list[i]));
      } catch (e) {
        continue;
      }
      const limit = Math.min(matched.length, MAX_MATCHES_PER_SELECTOR);
      for (let m = 0; m < limit; m++) {
        push(matched[m]);
        harvest(matched[m]);
      }
    }
    // 4. The trigger's siblings — where a JS-mounted menu most often lives.
    //    `harvest` only, deliberately: it takes a sibling that IS a menu-ish
    //    surface and any interactive content inside one, and leaves every other
    //    hidden sibling alone. Pushing them all made anything that happened to
    //    become visible during the 300 ms window read as this trigger's menu —
    //    a `transition: opacity 6s` paragraph two siblings down was reported as
    //    a surface that would not close (`stays open`), on a page whose menus
    //    were behaving perfectly (dogfood, 2026-09-18).
    for (
      let sibling = el.nextElementSibling as { nextElementSibling?: unknown } | null, n = 0;
      sibling && n < MAX_MATCHES_PER_SELECTOR;
      sibling = sibling.nextElementSibling as { nextElementSibling?: unknown } | null, n++
    ) {
      harvest(sibling);
    }
    // 5. Menu-ish containers anywhere in the document — a library that mounts
    //    its dropdown at the end of <body> is the case this exists for.
    //
    //    SURFACE only, NOT every interactive element. Each pool candidate costs
    //    a checkVisibility and a getBoundingClientRect, which is a forced style
    //    and layout read; on a page with 1500 links that is 1500 of them, and a
    //    HEADED window that is not the focused one services a forced layout at
    //    whatever priority Chrome gives a throttled compositor. Measured on
    //    Chrome 153: this one call went from 18 ms headless to 479 ms headed,
    //    which by itself spent the whole probe budget on the first trigger and
    //    left the second unlisted (dogfood, 2026-09-18). A page has a handful of
    //    role="menu" containers and thousands of links.
    try {
      const surfaces = document.querySelectorAll(SURFACE);
      const limit = Math.min(surfaces.length, MAX_MATCHES_PER_SELECTOR);
      for (let i = 0; i < limit; i++) {
        push(surfaces[i]);
        harvest(surfaces[i]);
      }
    } catch (e) { /* unusable selector on this engine */ }

    // The box is returned as flat numbers, not as an object: the payload comes
    // back as a remote handle (it has to, for `hidden`), and a nested object
    // would be one more handle to resolve with one more round trip.
    return { url: location.href, ...geometry(extra || el), hidden: pool };
  }

  const hidden = (Array.isArray(arg) ? arg : []) as unknown[];
  let aim: { x: number; y: number; cap?: number } | null = null;
  try {
    aim = JSON.parse(String(aimJson));
  } catch (e) {
    aim = null;
  }
  const cap = typeof aim?.cap === 'number' && aim.cap > 0 ? aim.cap : 12;
  /** Names worth collecting past the cap, so `named` can be exact. */
  const MAX_NAMES_SEEN = 64;
  const unique: string[] = [];
  let revealed = 0;
  for (let i = 0; i < hidden.length; i++) {
    const node = hidden[i] as {
      getAttribute?: (n: string) => string | null;
      matches?: (s: string) => boolean;
      textContent?: string | null;
    };
    if (!isShowing(node)) continue;
    // Counted whatever it is: the panel ELEMENT appearing is how "something
    // opened" is known, and it is what the close check re-measures.
    revealed += 1;
    // ...but only the controls inside it are worth naming. A panel's own
    // textContent is every item's label run together ("DocsAPIPricing"), which
    // is not an item and not something the agent can act on.
    if (typeof node.matches !== 'function' || !node.matches(INTERACTIVE)) continue;
    if (unique.length >= MAX_NAMES_SEEN) continue;
    const attr = (name: string): string =>
      (typeof node.getAttribute === 'function' ? node.getAttribute(name) : null) || '';
    const raw = (
      attr('aria-label') ||
      String(node.textContent || '').replace(/\s+/g, ' ').trim() ||
      attr('title') ||
      attr('alt') ||
      attr('placeholder')
    ).slice(0, MAX_NAME_CHARS);
    // Counted only once it has survived the empty-and-duplicate filters, so
    // `named > names.length` means the list really was cut short — an icon-only
    // button with no label, or a second "Learn more", is not a missing item.
    if (raw !== '' && unique.indexOf(raw) < 0) unique.push(raw);
  }
  return {
    url: location.href,
    // The landing check rides along: one round trip, and one layout state for
    // both answers — see landedOn.
    ok: landedOn(extra || el, aim),
    names: unique.slice(0, cap),
    revealed: revealed,
    named: unique.length,
    ...geometry(extra || el),
  };
}

/** Everything the probe needs from the lane it is running in. */
export interface HoverProbeContext {
  /** The surface's current top-level URL, read before and after each trigger. */
  currentUrl: () => string | undefined;
  /** Where the pointer was last left on this surface. */
  pointerStart: Point;
  /** Called with the pointer's new resting place, so the lane stays in step. */
  onPointerMoved: (point: Point) => void;
  /** pathPoints' jitter source. A constant 0.5 yields a straight path. */
  rng?: () => number;
  /**
   * Wall-clock ceiling for THIS probe. Defaults to TOTAL_BUDGET_MS.
   *
   * The default is a user-facing latency promise, measured on a warm machine
   * and repeated in `browser_snapshot`'s description. It is the caller's
   * policy, not a property of this algorithm, and a caller that cares about
   * the ANSWER rather than the latency may buy more time.
   *
   * That distinction is why this exists. The real-Chrome test asserts the
   * probe finds both menus on the fixture page; inheriting the shipped budget
   * there made a slow CI runner fail it as a correctness bug, when what had
   * actually happened is the degradation this module documents and reports:
   * the per-trigger slice was spent on the approach, `waitUntil` collapsed
   * onto `slice`, and every trigger came back unanswered. The budget contract
   * itself stays pinned deterministically by the virtual clock in
   * hoverSurfaces.probe.test.ts, which is where it belongs.
   */
  budgetMs?: number;
}

export interface HoverProbeOutcome {
  /** backendNodeId → what hovering it revealed. Empty when cancelled. */
  revealed: HoverSurfaceMarks;
  /** The page navigated mid-probe, so every result was dropped. */
  cancelled: boolean;
  /** Triggers actually hovered. */
  probed: number;
  /**
   * Marked triggers the probe never got to, or hovered without learning
   * anything.
   *
   * How long a hover costs is not something this code controls: the same read
   * measured 18 ms headless and 479 ms in a headed window that was not the
   * focused one. A bounded probe on a slow renderer therefore cannot promise an
   * answer for every trigger — so it says how many it has no answer for, rather
   * than leaving lines silently bare and letting the agent read that as
   * "this menu is empty".
   */
  unanswered: number;
}

/**
 * Are these two URLs the same document?
 *
 * The fragment is ignored on purpose. A nav bar — the exact thing this feature
 * exists for — updates `location.hash` while you scroll past its sections, and
 * scroll-spy highlighting does it with `history.replaceState`. Treating that as
 * a navigation would throw away every result the probe had collected, on the
 * pages most likely to have hover menus at all. A path or query that changed
 * IS treated as a navigation: an SPA route swaps the content the names came
 * from, even without a document load.
 */
export function sameHoverDocument(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const strip = (url: string): string => {
    const hash = url.indexOf('#');
    return hash < 0 ? url : url.slice(0, hash);
  };
  return strip(a) === strip(b);
}

/**
 * Where to park the pointer to let a surface close again.
 *
 * Not (0, 0): this position is written back into the lane's pointer tracker, so
 * it becomes the start of the NEXT click's approach path, and the viewport
 * origin is the one place `shared/pointerPath` says a real pointer never rests.
 * The tracker's own idea of "somewhere plausible" is reused instead, and only
 * displaced when the trigger happens to sit on top of it.
 */
export function neutralPointFor(box: Box, viewport: { width: number; height: number }): Point {
  const home = defaultStartPoint(viewport);
  const inside =
    home.x >= box.x &&
    home.x <= box.x + box.width &&
    home.y >= box.y &&
    home.y <= box.y + box.height;
  if (!inside) return home;
  // The trigger covers the usual resting place; park diagonally opposite it.
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), Math.max(0, max));
  return {
    x: clamp(viewport.width - 1 - home.x, viewport.width - 1),
    y: clamp(viewport.height - 1 - home.y, viewport.height - 1),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What one `after` step reported, or null when it could not be read. */
interface AfterReading {
  url: string;
  /** The pointer is on the anchor — see hoverProbeStep's landedOn. */
  ok: boolean;
  names: string[];
  revealed: number;
  named: number;
  /** The anchor's box as of this read, for a re-approach after a bad landing. */
  box: Box | null;
}

function readAfter(reply: unknown): AfterReading | null {
  const value = (reply as { result?: { value?: unknown } } | null)?.result?.value as
    | {
        url?: unknown;
        ok?: unknown;
        names?: unknown;
        revealed?: unknown;
        named?: unknown;
        bx?: unknown;
        by?: unknown;
        bw?: unknown;
        bh?: unknown;
      }
    | undefined;
  if (!value || typeof value.url !== 'string') return null;
  const revealed = Number(value.revealed ?? 0);
  const width = Number(value.bw ?? 0);
  const height = Number(value.bh ?? 0);
  return {
    url: value.url,
    // A reply that predates the merged landing check (a fake, an older page
    // script) says nothing about where the pointer is; treat that as landed
    // rather than refusing every trigger.
    ok: value.ok !== false,
    names: Array.isArray(value.names) ? value.names.filter((n): n is string => typeof n === 'string') : [],
    revealed,
    named: Number(value.named ?? revealed),
    box:
      width > 0 && height > 0
        ? { x: Number(value.bx ?? 0), y: Number(value.by ?? 0), width, height }
        : null,
  };
}

/**
 * Hover the top candidates and list what appears.
 *
 * Bounded four ways and every one of them matters: MAX_TRIGGERS, because each
 * hover is real input a real site reacts to; TOTAL_BUDGET_MS, because a
 * snapshot the agent is waiting on must not become a five-second crawl;
 * REVEAL_WAIT_MS per trigger, because a CSS transition that has not finished in
 * 300 ms is not what the agent is blocked on; and every single round trip is
 * raced against the shared deadline, because a page running a long task answers
 * `Runtime.callFunctionOn` whenever it feels like it and there is no CDP
 * timeout parameter to lean on (occlusion.ts's lesson, phase 1's `bounded`).
 *
 * The pointer is restored in a `finally`, so a handle the page invalidated
 * mid-trigger cannot leave a mega-menu open for every later snapshot and click
 * on that page, and the restore gets its own budget past the deadline for the
 * same reason cleanup does in occlusion.ts. The close is then VERIFIED rather
 * than assumed, with the same patience the open was given — a panel with a
 * close transition is not a panel that stayed open — and only a surface that is
 * genuinely still up earns `stays open`.
 *
 * A navigation mid-probe drops everything: the names were collected from a
 * document that is gone, and reporting them against the new page's tree would
 * be worse than reporting nothing.
 */
export async function probeHoverSurfaces(
  client: HoverCdpSender,
  candidates: readonly HoverCandidate[],
  ctx: HoverProbeContext,
): Promise<HoverProbeOutcome> {
  const revealed: HoverSurfaceMarks = new Map();
  const startUrl = ctx.currentUrl();
  const started = Date.now();
  const deadline = started + (ctx.budgetMs ?? HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS);
  /** The one allowance past the deadline, for un-hovering. Not per trigger. */
  const graceDeadline = deadline + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS;
  const step = String(hoverProbeStep);
  let pointer = ctx.pointerStart;
  let probed = 0;

  /** One round trip, raced against `until`. Null on failure or expiry. */
  const send = (until: number, method: string, params: unknown): Promise<unknown | null> =>
    Promise.race([
      client.send(method, params).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, until - Date.now()))),
    ]);

  /**
   * Walk the pointer to `to` along the same geometry browser_hover uses, at the
   * probe's own step count — see HOVER_PROBE_LIMITS.POINTER_STEPS.
   */
  const movePointer = async (
    to: Point,
    until: number,
    steps: number = HOVER_PROBE_LIMITS.POINTER_STEPS,
  ): Promise<void> => {
    for (const point of pathPoints(pointer, to, steps, ctx.rng)) {
      await send(until, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    }
    pointer = to;
    ctx.onPointerMoved(to);
  };

  /** A park or a hop back — not an interaction. See DEPARTURE_STEPS. */
  const hopPointer = (to: Point, until: number): Promise<void> =>
    movePointer(to, until, HOVER_PROBE_LIMITS.DEPARTURE_STEPS);

  /**
   * Read what is showing, and whether the pointer is on the anchor, in one call.
   *
   * `cap` of 1 makes it a yes/no about the surface rather than a second list,
   * which is all the close check needs.
   */
  const read = async (
    candidate: HoverCandidate,
    hiddenId: string,
    point: Point,
    cap: number,
    until: number,
  ): Promise<AfterReading | null> =>
    readAfter(
      await send(until, 'Runtime.callFunctionOn', {
        functionDeclaration: step,
        objectId: candidate.objectId,
        arguments: [
          { value: 'after' },
          { objectId: hiddenId },
          { objectId: candidate.anchorObjectId },
          { value: JSON.stringify({ x: point.x, y: point.y, cap }) },
        ],
        returnByValue: true,
        awaitPromise: false,
      }),
    );

  const queue = candidates.slice(0, HOVER_PROBE_LIMITS.MAX_TRIGGERS);
  /**
   * Each trigger's own share of the budget.
   *
   * A single shared deadline is not enough, and this is the bug that made a nav
   * submenu invisible on the shipped lane: the FIRST trigger simply spent
   * everything, and every one after it was cut at the top of the loop with no
   * hover and nothing said. How long a hover costs is not something this code
   * controls — the same call measured 18 ms headless and 479 ms in a headed
   * window that was not the focused one — so the only way the second trigger
   * ever gets a turn is to reserve it one.
   *
   * A trigger that finishes early gives the rest its remainder, because the
   * slice is recomputed from what is actually left each time round.
   */
  const sliceFor = (remaining: number): number =>
    Math.max(0, Math.floor((deadline - Date.now()) / Math.max(1, remaining)));

  try {
    for (let index = 0; index < queue.length; index += 1) {
      const candidate = queue[index];
      if (Date.now() >= deadline) break;
      if (candidate.backendNodeId === undefined) continue;
      // Never past the shared deadline, and never more than this trigger's share
      // of what is left.
      const slice = Math.min(deadline, Date.now() + sliceFor(queue.length - index));

      // --- before -------------------------------------------------------
      // `this` is the trigger, so the reveal watch is scoped from the element
      // the rule hangs off — for `nav li:hover > ul.sub` that is the `li`, whose
      // submenu is a SIBLING of the link the marker sits on. The anchor rides
      // along only as the box to aim at.
      const before = (await send(slice, 'Runtime.callFunctionOn', {
        functionDeclaration: step,
        objectId: candidate.objectId,
        arguments: [
          { value: 'before' },
          { value: JSON.stringify(candidate.targets) },
          { objectId: candidate.anchorObjectId },
        ],
        returnByValue: false,
        awaitPromise: false,
      })) as { result?: { objectId?: string } } | null;
      const beforeId = before?.result?.objectId;
      if (!beforeId) continue;

      const beforeProps = (await send(slice, 'Runtime.getProperties', {
        objectId: beforeId,
        ownProperties: true,
      })) as { result?: RemoteProp[] } | null;
      const props = beforeProps?.result;
      if (!props) continue;

      const beforeUrl = propOf(props, 'url')?.value;
      // A reading we could not take is not evidence of a navigation — the step
      // threw, or the round trip expired. That costs this trigger, not the
      // whole probe.
      if (typeof beforeUrl !== 'string') continue;
      if (!sameHoverDocument(beforeUrl, startUrl)) return cancelled(probed);

      const hiddenId = propOf(props, 'hidden')?.objectId;
      const vw = Number(propOf(props, 'vw')?.value ?? 0);
      const vh = Number(propOf(props, 'vh')?.value ?? 0);
      const box: Box = {
        x: Number(propOf(props, 'bx')?.value ?? 0),
        y: Number(propOf(props, 'by')?.value ?? 0),
        width: Number(propOf(props, 'bw')?.value ?? 0),
        height: Number(propOf(props, 'bh')?.value ?? 0),
      };
      if (!hiddenId || !(vw > 0) || !(vh > 0)) continue;
      // Off-screen, or no box to aim at. Scrolling it into view would change
      // the page the snapshot just described, so it is skipped instead.
      if (!(box.width > 0) || !(box.height > 0)) continue;
      if (box.y + box.height <= 0 || box.y >= vh || box.x + box.width <= 0 || box.x >= vw) continue;

      const viewport = { width: vw, height: vh };
      const pointIn = (inside: Box): Point => {
        const aim = clickPointInBox(inside, ctx.rng);
        return {
          x: Math.min(Math.max(aim.x, 0), vw - 1),
          y: Math.min(Math.max(aim.y, 0), vh - 1),
        };
      };
      let target = pointIn(box);
      let neutral = neutralPointFor(box, viewport);

      // --- hover, then restore no matter what ---------------------------
      let reading: AfterReading | null = null;
      try {
        // Approach from the neutral point, always. The path crosses whatever
        // lies between, and crossing another trigger opens ITS menu over the
        // one we are walking to — which then costs a park, a second approach
        // and a second read to recover from. Measured headed, that recovery was
        // 1.5 s, more than half the whole budget, and it is avoidable: the
        // neutral point is by construction not on a trigger.
        if (pointer.x !== neutral.x || pointer.y !== neutral.y) {
          await hopPointer(neutral, slice);
        }
        await movePointer(target, slice);
        probed += 1;

        const waitUntil = Math.min(Date.now() + HOVER_PROBE_LIMITS.REVEAL_WAIT_MS, slice);
        for (;;) {
          reading = await read(candidate, hiddenId, target, HOVER_PROBE_LIMITS.MAX_ITEMS, slice);
          if (!reading) break;
          if (!sameHoverDocument(reading.url, startUrl)) return cancelled(probed);
          if (!reading.ok) {
            // Something is covering the point we aimed at — almost always a menu
            // an earlier leg of the approach opened. One re-approach, from the
            // neutral point so that menu closes first, with the anchor's box
            // re-read in case it moved: the same recompute-once contract
            // browser.rpc.ts's approachElement has.
            if (reading.box) {
              neutral = neutralPointFor(reading.box, viewport);
              target = pointIn(reading.box);
            }
            await hopPointer(neutral, slice);
            await hopPointer(target, slice);
            reading = await read(candidate, hiddenId, target, HOVER_PROBE_LIMITS.MAX_ITEMS, slice);
            if (!reading) break;
            if (!sameHoverDocument(reading.url, startUrl)) return cancelled(probed);
            // Still covered: report nothing rather than whatever is on screen.
            if (!reading.ok) {
              reading = null;
              break;
            }
          }
          if (reading.revealed > 0 || Date.now() >= waitUntil) break;
          await sleep(Math.min(HOVER_PROBE_LIMITS.REVEAL_POLL_MS, Math.max(0, waitUntil - Date.now())));
        }
      } finally {
        // The one allowance past the shared deadline, and only for un-hovering.
        // Bounded by the grace from HERE, and never past the one global grace: a
        // trigger whose slice already expired must not be able to spend the rest
        // of the probe's ceiling on its own un-hover.
        await hopPointer(
          neutral,
          Math.min(graceDeadline, Date.now() + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS),
        );
      }
      if (!reading) continue;

      // --- did it close again? -----------------------------------------
      let staysOpen = false;
      if (reading.revealed > 0) {
        // Bounded by this trigger's slice, and never past the one global grace:
        // a per-trigger grace would multiply by MAX_TRIGGERS and put the worst
        // case well outside the number the tool description promises.
        const closeUntil = Math.min(Date.now() + HOVER_PROBE_LIMITS.CLOSE_WAIT_MS, graceDeadline);
        for (;;) {
          const closed = await read(candidate, hiddenId, neutral, 1, closeUntil);
          if (!closed) break;
          if (!sameHoverDocument(closed.url, startUrl)) return cancelled(probed);
          // The ITEMS, not the reveal count: the note qualifies the names on the
          // line, and a container that is still laid out while its contents are
          // gone is not a menu the agent can still use.
          staysOpen = closed.named > 0;
          if (!staysOpen || Date.now() >= closeUntil) break;
          await sleep(Math.min(HOVER_PROBE_LIMITS.REVEAL_POLL_MS, Math.max(0, closeUntil - Date.now())));
        }
      }

      if (reading.names.length > 0) {
        revealed.set(candidate.backendNodeId, {
          items: reading.names,
          // Against the NAMEABLE count, not everything that appeared: the
          // panel element itself is counted as a reveal and is not an item, so
          // comparing with that would print a `…` on a complete list.
          truncated: reading.named > reading.names.length,
          staysOpen,
        });
      }
    }
  } catch {
    // A detached target, a handle the page invalidated, a CDP domain that went
    // away: keep whatever was already collected for THIS document rather than
    // failing the snapshot the caller actually asked for.
  }

  // The lifecycle check on the way out, from the lane rather than the page:
  // a navigation that completed after the last step's own `url` read would
  // otherwise leave stale names attached to a tree that is about to be rebuilt.
  if (!sameHoverDocument(ctx.currentUrl(), startUrl)) return cancelled(probed);
  // Every marked trigger the caller handed us that has no line to show for it —
  // never got a turn, or was hovered and revealed nothing readable.
  const answerable = candidates.filter((c) => c.backendNodeId !== undefined).length;
  return {
    revealed,
    cancelled: false,
    probed,
    unanswered: Math.max(0, answerable - revealed.size),
  };
}

function cancelled(probed: number): HoverProbeOutcome {
  // A cancelled probe has no answers at all, but the caller already knows why —
  // that is what `cancelled` says — so nothing is reported as merely unanswered.
  return { revealed: new Map(), cancelled: true, probed, unanswered: 0 };
}
