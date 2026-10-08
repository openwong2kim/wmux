import { describe, it, expect } from 'vitest';
import { isValidProfileName, paneProfileNameFrom } from '../paneChromeProfileName';

describe('paneProfileNameFrom', () => {
  it('keeps a label that is already a valid name', () => {
    expect(paneProfileNameFrom('work', [])).toBe('work');
  });

  it('turns an auto pane name into a valid one', () => {
    const name = paneProfileNameFrom('w1-2(claude)', []);
    expect(name).toBe('w1-2-claude');
    expect(isValidProfileName(name)).toBe(true);
  });

  it('collapses spaces and punctuation, and strips a leading non-alphanumeric', () => {
    expect(paneProfileNameFrom('  _My shop: admin!  ', [])).toBe('My-shop-admin');
  });

  it('falls back when nothing ASCII survives (a Korean pane name)', () => {
    expect(paneProfileNameFrom('쇼핑 계정', [])).toBe('pane');
  });

  it('keeps the ASCII part of a mixed label', () => {
    expect(paneProfileNameFrom('쇼핑 shop', [])).toBe('shop');
  });

  it('de-duplicates case-insensitively with a numeric suffix', () => {
    expect(paneProfileNameFrom('work', ['Work'])).toBe('work-2');
    expect(paneProfileNameFrom('work', ['work', 'work-2'])).toBe('work-3');
  });

  it('never reuses the reserved default/live names', () => {
    expect(paneProfileNameFrom('default', [])).toBe('default-2');
    expect(paneProfileNameFrom('Live', [])).toBe('Live-2');
  });

  it('stays within 64 characters, suffix included', () => {
    const long = 'a'.repeat(80);
    const first = paneProfileNameFrom(long, []);
    expect(first).toHaveLength(64);
    const second = paneProfileNameFrom(long, [first]);
    expect(second).toHaveLength(64);
    expect(second.endsWith('-2')).toBe(true);
    expect(isValidProfileName(second)).toBe(true);
  });
});
