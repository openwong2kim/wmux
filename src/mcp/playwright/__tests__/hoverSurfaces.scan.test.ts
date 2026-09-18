// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildHoverTriggerScanExpression, hoverProbeStep } from '../hoverSurfaces';
import { buildDomSnapshotExpression, readDomSnapshotPayload } from '../dom-intelligence';

// The scan runs in the page, so the only honest test of it runs it in a DOM.
// jsdom has no layout, so the two things every candidate is vetoed on —
// getBoundingClientRect and the computed cursor — are stubbed below. Everything
// else (document.styleSheets, cssRules, querySelectorAll, closest) is real.

/**
 * Give every element a box, and the named selectors a pointer cursor.
 *
 * `data-zero-box` is how "not on screen" is spelled here: jsdom has no layout,
 * so a `display: none` rule in a `<style>` block does not change any geometry
 * the scan can read, and the closed submenus every fixture needs have to be
 * marked explicitly.
 */
function mount(html: string, pointerSelector = '[data-pointer]'): void {
  document.head.innerHTML = '';
  document.body.innerHTML = html;

  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      const hidden = this.getAttribute('data-zero-box') !== null;
      const width = hidden ? 0 : 80;
      const height = hidden ? 0 : 20;
      return { left: 10, top: 10, width, height, right: 10 + width, bottom: 10 + height };
    },
  });
  // The probe step reads visibility through `checkVisibility` alone — a box read
  // forces layout, which is what made it unaffordable in a headed window — and
  // jsdom implements neither, so both stubs answer from the same marker.
  Object.defineProperty(Element.prototype, 'checkVisibility', {
    configurable: true,
    value(this: Element) {
      return this.getAttribute('data-zero-box') === null;
    },
  });

  const realComputed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => {
    const cursor = el.matches?.(pointerSelector) ? 'pointer' : 'auto';
    return { ...realComputed(el), cursor } as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
}

