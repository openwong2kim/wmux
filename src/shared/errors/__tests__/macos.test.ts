import { describe, expect, it } from 'vitest';
import {
  MACOS_ERRORS,
  formatMacosError,
  type MacosErrorKey,
  type MacosErrorTemplate,
} from '../macos';

const EXPECTED_KEYS: MacosErrorKey[] = [
  'gatekeeperBlocked',
  'nodePtyBuildFailed',
  'mcpPermissionDenied',
  'brewTapNotFound',
  'playwrightChromiumQuarantine',
];

describe('MACOS_ERRORS catalog', () => {
  it('defines all five expected entries', () => {
    for (const key of EXPECTED_KEYS) {
      expect(MACOS_ERRORS[key]).toBeDefined();
    }
    // Guard against accidental drift if extra entries are added without updating
    // the expected list above.
    expect(Object.keys(MACOS_ERRORS).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it.each(EXPECTED_KEYS)('%s has non-empty required fields', (key) => {
    const entry: MacosErrorTemplate = MACOS_ERRORS[key];
    expect(entry.code, 'code').toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(entry.problem.trim().length, 'problem').toBeGreaterThan(0);
    expect(entry.cause.trim().length, 'cause').toBeGreaterThan(0);
    expect(entry.fix.trim().length, 'fix').toBeGreaterThan(0);
  });

  it('codes are unique across the catalog', () => {
    const codes = Object.values(MACOS_ERRORS).map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gatekeeperBlocked includes a documentation URL', () => {
    expect(MACOS_ERRORS.gatekeeperBlocked.docsUrl).toMatch(/^https?:\/\//);
  });
});

describe('formatMacosError', () => {
  it('returns a multi-line string containing problem, cause, and fix', () => {
    const out = formatMacosError(MACOS_ERRORS.nodePtyBuildFailed);
    expect(out).toContain('error[NODE_PTY_BUILD_FAILED]');
    expect(out).toContain(MACOS_ERRORS.nodePtyBuildFailed.problem);
    expect(out).toContain('cause:');
    expect(out).toContain(MACOS_ERRORS.nodePtyBuildFailed.cause);
    expect(out).toContain('fix:');
    expect(out).toContain(MACOS_ERRORS.nodePtyBuildFailed.fix);
    expect(out.split('\n').length).toBeGreaterThanOrEqual(4);
  });

  it('emits a docs line only when docsUrl is set', () => {
    const withDocs = formatMacosError(MACOS_ERRORS.gatekeeperBlocked);
    expect(withDocs).toContain('docs:');
    const docsUrl = MACOS_ERRORS.gatekeeperBlocked.docsUrl;
    expect(docsUrl).toBeDefined();
    expect(withDocs).toContain(docsUrl ?? '');

    const withoutDocs = formatMacosError(MACOS_ERRORS.nodePtyBuildFailed);
    expect(withoutDocs).not.toContain('docs:');
  });

  it('every catalog entry formats to a non-empty 4+ line message', () => {
    for (const key of EXPECTED_KEYS) {
      const formatted = formatMacosError(MACOS_ERRORS[key]);
      expect(formatted.length, key).toBeGreaterThan(0);
      expect(formatted.split('\n').length, key).toBeGreaterThanOrEqual(4);
    }
  });
});
