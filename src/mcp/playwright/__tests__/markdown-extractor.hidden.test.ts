// @vitest-environment jsdom
//
// Visibility filtering for browser_extract_text.
//
// The other extractor tests mock the evaluator and never run the in-page
// serialisation script, which is exactly where the noise filter lives. Here the
// evaluator executes the real script against a jsdom document, so a hidden
// element that the script fails to skip shows up in the markdown.
//
// Dogfooding naver.com (2026-08-29) put a hidden browser-promo banner, a
// collapsed search-suggestion layer and a dormant "temporary error"
// placeholder in the first ~600 characters of the extracted text, while
// browser_smart_snapshot (innerText, rendering-aware) stayed clean.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { extractMarkdown } from '../markdown-extractor';

// jsdom has no layout engine: getClientRects() is unconditionally empty, which
// would make the script judge EVERY element hidden. Model layout instead —
// an element renders a box unless it opts out with data-zero-rect (what a real
// browser reports for display:none boxes, `display: contents` wrappers, and
// zero-size collapsed layers).
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    value(this: Element) {
      return this.hasAttribute('data-zero-rect') ? [] : [{ width: 100, height: 20 }];
    },
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** Evaluator that runs the in-page script string the way a browser would. */
const evaluateInJsdom = (expression: string): Promise<unknown> =>
  // Parenthesised on purpose: the script starts with a newline, and `return`
  // followed by a line break is an automatic-semicolon return of undefined.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  Promise.resolve(new Function(`return (${expression});`)());

describe('extractMarkdown — hidden content (browser_extract_text)', () => {
  it('drops display:none, visibility:hidden and zero-rect subtrees', async () => {
    document.body.innerHTML = `
      <div style="display:none"><p>Whale banner promo</p></div>
      <div style="visibility:hidden"><p>Recent search suggestions</p></div>
      <div data-zero-rect><p>A temporary error occurred. Please try again.</p></div>
      <main><h1>Real headline</h1><p>Real body text</p></main>`;

    const md = await extractMarkdown(evaluateInJsdom);

    expect(md).toContain('Real headline');
    expect(md).toContain('Real body text');
    expect(md).not.toContain('Whale banner promo');
    expect(md).not.toContain('Recent search suggestions');
    expect(md).not.toContain('A temporary error occurred');
  });

  it('keeps a display:contents wrapper — it has no box, its children still render', async () => {
    document.body.innerHTML = `
      <div style="display:contents" data-zero-rect><p>Wrapped but rendered</p></div>`;

    expect(await extractMarkdown(evaluateInJsdom)).toContain('Wrapped but rendered');
  });

  it('still extracts a hidden ancestor-free page unchanged', async () => {
    document.body.innerHTML = `<main><h2>Section</h2><p>Visible paragraph</p></main>`;

    const md = await extractMarkdown(evaluateInJsdom);

    expect(md).toContain('## Section');
    expect(md).toContain('Visible paragraph');
  });

  it('honours the selector scope while still filtering inside it', async () => {
    document.body.innerHTML = `
      <article id="post">
        <p style="display:none">Hidden inside scope</p>
        <p>Kept inside scope</p>
      </article>
      <p>Outside the scope</p>`;

    const md = await extractMarkdown(evaluateInJsdom, { selector: '#post' });

    expect(md).toContain('Kept inside scope');
    expect(md).not.toContain('Hidden inside scope');
    expect(md).not.toContain('Outside the scope');
  });
});
