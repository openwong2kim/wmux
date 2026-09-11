import { describe, it, expect } from 'vitest';
import { MIN_SAFE_COLS, MIN_SAFE_ROWS, isSafeGeometry } from '../terminalGeometry';

// #1255 — the geometry floor is single-sourced between the daemon's resize
// clamp (the zle.so SIGBUS guard) and the renderer's fit gate. These are the
// semantics both sides rely on; a change here is a protocol change.
describe('shared/terminalGeometry', () => {
  it('exports the daemon-clamped floors', () => {
    expect(MIN_SAFE_COLS).toBe(10);
    expect(MIN_SAFE_ROWS).toBe(2);
  });

  it('rejects unmeasurable dimensions', () => {
    expect(isSafeGeometry(undefined, undefined)).toBe(false);
    expect(isSafeGeometry(80, undefined)).toBe(false);
    expect(isSafeGeometry(undefined, 24)).toBe(false);
  });

  it('rejects sub-floor proposals (the transient mid-split widths)', () => {
    expect(isSafeGeometry(2, 24)).toBe(false);
    expect(isSafeGeometry(9, 24)).toBe(false);
    expect(isSafeGeometry(80, 1)).toBe(false);
  });

  it('accepts floor and above', () => {
    expect(isSafeGeometry(MIN_SAFE_COLS, MIN_SAFE_ROWS)).toBe(true);
    expect(isSafeGeometry(80, 24)).toBe(true);
  });
});
