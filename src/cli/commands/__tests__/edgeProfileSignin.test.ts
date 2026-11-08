import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDGE_SIGNED_IN_HINT, edgeAccountSignedIn, edgeProfileDirs } from '../edgeProfileSignin';

// Shaped like the Default/Preferences Edge 157 wrote after signing a fresh
// profile in by itself (key names as Edge writes them; every value is fake).
const signedIn = readFileSync(join(__dirname, 'fixtures', 'edge-signed-in.Preferences.json'), 'utf8');

describe('edgeAccountSignedIn', () => {
  it('reads an Edge profile signed in to an account', () => {
    expect(edgeAccountSignedIn(signedIn)).toBe(true);
  });

  it('is false once the account is signed out (no account_info entry)', () => {
    const out = JSON.parse(signedIn) as Record<string, unknown>;
    out.account_info = [];
    expect(edgeAccountSignedIn(JSON.stringify(out))).toBe(false);
  });

  it('does not count a Chrome profile signed in to Google', () => {
    const chrome = { account_info: [{ account_id: '1234567890', email: 'someone@example.com', gaia: '1234567890', full_name: 'Some One' }] };
    expect(edgeAccountSignedIn(JSON.stringify(chrome))).toBe(false);
  });

  it('needs an account id or email, not just Edge keys', () => {
    expect(edgeAccountSignedIn(JSON.stringify({ account_info: [{ edge_account_type: 0, account_id: '', email: '' }] }))).toBe(false);
  });

  it('is false for a missing, empty or unreadable file', () => {
    expect(edgeAccountSignedIn(null)).toBe(false);
    expect(edgeAccountSignedIn('')).toBe(false);
    expect(edgeAccountSignedIn('{not json')).toBe(false);
    expect(edgeAccountSignedIn('{"account_info":"x"}')).toBe(false);
  });

  it('lists the profile folders Local State names, and Default without one', () => {
    expect(edgeProfileDirs(JSON.stringify({ profile: { info_cache: { Default: {}, 'Profile 1': {} } } }))).toEqual(['Default', 'Profile 1']);
    expect(edgeProfileDirs(null)).toEqual(['Default']);
    expect(edgeProfileDirs('{bad')).toEqual(['Default']);
    // A name that is not a plain folder name is never joined into a path.
    expect(edgeProfileDirs(JSON.stringify({ profile: { info_cache: { '..': {}, 'a/b': {}, Default: {} } } }))).toEqual(['Default']);
  });

  it('the doctor hint names no email and no account id', () => {
    expect(EDGE_SIGNED_IN_HINT).not.toMatch(/@|0003BFFD/);
  });
});
