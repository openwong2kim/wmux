// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildPageFactsExpression, type PageFacts } from '../pageFacts';

// The collector runs in the page, so the only honest test of it runs it in a
// DOM. jsdom has no layout, so the geometry every rule reads — scrollHeight,
// clientHeight, computed overflow — is stubbed per element below.

function makeScrollable(el: Element, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.setAttribute('data-overflow', 'auto');
}

/** Build the DOM once, let the caller stub geometry, then run the collector. */
function mount(html: string): void {
  document.body.innerHTML = html;
  const realComputed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => {
    const overflowY = el.getAttribute?.('data-overflow') ?? 'visible';
    return { ...realComputed(el), overflowY } as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
}

function collect(): PageFacts {
  // eslint-disable-next-line no-eval
  return eval(buildPageFactsExpression()) as PageFacts;
}

function $(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

describe('pageFacts collector in a DOM', () => {
  it('[fix] reports an inner container even though the page itself scrolls', () => {
    mount('<div id="feed"><p>rows</p></div>');
    makeScrollable(document.documentElement, 9000, 800);
    makeScrollable(document.body, 9000, 800);
    makeScrollable($('#feed'), 4000, 400);

    const selectors = collect().scrollables.map((s) => s.selector);
    expect(selectors).toContain('#feed');
    // The page itself is not listed as a container — browser_scroll already
    // scrolls the page by default.
    expect(selectors).not.toContain('body');
    expect(selectors).not.toContain('html');
  });

  it('emits selectors that resolve to exactly one element', () => {
    mount('<section><div class="pane"><p>a</p></div><div class="pane"><p>b</p></div></section>');
    document.querySelectorAll('.pane').forEach((p) => makeScrollable(p, 3000, 300));

    const facts = collect();
    expect(facts.scrollables.length).toBe(2);
    for (const s of facts.scrollables) {
      expect(document.querySelectorAll(s.selector).length).toBe(1);
    }
  });

  it('omits a scroller nested inside another scroller', () => {
    mount('<div id="outer"><div id="inner"><p>x</p></div></div>');
    makeScrollable($('#outer'), 5000, 500);
    makeScrollable($('#inner'), 4000, 400);

    const selectors = collect().scrollables.map((s) => s.selector);
    expect(selectors).toContain('#outer');
    expect(selectors).not.toContain('#inner');
  });

  it('counts interactive elements and text for the readiness verdict', () => {
    mount('<button>Go</button><a href="#x">link</a><p>some text</p>');
    const facts = collect();
    expect(facts.interactiveElements).toBe(2);
    expect(facts.totalElements).toBeGreaterThan(2);
  });
});
