import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/**
 * The frontend has no bundler — `pairQuery.js` is inlined into terminal.html by
 * scripts/build-daemon-web.mjs. Evaluate the shipped file verbatim so this
 * covers exactly the code the phone runs.
 */
let readPairCode: (search: string) => string;
let urlWithoutCode: (pathname: string, search: string) => string | null;

beforeAll(() => {
  const src = readFileSync(join(__dirname, '..', 'frontend', 'pairQuery.js'), 'utf8');
  const sandbox: Record<string, unknown> = { URLSearchParams };
  runInNewContext(src, sandbox);
  const mod = (sandbox as { pairQuery: Record<string, unknown> }).pairQuery;
  readPairCode = mod['readPairCode'] as typeof readPairCode;
  urlWithoutCode = mod['urlWithoutCode'] as typeof urlWithoutCode;
});

describe('readPairCode', () => {
  it('reads the code a scanned QR delivers', () => {
    expect(readPairCode('?code=ABCD2345')).toBe('ABCD2345');
  });

  it('normalises case and trims, because keyboards and copied links do both', () => {
    expect(readPairCode('?code=abcd2345')).toBe('ABCD2345');
    expect(readPairCode('?code=%20ABCD2345%20')).toBe('ABCD2345');
  });

  it('★ REGRESSION: no query string means the manual form, exactly as before', () => {
    // Every phone that types the address by hand takes this path. It must be
    // byte-for-byte what it was before the QR existed.
    expect(readPairCode('')).toBe('');
    expect(readPairCode('?')).toBe('');
    expect(readPairCode('?other=1')).toBe('');
  });

  it('★ refuses junk instead of auto-submitting it', () => {
    // A half-copied link is the likely cause. Landing on the manual form is the
    // way forward; burning an attempt on garbage is not — five wrong tries lock
    // the code out entirely.
    expect(readPairCode('?code=SHORT')).toBe('');
    expect(readPairCode('?code=TOOLONG123')).toBe('');
    expect(readPairCode('?code=AB!D2345')).toBe('');
    expect(readPairCode('?code=ABCI2345')).toBe('');
    expect(readPairCode('?code=ABCD2341')).toBe('');
    expect(readPairCode('?code=')).toBe('');
  });

  it('survives a malformed query rather than throwing', () => {
    expect(readPairCode('?%')).toBe('');
    expect(readPairCode(null as unknown as string)).toBe('');
  });
});

describe('urlWithoutCode', () => {
  it('★ strips the code so it does not sit in the address bar', () => {
    // A live code parked in history is the one write-down surface left after
    // Referrer-Policy: no-referrer. It cannot be un-scanned from a camera roll,
    // but it can be taken out of the browser.
    expect(urlWithoutCode('/pair', '?code=ABCD2345')).toBe('/pair');
  });

  it('keeps every other parameter', () => {
    expect(urlWithoutCode('/pair', '?code=ABCD2345&next=%2Fa')).toBe('/pair?next=%2Fa');
  });

  it('returns null when there is nothing to strip, so no history entry is pushed', () => {
    expect(urlWithoutCode('/pair', '')).toBeNull();
    expect(urlWithoutCode('/pair', '?other=1')).toBeNull();
  });
});
