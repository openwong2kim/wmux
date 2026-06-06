// @vitest-environment jsdom
//
// DOM-level tests for extractStructuredData (browser_extract_data), issue #110.
//
// The other extractor tests mock page.evaluate and never run the in-page DOM
// logic, so the field-mapping bug (#110) was invisible to them. Here we run the
// real in-page callbacks against a jsdom document by making page.evaluate call
// the function directly — exactly how Playwright runs it natively. This is the
// regression coverage for the "every field gets the same row metadata" bug.
import { describe, it, expect, beforeAll } from 'vitest';
import { extractStructuredData } from '../markdown-extractor';

// jsdom does not expose the global CSS object, but real browsers (where the
// in-page extraction code actually runs) do. The repeated-element strategy
// calls CSS.escape when building selectors, so provide a minimal polyfill for
// the test environment. Class names in these fixtures are alphanumeric.
beforeAll(() => {
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (!g.CSS) g.CSS = {};
  if (!g.CSS.escape) {
    g.CSS.escape = (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }
});

// A Page whose evaluate runs the in-page function directly against jsdom's
// document — the same fn(arg) Playwright would run inside the browser.
const directPage = {
  evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)),
} as never;

/** Build an HN-front-page-shaped layout: nested tables, no real header row,
 *  each story is a <tr class="athing"> with a vote anchor + title link, plus a
 *  following subtext row. This is the exact structure that triggered #110. */
function hnLikeHtml(): string {
  const story = (id: number, title: string, url: string) => `
    <tr class="athing" id="${id}">
      <td class="title"><span class="rank">${id}.</span></td>
      <td class="votelinks"><a href="vote?id=${id}&how=up"></a></td>
      <td class="title"><span class="titleline"><a href="${url}">${title}</a><span class="sitebit"> (<a href="from?site=x">x.test</a>)</span></span></td>
    </tr>
    <tr><td class="subtext"><span class="subline"><span class="score">${id * 10} points</span> by <a href="user?id=u${id}">u${id}</a> <a href="item?id=${id}">${id} comments</a></span></td></tr>`;
  return `
    <table><tr><td>Hacker News new | past | comments</td><td></td></tr></table>
    <table id="hnmain"><tr><td>
      <table>
        ${story(1, 'First story about widgets', 'https://a.test/first')}
        ${story(2, 'Second story about gadgets', 'https://b.test/second')}
        ${story(3, 'Third story about gizmos', 'https://c.test/third')}
      </table>
    </td></tr></table>`;
}

describe('extractStructuredData — DOM field mapping (#110)', () => {
  it('HN-style layout table maps title->link text and url->href (not duplicated subtext)', async () => {
    document.body.innerHTML = hnLikeHtml();

    const out = (await extractStructuredData(directPage, undefined, 'front page stories', {
      title: 'string',
      url: 'string',
    })) as Array<{ title: unknown; url: unknown }>;

    // We should get one record per story, not per nav cell / rank / subtext row.
    expect(out.length).toBe(3);

    for (const rec of out) {
      // The core #110 bug: title and url were identical (both the subtext line).
      expect(rec.title).not.toBe(rec.url);
      // title is the link text, url is the href.
      expect(rec.title).toMatch(/story about/);
      expect(String(rec.url)).toMatch(/^https:\/\//);
      // url must NOT be the points/comments subtext that the old code returned.
      expect(String(rec.url)).not.toMatch(/points|comments/);
    }

    expect(out[0].title).toBe('First story about widgets');
    expect(out[0].url).toBe('https://a.test/first');
  });

  it('real data table with th headers maps each field to its own column and reads url hrefs', async () => {
    document.body.innerHTML = `
      <table>
        <tr><th>Title</th><th>Price</th><th>URL</th></tr>
        <tr><td>Widget</td><td>$10</td><td><a href="https://shop.test/widget">buy</a></td></tr>
        <tr><td>Gadget</td><td>$20</td><td><a href="https://shop.test/gadget">buy</a></td></tr>
      </table>`;

    const out = (await extractStructuredData(directPage, undefined, 'products', {
      title: 'string',
      price: 'string',
      url: 'string',
    })) as Array<{ title: unknown; price: unknown; url: unknown }>;

    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ title: 'Widget', price: '$10', url: 'https://shop.test/widget' });
    expect(out[1].url).toBe('https://shop.test/gadget');
    // url column resolves to the href, not the anchor's "buy" text.
    expect(out[1].url).not.toBe('buy');
  });

  it('does not collapse fields onto a blank header column', async () => {
    // A table whose first row has a blank cell. The old partial-match used
    // lower.includes('') === true and mapped every field to column 0.
    document.body.innerHTML = `
      <table>
        <tr><td></td><td>Name</td><td>Link</td></tr>
        <tr><td>1</td><td>Alpha</td><td><a href="https://x.test/a">a</a></td></tr>
        <tr><td>2</td><td>Beta</td><td><a href="https://x.test/b">b</a></td></tr>
      </table>`;

    const out = (await extractStructuredData(directPage, undefined, 'rows', {
      name: 'string',
      link: 'string',
    })) as Array<{ name: unknown; link: unknown }>;

    expect(out.length).toBe(2);
    for (const rec of out) {
      expect(rec.name).not.toBe(rec.link);
    }
    expect(out[0].name).toBe('Alpha');
    expect(out[0].link).toBe('https://x.test/a');
  });

  it('repeated card divs still map heading title and anchor url (regression)', async () => {
    document.body.innerHTML = `
      <div class="grid">
        <div class="card"><h3>Card One</h3><span class="price">$5</span><a href="https://p.test/1">view</a></div>
        <div class="card"><h3>Card Two</h3><span class="price">$6</span><a href="https://p.test/2">view</a></div>
        <div class="card"><h3>Card Three</h3><span class="price">$7</span><a href="https://p.test/3">view</a></div>
      </div>`;

    const out = (await extractStructuredData(directPage, undefined, 'cards', {
      title: 'string',
      price: 'string',
      url: 'string',
    })) as Array<{ title: unknown; price: unknown; url: unknown }>;

    expect(out.length).toBe(3);
    expect(out[0]).toMatchObject({ title: 'Card One', price: '$5', url: 'https://p.test/1' });
    expect(out[2].title).toBe('Card Three');
  });

  it('card with a class-hinted name and a CTA link maps name to the class, not the link', async () => {
    // Regression for the #112 review: a non-table card like
    // <span class="name">Widget</span><a>Buy</a> must map name -> "Widget"
    // (the class hint), not "Buy" (the call-to-action link). The primary-link
    // fallback is reserved for table-row link lists (HN-style) where the class
    // cell is a rank/badge.
    document.body.innerHTML = `
      <div class="grid">
        <div class="item"><span class="name">Widget</span><a href="https://shop.test/w">Buy</a></div>
        <div class="item"><span class="name">Gadget</span><a href="https://shop.test/g">Buy</a></div>
        <div class="item"><span class="name">Gizmo</span><a href="https://shop.test/z">Buy</a></div>
      </div>`;
    const out = (await extractStructuredData(directPage, undefined, 'items', {
      name: 'string',
      url: 'string',
    })) as Array<{ name: unknown; url: unknown }>;

    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]).toMatchObject({ name: 'Widget', url: 'https://shop.test/w' });
    expect(out[1].name).toBe('Gadget');
  });
});
