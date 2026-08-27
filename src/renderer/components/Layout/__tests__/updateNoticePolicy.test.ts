/**
 * #1055 — behavioral tests for the update-notice decisions AppLayout's
 * structural pins cannot verify (the hooks have no jsdom fixture; the logic
 * was extracted precisely so these cases are testable for real).
 */
import { describe, it, expect } from 'vitest';
import {
  shouldShowInstallError,
  shouldReannounceAfterError,
  truncateReason,
} from '../updateNoticePolicy';

const WINDOW_MS = 30_000;
const err = (over: Partial<Parameters<typeof shouldShowInstallError>[0]> = {}) => ({
  status: 'error',
  message: 'boom',
  ...over,
});

describe('shouldShowInstallError', () => {
  it('always shows a tagged install error — no click stamp, window long expired', () => {
    // The macOS staging deadline fires 10 minutes after the click, and a
    // one-shot "check for updates" install never stamps a click at all. Both
    // were silently dropped by the click window before #1055.
    expect(shouldShowInstallError(err({ source: 'install' }), 0, 1_000_000, WINDOW_MS)).toBe(true);
    expect(shouldShowInstallError(err({ source: 'install' }), 100, 100 + WINDOW_MS * 20, WINDOW_MS)).toBe(true);
  });

  it('shows an untagged error only inside the click window', () => {
    const clickedAt = 50_000;
    expect(shouldShowInstallError(err(), clickedAt, clickedAt + 1_000, WINDOW_MS)).toBe(true);
    // Boundary is inclusive: landing exactly at the deadline still counts.
    expect(shouldShowInstallError(err(), clickedAt, clickedAt + WINDOW_MS, WINDOW_MS)).toBe(true);
    expect(shouldShowInstallError(err(), clickedAt, clickedAt + WINDOW_MS + 1, WINDOW_MS)).toBe(false);
  });

  it('never shows an untagged error with no install requested', () => {
    // A background poll failing on an offline machine — the first runs ~15s
    // after launch — must not post "could not be installed" on a persistent
    // surface. installRequestedAt === 0 means nobody asked.
    expect(shouldShowInstallError(err(), 0, 1_000, WINDOW_MS)).toBe(false);
  });
});

describe('shouldReannounceAfterError', () => {
  it('re-offers the Install button after a real failure', () => {
    expect(shouldReannounceAfterError(err({ source: 'install' }))).toBe(true);
  });

  it('does not re-offer while an install is already in flight', () => {
    // The in-flight attempt's own outcome will re-announce; re-offering here
    // just invites a third click into the same refusal.
    expect(shouldReannounceAfterError(err({ source: 'install', code: 'in-progress' }))).toBe(false);
  });
});

describe('truncateReason', () => {
  it('passes a short reason through, trimmed', () => {
    expect(truncateReason('  install-aborted: install root still locked  ')).toBe(
      'install-aborted: install root still locked',
    );
  });

  it('bounds a long reason at the cap, ellipsis included', () => {
    const long = 'x'.repeat(500);
    const out = truncateReason(long);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a reason exactly at the cap alone', () => {
    const exact = 'y'.repeat(200);
    expect(truncateReason(exact)).toBe(exact);
  });
});
