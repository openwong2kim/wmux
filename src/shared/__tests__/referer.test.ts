import { describe, expect, it } from 'vitest';
import { refererFor } from '../referer';

describe('refererFor', () => {
  it('sends the full URL within one origin', () => {
    expect(refererFor('https://example.com/a', 'https://example.com/b')).toBe(
      'https://example.com/a',
    );
    expect(refererFor('http://localhost:3000/one', 'http://localhost:3000/two')).toBe(
      'http://localhost:3000/one',
    );
    // The query is part of the URL and stays within the origin.
    expect(refererFor('https://example.com/a?q=1', 'https://example.com/b')).toBe(
      'https://example.com/a?q=1',
    );
  });

  it('sends only the origin across origins, as strict-origin-when-cross-origin does', () => {
    expect(refererFor('https://news.example/list?page=2', 'https://other.example/post')).toBe(
      'https://news.example/',
    );
    // A different port or scheme is a different origin.
    expect(refererFor('http://example.com:8080/a', 'http://example.com/b')).toBe(
      'http://example.com:8080/',
    );
  });

  it('sends nothing when downgrading https to http', () => {
    expect(refererFor('https://example.com/a', 'http://example.com/b')).toBeUndefined();
    expect(refererFor('https://example.com/a', 'http://other.example/b')).toBeUndefined();
    // Upgrading is fine, and is cross-origin.
    expect(refererFor('http://example.com/a', 'https://example.com/b')).toBe(
      'http://example.com/',
    );
  });

  it('never leaks the fragment or credentials', () => {
    expect(refererFor('https://example.com/a#secret', 'https://example.com/b')).toBe(
      'https://example.com/a',
    );
    expect(refererFor('https://user:pw@example.com/a', 'https://example.com/b')).toBe(
      'https://example.com/a',
    );
    expect(refererFor('https://user:pw@example.com/a', 'https://other.example/b')).toBe(
      'https://example.com/',
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

  it('sends nothing when reloading the same URL, fragment aside', () => {
    expect(refererFor('https://example.com/a', 'https://example.com/a')).toBeUndefined();
    // Normalised on both sides: a differing fragment is still the same page.
    expect(refererFor('https://example.com/a#one', 'https://example.com/a#two')).toBeUndefined();
    expect(refererFor('https://example.com/a', 'https://example.com/a#x')).toBeUndefined();
    // A differing query is a different page.
    expect(refererFor('https://example.com/a', 'https://example.com/a?q=1')).toBe(
      'https://example.com/a',
    );
  });
});
