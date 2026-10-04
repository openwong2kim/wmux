// The Git page's gh gate from a PR list answer.
import { describe, it, expect } from 'vitest';
import { ghAuthStateOf } from '../ghAuthGate';

describe('ghAuthStateOf', () => {
  it('a list is ok', () => {
    expect(ghAuthStateOf({ ok: true, prs: [] })).toBe('ok');
  });

  it('gh not installed / not signed in on GitHub', () => {
    expect(ghAuthStateOf({ ok: false, code: 'cli-missing', message: '', provider: 'github' })).toBe('cli-missing');
    expect(ghAuthStateOf({ ok: false, code: 'unauthenticated', message: '', provider: 'github' })).toBe('unauthenticated');
  });

  it('GitLab, no remote and another host are not GitHub', () => {
    expect(ghAuthStateOf({ ok: false, code: 'unauthenticated', message: '', provider: 'gitlab' })).toBe('not-github');
    expect(ghAuthStateOf({ ok: false, code: 'cli-missing', message: '', provider: 'gitlab' })).toBe('not-github');
    expect(ghAuthStateOf({ ok: false, code: 'no-remote', message: '' })).toBe('not-github');
    expect(ghAuthStateOf({ ok: false, code: 'unsupported-host', message: '' })).toBe('not-github');
  });

  it('a list that failed for another reason means gh is ready', () => {
    expect(ghAuthStateOf({ ok: false, code: 'error', message: 'HTTP 502' })).toBe('ok');
  });
});
