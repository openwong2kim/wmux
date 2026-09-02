import { describe, expect, it } from 'vitest';
import { refererFor } from '../referer';

describe('refererFor', () => {
  it('sends the current page when leaving a real http(s) document', () => {
    expect(refererFor('https://example.com/a', 'https://example.com/b')).toBe(
      'https://example.com/a',
    );
    expect(refererFor('http://localhost:3000/one', 'http://localhost:3000/two')).toBe(
      'http://localhost:3000/one',
    );
  });

  it('sends it across origins too, which is what a real click-through does', () => {
    expect(refererFor('https://news.example/list', 'https://other.example/post')).toBe(
      'https://news.example/list',
    );
  });

  it('sends nothing on a first navigation', () => {
    expect(refererFor(undefined, 'https://example.com')).toBeUndefined();
    expect(refererFor(null, 'https://example.com')).toBeUndefined();
    expect(refererFor('', 'https://example.com')).toBeUndefined();
  });

  it('sends nothing from about:blank or a browser-internal page', () => {
    expect(refererFor('about:blank', 'https://example.com')).toBeUndefined();
    expect(refererFor('chrome://newtab/', 'https://example.com')).toBeUndefined();
    expect(refererFor('devtools://devtools/x.html', 'https://example.com')).toBeUndefined();
    expect(refererFor('file:///tmp/page.html', 'https://example.com')).toBeUndefined();
    expect(refererFor('data:text/html,<p>x', 'https://example.com')).toBeUndefined();
  });

  it('sends nothing when the current URL is not parseable', () => {
    expect(refererFor('not a url', 'https://example.com')).toBeUndefined();
    expect(refererFor('/relative/path', 'https://example.com')).toBeUndefined();
  });

  it('sends nothing when reloading the same URL', () => {
    expect(refererFor('https://example.com/a', 'https://example.com/a')).toBeUndefined();
  });
});
