import { describe, expect, it } from 'vitest';
import { isFileDrag } from '../dragDrop';

describe('isFileDrag', () => {
  it('returns false when no dataTransfer is present', () => {
    expect(isFileDrag(null)).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });

  it('returns false for internal text drags', () => {
    expect(isFileDrag({ types: ['text/plain'] })).toBe(false);
  });

  it('returns true when DataTransfer types include Files', () => {
    expect(isFileDrag({ types: ['Files'] })).toBe(true);
  });

  it('returns true when files are present even without types', () => {
    expect(isFileDrag({ files: { length: 1 } })).toBe(true);
  });
});