/** A same-origin stylesheet, which is what the scan is allowed to read. */
function style(css: string): void {
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

function scan(): Element[] {
  // eslint-disable-next-line no-eval
  return eval(buildHoverTriggerScanExpression({ elementsOnly: true })) as Element[];
}

describe('the phase-1 scan in a DOM', () => {
  it('finds the element a :hover rule reveals a submenu from', () => {
    mount('<nav><a href="/p" id="products">Products</a><ul id="sub" data-zero-box><li><a href="/a">A</a></li></ul></nav>');
    style('#sub { display: none } #products:hover + #sub { display: block }');

    expect(scan().map((el) => el.id)).toEqual(['products']);
  });

  it('walks into @media, where most hover menus actually live', () => {
    mount('<nav><a href="/p" id="products">Products</a><ul id="sub" data-zero-box></ul></nav>');
    style('@media (hover: hover) { #products:hover + #sub { visibility: visible } }');

    expect(scan().map((el) => el.id)).toEqual(['products']);
  });

  it('[fix] marks only the nav item that actually HAS a submenu', () => {
    // The live-dogfood defect: the hovered selector (`nav li`) matches all three
    // items, and testing it on its own marked About and Contact too. The walk
    // now starts from the hidden `ul.sub` and climbs to ITS parent.
    mount(
      '<nav><ul>' +
        '<li id="li-products"><a href="#p" id="nav-products">Products</a>' +
        '<ul class="sub" data-zero-box><li><a href="#s">Shoes</a></li></ul></li>' +
        '<li id="li-about"><a href="#a" id="nav-about">About</a></li>' +
        '<li id="li-contact"><a href="#c" id="nav-contact">Contact</a></li>' +
        '</ul></nav>',
    );
    style('nav li > ul.sub { display: none } nav li:hover > ul.sub { display: block }');

    // ...and the mark lands on the link, not the listitem: the listitem has no
    // ref, and disappears under filter:"interactive".
    expect(scan().map((el) => el.id)).toEqual(['nav-products']);
  });

  it('[fix] resolves a descendant rule to the NEAREST matching ancestor', () => {
    mount(
      '<div class="menu" id="outer"><div class="menu" id="inner">' +
        '<button id="opener">Open</button><div class="panel" data-zero-box><a href="#x">X</a></div>' +
        '</div></div>',
    );
    style('.menu:hover .panel { display: block }');

    // #inner is the nearest `.menu` above the panel; #outer also matches the
    // selector but is not the element a person hovers to open that panel.
    expect(scan().map((el) => el.id)).toEqual(['opener']);
  });

  it('[fix] resolves a sibling rule backwards from the revealed element', () => {
    mount(
      '<div><button id="b1">One</button><div id="p1" data-zero-box><a href="#1">a</a></div>' +
        '<button id="b2">Two</button><div id="p2" data-zero-box><a href="#2">b</a></div></div>',
    );
    style('button:hover + div { display: block }');

    // Each button owns the panel immediately after it, and neither owns the
    // other's.
    expect(scan().map((el) => el.id).sort()).toEqual(['b1', 'b2']);
  });

  it('[precision] ignores a hover rule whose target is already on screen', () => {
    // The near-universal hover micro-interaction. Without the "is the revealed
    // element actually hidden?" gate this marked every link on the page.
    mount('<nav><a href="/a" id="a1"><svg id="i1"></svg></a><a href="/b" id="a2"><svg id="i2"></svg></a></nav>');
    style('a:hover svg { transform: translateX(2px) }');

    expect(scan()).toEqual([]);
  });

  it('ignores a :hover rule that only restyles the hovered element', () => {
    mount('<a href="/p" id="products">Products</a>');
    style('#products:hover { color: red; opacity: 1 }');

    expect(scan()).toEqual([]);
  });

  it('keeps the marker on the trigger when it has no interactive descendant', () => {
    mount('<div id="wrap"><span>label</span><div class="pop" data-zero-box>hi</div></div>');
    style('#wrap:hover > .pop { display: block }');
    expect(scan().map((el) => el.id)).toEqual(['wrap']);
  });

  it('never picks an anchor from inside the panel it is about to reveal', () => {
    // The submenu's links come FIRST in document order here, and they are
    // hidden — the visible label is what the agent hovers. (A real browser gives
    // a child of a `display:none` parent a zero box on its own; jsdom has no
    // layout, so the marker has to be put on the descendant too. The inherited
    // case is covered against real Chrome in hoverSurfaces.chrome.runtime.test.ts.)
    mount(
      '<li id="li"><ul class="sub" data-zero-box><li><a href="#s" id="sub-link" data-zero-box>Shoes</a></li></ul>' +
        '<a href="#p" id="label">Products</a></li>',
    );
    style('li:hover > ul.sub { display: block }');
    expect(scan().map((el) => el.id)).toEqual(['label']);
  });

  it('marks one line once when a wrapper and its label are both triggers', () => {
    mount(
      '<div id="wrap" aria-haspopup="menu"><a href="#a" id="lbl" aria-haspopup="menu">Account</a>' +
        '<div class="pop" data-zero-box>x</div></div>',
    );
    expect(scan().map((el) => el.id)).toEqual(['lbl']);
  });

  it('takes an aria-haspopup element on the promise alone', () => {
    mount('<button id="account" aria-haspopup="menu">Account</button>');
    expect(scan().map((el) => el.id)).toEqual(['account']);
  });

  it('takes a <summary> but not its <details>, so one disclosure is one line', () => {
    mount('<details id="d"><summary id="s">More</summary><p>body</p></details>');
    expect(scan().map((el) => el.id)).toEqual(['s']);
  });

  it('needs corroboration for aria-expanded alone', () => {
    mount('<button id="plain" aria-expanded="false">Section</button>');
    expect(scan()).toEqual([]);

    // ...and a pointer cursor is enough of it.
    mount('<button id="toggle" aria-expanded="false" data-pointer>Section</button>');
    expect(scan().map((el) => el.id)).toEqual(['toggle']);
  });

  it('never marks a form field, however the stylesheet is written', () => {
    mount('<input id="q" aria-haspopup="listbox"><textarea id="t" aria-haspopup="menu"></textarea>');
    style('#q:hover + #t { display: block }');

    expect(scan()).toEqual([]);
  });

  it('never marks a disabled, aria-disabled or inert trigger', () => {
    mount(
      '<button id="a" aria-haspopup="menu" disabled></button>' +
        '<button id="b" aria-haspopup="menu" aria-disabled="true"></button>' +
        '<div inert><button id="c" aria-haspopup="menu"></button></div>' +
        '<div id="d" contenteditable="true" aria-haspopup="menu"></div>',
    );
    expect(scan()).toEqual([]);
  });

  it('never marks a zero-area trigger — there is nowhere to put the pointer', () => {
    mount('<button id="account" aria-haspopup="menu" data-zero-box>Account</button>');
    expect(scan()).toEqual([]);
  });

  it('survives a stylesheet whose rules cannot be read (a cross-origin sheet)', () => {
    mount('<button id="account" aria-haspopup="menu">Account</button>');
    style('#account:hover + #x { display: block }');
    const sheet = document.styleSheets[0];
    Object.defineProperty(sheet, 'cssRules', {
      configurable: true,
      get() {
        throw new Error('SecurityError: cannot access rules');
      },
    });

    // The ARIA candidate still comes through: one unreadable sheet is not a
    // reason to say nothing about the rest of the page.
    expect(scan().map((el) => el.id)).toEqual(['account']);
  });

  it('survives a page with no stylesheets and no candidates at all', () => {
    mount('<p>text</p>');
    expect(scan()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The probe's in-page step. probeHoverSurfaces drives it over CDP against a
// fake (hoverSurfaces.probe.test.ts), which never evaluates this source — so
// what before/after actually MEAN is pinned here, in a DOM.
// ---------------------------------------------------------------------------

interface BeforePayload {
  url: string;
  vw: number;
  vh: number;
  bx: number;
  by: number;
  bw: number;
  bh: number;
  hidden: Element[];
}

interface AfterPayload {
  url: string;
  ok: boolean;
  names: string[];
  revealed: number;
  named: number;
}

/** The same source string CDP is handed, evaluated here instead. */
const rawStep = new Function(`return (${String(hoverProbeStep)})`)() as (
  this: unknown,
  mode: string,
  arg: unknown,
  extra?: unknown,
  aimJson?: unknown,
) => unknown;

const step = {
  /** `this` = the trigger, `anchor` = what would be hovered. */
  before(trigger: Element, targets: string[], anchor?: Element): BeforePayload {
    return rawStep.call(trigger, 'before', JSON.stringify(targets), anchor) as BeforePayload;
  },
  /** jsdom has no hit testing, so the point is only ever read back as `ok`. */
  after(trigger: Element, hidden: unknown, cap: number, anchor?: Element): AfterPayload {
    return rawStep.call(
      trigger,
      'after',
      hidden,
      anchor ?? trigger,
      JSON.stringify({ x: 0, y: 0, cap }),
    ) as AfterPayload;
  },
};

describe('the probe step in a DOM', () => {
  it('records the trigger box and the interactive elements that are hidden', () => {
    mount('<nav id="t"><ul id="sub" data-zero-box><li><a href="/a" data-zero-box>A</a></li></ul><a href="/b">B</a></nav>');
    const trigger = document.getElementById('t')!;

    const before = step.before(trigger, ['#sub']);
    expect(before.bw).toBe(80);
    expect(before.hidden.map((el) => el.getAttribute('href') ?? el.id)).toEqual(['/a', 'sub']);
    // The link that was already on screen is not in the hidden set, so it can
    // never be reported as something the hover revealed.
    expect(before.hidden.some((el) => el.getAttribute('href') === '/b')).toBe(false);
  });

  it('reports only the hidden elements that are showing now, with their names', () => {
    mount('<nav id="t"><ul id="sub" data-zero-box><li><a href="/a" data-zero-box>Docs</a><a href="/b" data-zero-box aria-label="API ref">x</a></li></ul></nav>');
    const trigger = document.getElementById('t')!;
    const before = step.before(trigger, ['#sub']);

    // Nothing has changed yet: the hover has not happened.
    expect((step.after(trigger, before.hidden, 12)).revealed).toBe(0);

    // The menu opens.
    document.querySelectorAll('[data-zero-box]').forEach((el) => el.removeAttribute('data-zero-box'));
    const after = step.after(trigger, before.hidden, 12);
    // The panel counts as a reveal — that is how "something opened" is known —
    // but it is not an item: its own textContent is every label run together.
    expect(after.revealed).toBe(3);
    expect(after.named).toBe(2);
    expect(after.names).toEqual(['Docs', 'API ref']);
  });

  it('caps the names it returns while still counting what appeared', () => {
    const items = Array.from({ length: 5 }, (_, i) => `<a href="/${i}">Item ${i}</a>`).join('');
    mount(`<nav id="t"><div id="sub">${items}</div></nav>`);
    const trigger = document.getElementById('t')!;
    // Hidden to begin with...
    document.querySelectorAll('#sub a').forEach((el) => el.setAttribute('data-zero-box', ''));
    const before = step.before(trigger, ['#sub']);
    document.querySelectorAll('#sub a').forEach((el) => el.removeAttribute('data-zero-box'));

    const after = step.after(trigger, before.hidden, 2);
    expect(after.names.length).toBe(2);
    // The count is what tells the caller the list was truncated.
    expect(after.revealed).toBe(5);
  });

  it('survives a target selector that will not parse', () => {
    mount('<nav id="t"><a href="/a">A</a></nav>');
    const trigger = document.getElementById('t')!;
    const before = step.before(trigger, ['>>> not a selector']);
    expect(Array.isArray(before.hidden)).toBe(true);
  });

  it('survives target selectors that are not even JSON', () => {
    mount('<nav id="t"><a href="/a">A</a></nav>');
    const trigger = document.getElementById('t')!;
    expect(() => rawStep.call(trigger, 'before', 'not json')).not.toThrow();
  });
});

describe('the DOM interactive listing lane', () => {
  function listing(): string {
    // eslint-disable-next-line no-eval
    return readDomSnapshotPayload(eval(buildDomSnapshotExpression())).text;
  }

  it('appends [has-submenu] to the line of a hover trigger it lists', () => {
    mount(
      '<nav><a href="/p" id="products">Products</a><ul id="sub" data-zero-box></ul>' +
        '<a href="/c" id="contact">Contact</a></nav>',
    );
    style('#products:hover + #sub { display: block }');

    const text = listing();
    expect(text).toMatch(/\[ref=\d+] a .*Products.* \[has-submenu]/);
    // The link next to it is not a trigger and must not be marked.
    expect(text).toMatch(/\[ref=\d+] a .*Contact[^\n]*$/m);
    expect(text.split('\n').filter((l) => l.includes('[has-submenu]')).length).toBe(1);
  });

  it('still produces the listing when the scan cannot run', () => {
    mount('<a href="/p" id="products">Products</a>');
    // A getter that throws stands in for every way the scan can fail: the
    // listing is the caller's answer and must survive losing the annotation.
    Object.defineProperty(document, 'styleSheets', {
      configurable: true,
      get() {
        throw new Error('no sheets here');
      },
    });

    const text = listing();
    expect(text).toContain('Products');
    expect(text).not.toContain('[has-submenu]');
  });
});
