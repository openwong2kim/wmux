// @vitest-environment jsdom
//
// Skip-link filtering for browser_extract_text (issue #1077).
//
// Like the hidden-content tests, the evaluator here runs the real in-page
// serialisation script against a jsdom document, because that is where the
// filter lives.
//
// Dogfooding naver.com (2026-08-29) opened the extracted markdown with eight
// "바로가기" skip links and pushed the first headline past character 440, so a
// caller previewing the first few hundred characters saw an empty page. The
// risk in filtering them is over-removal: a table of contents and a footnote
// reference are the same `a[href^="#"]` shape, so these tests pin both sides.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { extractMarkdown } from '../markdown-extractor';

// jsdom has no layout engine: getClientRects() is unconditionally empty, which
// would make the script judge EVERY element hidden. Model layout instead —
// an element renders a box unless it opts out with data-zero-rect.
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

describe('extractMarkdown — leading skip links (browser_extract_text)', () => {
  it('drops the naver-shaped block of skip links, dangling target included', async () => {
    // One <div> of bare anchors ahead of everything, exactly as naver.com
    // ships it. #viewSetting matches no element on the real page either.
    document.body.innerHTML = `
      <div>
        <a href="#topAsideButton">상단영역 바로가기</a>
        <a href="#shortcutArea">서비스 메뉴 바로가기</a>
        <a href="#viewSetting">보기 설정 바로가기</a>
      </div>
      <div id="topAsideButton"></div>
      <div id="shortcutArea"></div>
      <main><p>정부, 오늘 합동신속대응팀 9명 추가 파견</p></main>`;

    const md = await extractMarkdown(evaluateInJsdom);

    expect(md).not.toContain('바로가기');
    expect(md.startsWith('정부, 오늘')).toBe(true);
  });

  it('drops skip links wrapped in a list, the way MDN ships them', async () => {
    document.body.innerHTML = `
      <ul>
        <li><a href="#content">Skip to main content</a></li>
        <li><a href="#search">Skip to search</a></li>
      </ul>
      <main id="content"><h1>Element: getClientRects() method</h1></main>`;

    const md = await extractMarkdown(evaluateInJsdom);

    expect(md).not.toContain('Skip to');
    expect(md.startsWith('# Element: getClientRects() method')).toBe(true);
  });

  it('keeps a table of contents that follows the page heading', async () => {
    document.body.innerHTML = `
      <a href="#main">Skip to content</a>
      <main id="main">
        <h1>Built-in Functions</h1>
        <ul>
          <li><a href="#abs">abs()</a></li>
          <li><a href="#all">all()</a></li>
        </ul>
        <dl id="abs"><dt>abs(x)</dt></dl>
      </main>`;

    const md = await extractMarkdown(evaluateInJsdom, { includeLinks: true });

    expect(md).not.toContain('Skip to content');
    expect(md).toContain('[abs()](#abs)');
    expect(md).toContain('[all()](#all)');
  });

  it('keeps a table of contents that leads the page — its entries name headings', async () => {
    document.body.innerHTML = `
      <ul>
        <li><a href="#install">Installation</a></li>
        <li><a href="#usage">Usage</a></li>
      </ul>
      <h2 id="install">Installation</h2>
      <p>Run the installer.</p>
      <h2 id="usage">Usage</h2>`;

    const md = await extractMarkdown(evaluateInJsdom, { includeLinks: true });

    expect(md).toContain('[Installation](#install)');
    expect(md).toContain('[Usage](#usage)');
  });

  it('keeps an in-page anchor that opens the first paragraph', async () => {
    document.body.innerHTML = `
      <main>
        <p><a href="#note1">See note 1</a> before reading the rest of this.</p>
      </main>
      <p id="note1">Note 1</p>`;

    expect(await extractMarkdown(evaluateInJsdom, { includeLinks: true })).toContain(
      '[See note 1](#note1)',
    );
  });

  it('leaves a run longer than the skip-link cap alone', async () => {
    const entries = Array.from(
      { length: 13 },
      (_, i) => `<a href="#s${i}">Section ${i}</a>`,
    ).join('');
    document.body.innerHTML = `<div>${entries}</div><div id="s0">Body</div>`;

    const md = await extractMarkdown(evaluateInJsdom, { includeLinks: true });

    expect(md).toContain('[Section 0](#s0)');
    expect(md).toContain('[Section 12](#s12)');
  });

  it('sees past a hidden banner sitting above the skip links', async () => {
    document.body.innerHTML = `
      <div style="display:none"><p>Whale banner promo</p></div>
      <a href="#main">Skip to content</a>
      <main id="main"><p>Real body text</p></main>`;

    const md = await extractMarkdown(evaluateInJsdom);

    expect(md).not.toContain('Skip to content');
    expect(md).toContain('Real body text');
  });

  // browser_extract_text documents includeLinks as defaulting to false, and the
  // extractor used to default it to true — an agent that omitted the flag was
  // billed for every href on the page.
  it('omits hrefs when includeLinks is not asked for', async () => {
    document.body.innerHTML = `
      <main>
        <p><a href="https://example.test/next">Next page</a></p>
      </main>`;

    const md = await extractMarkdown(evaluateInJsdom);

    expect(md).toContain('Next page');
    expect(md).not.toContain('https://example.test/next');
  });

  it('leaves a page without skip links untouched', async () => {
    document.body.innerHTML = `
      <main>
        <h1>Plain article</h1>
        <p>First paragraph.</p>
        <p><a href="https://example.test/next">Next page</a></p>
      </main>`;

    const md = await extractMarkdown(evaluateInJsdom, { includeLinks: true });

    expect(md).toContain('# Plain article');
    expect(md).toContain('First paragraph.');
    expect(md).toContain('[Next page](https://example.test/next)');
  });
});
