// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { uploadLookupExpression } from '../browserUpload';

// The lookup runs inside the page, so it is evaluated here against a real DOM,
// shadow roots included: a styled uploader is often a web component.

/** Evaluates the exact expression main injects. */
function lookup(selector: string, near: boolean): unknown {
  return new Function('document', `return ${uploadLookupExpression(selector, near)}`)(document);
}

/** A host element whose open (or closed) shadow root holds `html`. */
function shadowHost(html: string, mode: 'open' | 'closed' = 'open'): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode });
  root.innerHTML = html;
  return root;
}

const idOf = (node: unknown): string | null => (node as { id?: string } | null)?.id ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the upload lookup reaches into open shadow roots', () => {
  it('finds a ref anchor and the input beside it inside a web component', () => {
    shadowHost('<div><button id="pick" data-wmux-ref="7">Choose</button><input id="hidden" type="file" hidden></div>');
    expect(idOf(lookup('[data-wmux-ref="7"]', true))).toBe('hidden');
  });

  it('finds the default file input inside a shadow root', () => {
    shadowHost('<input id="inner" type="file">');
    expect(idOf(lookup('input[type="file"]', false))).toBe('inner');
  });

  it('finds a caller selector that only matches inside a shadow root, nested twice', () => {
    const outer = shadowHost('<section id="wrap"></section>');
    const host = document.createElement('div');
    outer.getElementById('wrap')?.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<input id="deep" type="file" class="upl">';
    expect(idOf(lookup('input.upl', false))).toBe('deep');
  });

  it('prefers the document over shadow roots for the first match', () => {
    document.body.innerHTML = '<input id="top" type="file">';
    shadowHost('<input id="inner" type="file">');
    expect(idOf(lookup('input[type="file"]', false))).toBe('top');
  });

  it('still refuses a ref anchor found more than once, counted across every root', () => {
    document.body.innerHTML = '<button data-wmux-upload="n">a</button>';
    shadowHost('<button data-wmux-upload="n">b</button><input type="file">');
    expect(lookup('[data-wmux-upload="n"]', true)).toBe('many');
  });

  it('does not reach into a closed shadow root', () => {
    shadowHost('<input id="sealed" type="file">', 'closed');
    expect(lookup('input[type="file"]', false)).toBe('none');
  });
});
