import { describe, expect, it } from 'vitest';
import {
  HOVER_SCAN_LIMITS,
  HOVER_TRIGGER_SCORE_THRESHOLD,
  buildHoverTriggerScanExpression,
  classifyHoverRule,
  formatHoverItems,
  hoverMenusNote,
  isHoverTriggerEligible,
  scanBudgetExhausted,
  scoreHoverTrigger,
  type HoverTriggerSignals,
} from '../hoverSurfaces';

// ---------------------------------------------------------------------------
// The CSS rule classifier.
//
// Every case here is a precision case: a wrong `has-submenu` tells the agent to
// hover a plain link and wait for a menu that was never there, which is worse
// than the status quo (no marker at all, and the agent moves on).
// ---------------------------------------------------------------------------

/** `trigger>target` for terse table rows. */
function pairs(selectorText: string, props: string[]): string[] {
  return classifyHoverRule(selectorText, props).map((m) => `${m.trigger}>${m.target}`);
}

describe('classifyHoverRule: the combinator', () => {
  // It is what ties a revealed element back to its OWN trigger, so reading it
  // wrong sends hoverTriggerForRevealed looking in the wrong place.
  const TABLE: [string, string][] = [
    ['.a:hover > .b', '>'],
    ['.a:hover>.b', '>'],
    ['.a:hover + .b', '+'],
    ['.a:hover ~ .b', '~'],
    ['.a:hover .b', ' '],
    ['.a:hover\t.b', ' '],
    // Whitespace around an explicit combinator is not the combinator.
    ['.a:hover   >   .b', '>'],
  ];
  for (const [selector, combinator] of TABLE) {
    it(`reads ${JSON.stringify(selector)} as ${JSON.stringify(combinator)}`, () => {
      expect(classifyHoverRule(selector, ['display'])[0]?.combinator).toBe(combinator);
    });
  }
});

