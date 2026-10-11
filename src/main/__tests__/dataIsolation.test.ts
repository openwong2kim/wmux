import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkUserDataIsolation, claimPortableDataNotice, shouldUsePortableData } from '../dataIsolation';

const PROD = 'C:\\Users\\x\\AppData\\Roaming\\wmux';

describe('checkUserDataIsolation (P2b suffix isolation guard)', () => {
  it('passes for an EMPTY suffix even when userData is the prod default (legit production)', () => {
    // The load-bearing case: no isolation requested → must NEVER crash a normal
    // production boot, even though userData equals the prod path.
    expect(checkUserDataIsolation('', PROD, PROD)).toEqual({ ok: true });
  });

  it('passes when the suffix IS reflected in userData (original + suffix)', () => {
    expect(checkUserDataIsolation('-dev', PROD + '-dev', PROD)).toEqual({ ok: true });
  });

  it('passes for a custom isolation suffix (sandbox / dogfood)', () => {
    expect(checkUserDataIsolation('-sandbox-42', '/home/u/.config/wmux-sandbox-42', '/home/u/.config/wmux')).toEqual({ ok: true });
  });

  it('FAILS LOUD when a non-empty suffix is NOT reflected (setPath threw → prod dir)', () => {
    const r = checkUserDataIsolation('-dev', PROD, PROD);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/isolation broken/);
    expect(r.ok === false && r.error).toMatch(/-dev/);
  });

  it('does not fail-loud on the prod path purely because it lacks a suffix', () => {
    // Distinguishes the ENV axis (no suffix at all → legitimate prod) from the
    // CODE axis (suffix set but setPath failed → the bug). Only the latter trips,
    // so this guard can never turn a normal production launch into a crash.
    expect(checkUserDataIsolation('', '/home/u/.config/wmux', '/home/u/.config/wmux').ok).toBe(true);
  });

  it('uses EXACT-path comparison, not a tail substring (codex P3)', () => {
    // suffix 'x' with original '.../wmux': if setPath FAILED, resolved stays
    // '.../wmux', which endsWith('x') (…wmu*x*) — the old substring check would
    // wrongly PASS and boot onto prod. Exact comparison (original + suffix =
    // '.../wmuxx') correctly fails.
    const failed = checkUserDataIsolation('x', PROD, PROD);
    expect(failed.ok).toBe(false);
    // And when it WAS applied (resolved === original + 'x'), it passes.
    expect(checkUserDataIsolation('x', PROD + 'x', PROD).ok).toBe(true);
  });
});

describe('shouldUsePortableData (darwin packaged copy outside an install location)', () => {
  const HOME = '/Users/u';
  const exe = (bundle: string) => `${bundle}/Contents/MacOS/wmux`;
  const portable = (p: string, env: NodeJS.ProcessEnv = {}) => shouldUsePortableData(p, HOME, env);

  it('keeps production data for installed bundles', () => {
    expect(portable(exe('/Applications/wmux.app'))).toBe(false);
    expect(portable(exe('/Users/u/Applications/wmux.app'))).toBe(false);
    expect(portable(exe('/Applications/Utilities/wmux.app'))).toBe(false);
    expect(portable(exe('/applications/wmux.app'))).toBe(false); // APFS is case-insensitive
  });

  it('isolates copies run from outside an install location', () => {
    expect(portable(exe('/Volumes/wmux/wmux.app'))).toBe(true);
    expect(portable(exe('/private/var/folders/ab/cd/T/AppTranslocation/1234-ABCD/d/wmux.app'))).toBe(true);
    expect(portable(exe('/Users/u/src/wmux/out/wmux-darwin-arm64/wmux.app'))).toBe(true);
    expect(portable(exe('/Users/u/Downloads/wmux.app'))).toBe(true);
    // A look-alike prefix is not ~/Applications.
    expect(portable(exe('/Users/u/ApplicationsOld/wmux.app'))).toBe(true);
  });

  it('never overrides an explicit suffix, and honours the escape hatch', () => {
    expect(portable(exe('/Volumes/wmux/wmux.app'), { WMUX_DATA_SUFFIX: '-demo' })).toBe(false);
    expect(portable(exe('/Volumes/wmux/wmux.app'), { WMUX_ALLOW_PRODUCTION_DATA: '1' })).toBe(false);
  });

  it('treats an unrecognisable exec path as installed', () => {
    expect(portable('/usr/local/bin/wmux')).toBe(false);
  });
});

describe('claimPortableDataNotice (one-time notice for a forced portable copy)', () => {
  it('shows only when portable data was forced, and only once per data dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-portable-notice-'));
    const marker = path.join(dir, 'home', 'portable-notice-shown');
    expect(claimPortableDataNotice(false, marker)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false); // not forced: nothing recorded
    expect(claimPortableDataNotice(true, marker)).toBe(true);
    expect(claimPortableDataNotice(true, marker)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
