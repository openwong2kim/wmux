import { describe, it, expect } from 'vitest';
import { quotePathsForPrompt, buildSubmitWrites } from '../inject';

describe('quotePathsForPrompt', () => {
  it('quotes paths with spaces and joins with a single space', () => {
    expect(quotePathsForPrompt(['/a/b.png', '/c d/e.ts'])).toBe('/a/b.png "/c d/e.ts"');
  });
  it('returns empty string for no paths', () => {
    expect(quotePathsForPrompt([])).toBe('');
  });
});

describe('buildSubmitWrites', () => {
  it('returns the text then a lone CR when submit=true', () => {
    expect(buildSubmitWrites('hello', true)).toEqual(['hello', '\r']);
  });
  it('returns just the text when submit=false', () => {
    expect(buildSubmitWrites('hello', false)).toEqual(['hello']);
  });
});