describe('classifyHoverRule: what counts as a hover-revealed submenu', () => {
  const REVEALS: [string, string[], string[]][] = [
    // [selector, declared properties, expected trigger>target pairs]
    ['.nav li:hover > .submenu', ['display'], ['.nav li>.nav li > .submenu']],
    ['.a:hover .b', ['opacity'], ['.a>.a .b']],
    ['.a:hover + .b', ['transform'], ['.a>.a + .b']],
    ['.a:hover ~ .b', ['clip-path'], ['.a>.a ~ .b']],
    ['.a:hover\t.b', ['max-height'], ['.a>.a\t.b']],
    // Only one of the declared properties has to be a revealing one.
    ['.a:hover .b', ['color', 'font-weight', 'visibility'], ['.a>.a .b']],
    // Pseudo-classes are ASCII case-insensitive, and so are property names.
    ['.A:HOVER .b', ['DISPLAY'], ['.A>.A .b']],
    // A functional pseudo-class in the trigger is part of the trigger.
    ['.a:has(.b):hover .c', ['pointer-events'], ['.a:has(.b)>.a:has(.b) .c']],
    // The LAST top-level :hover is the one the revealed element hangs off.
    ['.a:hover .b:hover .c', ['height'], ['.a .b>.a .b .c']],
    // A selector list contributes one match per qualifying part.
    ['.a:hover .x, .b:hover .y', ['display'], ['.a>.a .x', '.b>.b .y']],
    ['.a:hover .x, .b:focus-within .y', ['display'], ['.a>.a .x']],
    // A comma inside :is() does not start a new selector.
    [':is(.a, .b):hover .m', ['display'], [':is(.a, .b)>:is(.a, .b) .m']],
  ];

  for (const [selector, props, expected] of REVEALS) {
    it(`reads ${JSON.stringify(selector)} { ${props.join(',')} } as ${expected.length} trigger(s)`, () => {
      expect(pairs(selector, props)).toEqual(expected);
    });
  }

  const IGNORES: [string, string[], string][] = [
    // [selector, declared properties, why it must produce nothing]
    ['a:hover', ['color'], 'a hover restyle of the hovered element'],
    ['a:hover', ['display'], 'no combinator — the rule is about the hovered element itself'],
    ['.a:hover::after', ['opacity'], 'a pseudo-ELEMENT is not a submenu and cannot be hovered'],
    ['.a:hover .b', ['color', 'background'], 'nothing that can hide or show an element'],
    ['.a:hover >', ['display'], 'a dangling combinator names no revealed element'],
    [':hover .m', ['display'], 'no element to put the pointer on'],
    ['.a > :hover .m', ['display'], 'the trigger would end in a dangling combinator'],
    ['li:not(:hover) .m', ['display'], ':hover inside :not() is a condition, not the hovered element'],
    ['.a:has(.b:hover) .m', ['display'], 'same, inside :has()'],
    ['[title=":hover"] .m', ['display'], 'a :hover inside an attribute value is text'],
    ['.a:hovered .m', ['display'], ':hovered is a different pseudo-class'],
    ['.a:hover-card .m', ['display'], 'so is :hover-card'],
    ['.a::hover .m', ['display'], '::hover is not a pseudo-class at all'],
    ['', ['display'], 'no selector'],
  ];

  for (const [selector, props, why] of IGNORES) {
    it(`ignores ${JSON.stringify(selector)} { ${props.join(',')} } — ${why}`, () => {
      expect(classifyHoverRule(selector, props)).toEqual([]);
    });
  }

  it('refuses a selector long enough to be pathological rather than running it', () => {
    const huge = `${'.x'.repeat(200)}:hover .menu`;
    expect(classifyHoverRule(huge, ['display'])).toEqual([]);
  });

  it('survives a non-string selector and a missing property list', () => {
    expect(classifyHoverRule(undefined as never, ['display'])).toEqual([]);
    expect(classifyHoverRule('.a:hover .b', undefined as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The scorer.
// ---------------------------------------------------------------------------

function signals(over: Partial<HoverTriggerSignals> = {}): HoverTriggerSignals {
  return {
    cssRule: false,
    ariaHaspopup: false,
    ariaExpanded: false,
    nativeDisclosure: false,
    nameHint: false,
    cursorPointer: false,
    visible: true,
    hasArea: true,
    ...over,
  };
}

describe('scoreHoverTrigger: which signals are enough to mark an element', () => {
  const MARKED: [string, Partial<HoverTriggerSignals>][] = [
    ['a stylesheet that reveals another element', { cssRule: true }],
    ['an aria-haspopup promise', { ariaHaspopup: true }],
    ['a native <summary>', { nativeDisclosure: true }],
    ['a menu-ish name AND a pointer cursor', { nameHint: true, cursorPointer: true }],
    ['aria-expanded AND a pointer cursor', { ariaExpanded: true, cursorPointer: true }],
  ];
  for (const [why, over] of MARKED) {
    it(`marks on ${why}`, () => {
      expect(scoreHoverTrigger(signals(over))).toBeGreaterThanOrEqual(
        HOVER_TRIGGER_SCORE_THRESHOLD,
      );
    });
  }

  const UNMARKED: [string, Partial<HoverTriggerSignals>][] = [
    ['nothing at all', {}],
    ['a pointer cursor alone — every card in every grid has one', { cursorPointer: true }],
    ['a name hint alone — .more is a class name on plain links too', { nameHint: true }],
    ['aria-expanded alone — accordions and toggles carry one', { ariaExpanded: true }],
  ];
  for (const [why, over] of UNMARKED) {
    it(`stays quiet on ${why}`, () => {
      expect(scoreHoverTrigger(signals(over))).toBeLessThan(HOVER_TRIGGER_SCORE_THRESHOLD);
    });
  }

  it('lets invisibility and a zero box veto every combination of hints', () => {
    const everything = signals({
      cssRule: true,
      ariaHaspopup: true,
      nativeDisclosure: true,
      ariaExpanded: true,
      nameHint: true,
      cursorPointer: true,
    });
    expect(scoreHoverTrigger({ ...everything, visible: false, hasArea: false })).toBeLessThan(
      HOVER_TRIGGER_SCORE_THRESHOLD,
    );
  });

  it('keeps a single strong signal from surviving a veto on its own', () => {
    expect(scoreHoverTrigger(signals({ cssRule: true, visible: false }))).toBeLessThan(
      HOVER_TRIGGER_SCORE_THRESHOLD,
    );
    expect(scoreHoverTrigger(signals({ cssRule: true, hasArea: false }))).toBeLessThan(
      HOVER_TRIGGER_SCORE_THRESHOLD,
    );
  });
});

// ---------------------------------------------------------------------------
// The exclusions.
// ---------------------------------------------------------------------------

describe('isHoverTriggerEligible: element kinds that are never marked', () => {
  const base = {
    tagName: 'div',
    disabled: false,
    ariaDisabled: false,
    inert: false,
    contentEditable: false,
  };

  it('accepts an ordinary element', () => {
    expect(isHoverTriggerEligible(base)).toBe(true);
    expect(isHoverTriggerEligible({ ...base, tagName: 'BUTTON' })).toBe(true);
    expect(isHoverTriggerEligible({ ...base, tagName: 'summary' })).toBe(true);
  });

  for (const tagName of ['input', 'textarea', 'select', 'option', 'INPUT', 'Select']) {
    it(`never marks <${tagName}>`, () => {
      expect(isHoverTriggerEligible({ ...base, tagName })).toBe(false);
    });
  }

  for (const key of ['disabled', 'ariaDisabled', 'inert', 'contentEditable'] as const) {
    it(`never marks a ${key} element`, () => {
      expect(isHoverTriggerEligible({ ...base, [key]: true })).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// The scan bound.
// ---------------------------------------------------------------------------

describe('scanBudgetExhausted: the phase-1 bound', () => {
  const { MAX_CSS_RULES, SCAN_BUDGET_MS } = HOVER_SCAN_LIMITS;

  const TABLE: [number, number, boolean][] = [
    [0, 0, false],
    [MAX_CSS_RULES - 1, 0, false],
    [MAX_CSS_RULES, 0, true],
    [MAX_CSS_RULES + 1, 0, true],
    [0, SCAN_BUDGET_MS - 1, false],
    [0, SCAN_BUDGET_MS, true],
    [0, SCAN_BUDGET_MS + 500, true],
    // Either half is enough on its own.
    [MAX_CSS_RULES, SCAN_BUDGET_MS, true],
  ];

  for (const [rules, elapsed, expected] of TABLE) {
    it(`${rules} rules / ${elapsed} ms is ${expected ? '' : 'not '}exhausted`, () => {
      expect(scanBudgetExhausted(rules, elapsed)).toBe(expected);
    });
  }

  it('keeps the published limits in step with the predicate that enforces them', () => {
    // The predicate is stringified into the page and cannot read the constants,
    // so they are two spellings of one number. This is the tripwire for a drift.
    expect(scanBudgetExhausted(MAX_CSS_RULES, 0)).toBe(true);
    expect(scanBudgetExhausted(MAX_CSS_RULES - 1, SCAN_BUDGET_MS - 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Line and footer text.
// ---------------------------------------------------------------------------

describe('formatHoverItems', () => {
  it('says nothing without a mark, and nothing on a phase-1-only mark', () => {
    expect(formatHoverItems(undefined)).toBe('');
    expect(formatHoverItems({ items: [], truncated: false, staysOpen: false })).toBe('');
  });

  it('lists the names it saw', () => {
    expect(formatHoverItems({ items: ['Docs', 'API'], truncated: false, staysOpen: false })).toBe(
      ' [hover first: Docs | API]',
    );
  });

  it('marks a truncated list with an ellipsis and only then', () => {
    expect(formatHoverItems({ items: ['Docs'], truncated: true, staysOpen: false })).toBe(
      ' [hover first: Docs | …]',
    );
  });

  it('warns when the surface did not close again', () => {
    expect(formatHoverItems({ items: ['Docs'], truncated: false, staysOpen: true })).toBe(
      ' [hover first: Docs | stays open]',
    );
  });

  it('never says "stays open" about a hover that revealed nothing', () => {
    expect(formatHoverItems({ items: [], truncated: false, staysOpen: true })).toBe('');
  });
});

describe('hoverMenusNote', () => {
  it('is empty when nothing was marked', () => {
    expect(hoverMenusNote(0)).toBe('');
    expect(hoverMenusNote(-1)).toBe('');
  });

  it('names the count and the flag that lists the items', () => {
    // No leading newline: it joins the snapshot's leading-note block, which
    // does its own separating.
    expect(hoverMenusNote(3)).toBe(
      'hover menus: 3 triggers marked has-submenu; pass probeHover:true to list their items',
    );
  });
});

// ---------------------------------------------------------------------------
// The generated scan source.
// ---------------------------------------------------------------------------

describe('buildHoverTriggerScanExpression', () => {
  it('marks the anchor and hovers the trigger, and says which is which', () => {
    const expr = buildHoverTriggerScanExpression();
    expect(expr).toContain('els:');
    expect(expr).toContain('anchors:');
    // The DOM listing can only use the elements it is about to list, so it gets
    // the anchors.
    expect(buildHoverTriggerScanExpression({ elementsOnly: true })).toContain(
      'picked.map((c) => c.anchor)',
    );
  });

  it('is a syntactically valid, self-contained expression in both shapes', () => {
    // A stringified helper that referenced a module-scope name would throw
    // here as a ReferenceError only when it RAN; a parse check at least pins
    // that the assembled text is a single evaluable expression.
    expect(() => new Function(`return ${buildHoverTriggerScanExpression()}`)).not.toThrow();
    expect(() =>
      new Function(`return ${buildHoverTriggerScanExpression({ elementsOnly: true })}`),
    ).not.toThrow();
  });

  it('carries the rules, not a second copy of them', () => {
    const expr = buildHoverTriggerScanExpression();
    expect(expr).toContain('classifyHoverRule');
    expect(expr).toContain('isHoverTriggerEligible');
    expect(expr).toContain('scoreHoverTrigger');
    expect(expr).toContain('scanBudgetExhausted');
    // Cross-origin sheets throw on cssRules and must be skipped, not fatal.
    expect(expr).toContain('cross-origin');
  });

  it('returns handles plus meta by default, and bare elements on request', () => {
    expect(buildHoverTriggerScanExpression()).toContain('meta:');
    expect(buildHoverTriggerScanExpression({ elementsOnly: true })).not.toContain('meta:');
  });
});
