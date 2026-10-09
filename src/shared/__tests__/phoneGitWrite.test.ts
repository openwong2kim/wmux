import { describe, expect, it } from 'vitest';
import {
  GIT_WRITE_ERROR_STATUS, executeBodyPins, gitWriteFingerprintSource, parsePrCreateExecute, parsePrMergeExecute,
  parsePrNumber, parsePreviewBody, parsePushExecute,
} from '../phoneGitWrite';

const OID = 'a'.repeat(40);
const RID = '0F8FAD5B-D9CB-469F-A165-70867728950E';
const TOKEN = 'x'.repeat(43);

describe('phone git write contract', () => {
  it('parses a push execute, lowercasing the requestId, and rejects extra keys or a bad ref', () => {
    const ok = parsePushExecute({ requestId: RID, confirmToken: TOKEN, expectedHead: OID, expectedRef: 'refs/heads/feat/x' });
    expect(ok).toEqual({ ok: true, value: { requestId: RID.toLowerCase(), confirmToken: TOKEN, expectedHead: OID, expectedRef: 'refs/heads/feat/x' } });
    expect(parsePushExecute({ requestId: RID, confirmToken: TOKEN, expectedHead: OID, expectedRef: 'refs/heads/x', force: true }).ok).toBe(false);
    expect(parsePushExecute({ requestId: RID, confirmToken: TOKEN, expectedHead: OID, expectedRef: 'refs/tags/v1' }).ok).toBe(false);
    expect(parsePushExecute({ requestId: RID, confirmToken: TOKEN, expectedHead: 'HEAD', expectedRef: 'refs/heads/x' }).ok).toBe(false);
  });

  it('refuses a non-squash merge method and a bad PR title with their own tags', () => {
    const merge = { requestId: RID, confirmToken: TOKEN, expectHead: OID, method: 'squash', subject: 'T (#1)', body: '' };
    expect(parsePrMergeExecute(merge).ok).toBe(true);
    expect(parsePrMergeExecute({ ...merge, method: 'rebase' })).toEqual({ ok: false, error: 'merge-method-unsupported' });
    expect(parsePrCreateExecute({ requestId: RID, title: '', body: '' })).toEqual({ ok: false, error: 'invalid-pr-title' });
    expect(parsePrCreateExecute({ requestId: RID, title: 't'.repeat(257), body: '' })).toEqual({ ok: false, error: 'invalid-pr-title' });
    expect(parsePrCreateExecute({ requestId: RID, title: 'ok', body: '', base: '--force' })).toEqual({ ok: false, error: 'invalid-base' });
    expect(parsePrCreateExecute({ requestId: RID, title: 'ok', body: 'b'.repeat(64 * 1024 + 1) }).ok).toBe(false);
    expect(parsePrCreateExecute({ requestId: RID, title: 'ok', body: '', base: 'main', draft: true }).ok).toBe(true);
  });

  it('takes the fingerprint without the confirm token and independent of key order', () => {
    const a = gitWriteFingerprintSource('push', { requestId: RID, confirmToken: 'one', expectedHead: OID, expectedRef: 'refs/heads/x' });
    const b = gitWriteFingerprintSource('push', { expectedRef: 'refs/heads/x', expectedHead: OID, confirmToken: 'two', requestId: RID });
    expect(a).toBe(b);
    expect(a).not.toContain('one');
    expect(gitWriteFingerprintSource('pr.merge', { requestId: RID }, 1)).not.toBe(gitWriteFingerprintSource('pr.merge', { requestId: RID }, 2));
  });

  it('pins, preview body, PR numbers and status codes', () => {
    expect(executeBodyPins('push', { requestId: RID, confirmToken: TOKEN, expectedHead: OID, expectedRef: 'refs/heads/x' })).toEqual({ head: OID, ref: 'refs/heads/x' });
    expect(executeBodyPins('pr.merge', { requestId: RID, confirmToken: TOKEN, expectHead: OID, method: 'squash', subject: '', body: '' }, 7)).toEqual({ number: 7, headRefOid: OID });
    expect(parsePreviewBody({}).ok).toBe(true);
    expect(parsePreviewBody({ ref: 'x' }).ok).toBe(false);
    expect(parsePrNumber('1980')).toBe(1980);
    for (const bad of ['0', '01', '-1', '1e3', '']) expect(parsePrNumber(bad)).toBeNull();
    expect(GIT_WRITE_ERROR_STATUS['receipt-expired']).toBe(404);
    expect(GIT_WRITE_ERROR_STATUS['confirm-required']).toBe(428);
  });
});
