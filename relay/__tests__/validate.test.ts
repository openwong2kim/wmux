import { describe, it, expect } from 'vitest';

import {
  MAX_BODY_BYTES,
  MAX_CIPHERTEXT_CHARS,
  exceedsDeclaredBodyLimit,
  validatePushRequest,
} from '../src/validate';

const TOKEN = 'a'.repeat(64);
const CIPHERTEXT = Buffer.from('sealed-envelope-bytes').toString('base64');

function ok(body: unknown) {
  const res = validatePushRequest(body);
  if (!res.ok) throw new Error(`expected ok, got ${res.error.reason}`);
  return res.value;
}

function reason(body: unknown) {
  const res = validatePushRequest(body);
  if (res.ok) throw new Error('expected a rejection');
  return `${res.error.status}:${res.error.reason}`;
}

describe('validatePushRequest — accepts', () => {
  it('a minimal request, defaulting priority to 10', () => {
    expect(ok({ apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT })).toEqual({
      apnsDeviceToken: TOKEN,
      ciphertext: CIPHERTEXT,
      priority: 10,
    });
  });

  it('an explicit priority and collapseId', () => {
    const v = ok({ apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT, priority: 5, collapseId: 'ap_1' });
    expect(v.priority).toBe(5);
    expect(v.collapseId).toBe('ap_1');
  });

  it('uppercase and longer device tokens (Apple reserves the right to grow them)', () => {
    expect(ok({ apnsDeviceToken: 'A'.repeat(64), ciphertext: CIPHERTEXT }).apnsDeviceToken).toHaveLength(64);
    expect(ok({ apnsDeviceToken: 'f'.repeat(160), ciphertext: CIPHERTEXT }).apnsDeviceToken).toHaveLength(160);
  });

  it('a ciphertext right at the size limit', () => {
    const at = 'A'.repeat(MAX_CIPHERTEXT_CHARS);
    expect(ok({ apnsDeviceToken: TOKEN, ciphertext: at }).ciphertext).toHaveLength(MAX_CIPHERTEXT_CHARS);
  });
});

describe('validatePushRequest — rejects', () => {
  it('non-objects', () => {
    for (const bad of [null, undefined, 1, 'x', [], true]) {
      expect(reason(bad)).toBe('400:body-not-object');
    }
  });

  it('malformed device tokens before doing anything else', () => {
    expect(reason({ apnsDeviceToken: 'zz', ciphertext: CIPHERTEXT })).toBe('400:bad-device-token');
    expect(reason({ apnsDeviceToken: 'g'.repeat(64), ciphertext: CIPHERTEXT })).toBe('400:bad-device-token');
    expect(reason({ apnsDeviceToken: 'a'.repeat(63), ciphertext: CIPHERTEXT })).toBe('400:bad-device-token');
    expect(reason({ apnsDeviceToken: 'a'.repeat(201), ciphertext: CIPHERTEXT })).toBe('400:bad-device-token');
    expect(reason({ apnsDeviceToken: 123, ciphertext: CIPHERTEXT })).toBe('400:bad-device-token');
  });

  it('a missing, empty, or non-base64 ciphertext', () => {
    expect(reason({ apnsDeviceToken: TOKEN })).toBe('400:bad-ciphertext');
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: '' })).toBe('400:bad-ciphertext');
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: 'not*base64' })).toBe('400:bad-ciphertext');
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: { a: 1 } })).toBe('400:bad-ciphertext');
  });

  it('an oversized ciphertext with 413, not 400', () => {
    const over = 'A'.repeat(MAX_CIPHERTEXT_CHARS + 4);
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: over })).toBe('413:ciphertext-too-large');
  });

  it('priorities APNs does not accept', () => {
    for (const p of [0, 1, 9, 11, '10', null]) {
      expect(reason({ apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT, priority: p })).toBe('400:bad-priority');
    }
  });

  it('collapse ids that would not survive an HTTP header', () => {
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT, collapseId: 'a\r\nb' })).toBe(
      '400:bad-collapse-id',
    );
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT, collapseId: 'x'.repeat(65) })).toBe(
      '400:bad-collapse-id',
    );
    expect(reason({ apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT, collapseId: '' })).toBe(
      '400:bad-collapse-id',
    );
  });
});

describe('validatePushRequest — leak safety', () => {
  it('never puts a field value into the rejection reason', () => {
    const secret = 'S3CRET-CIPHERTEXT-MARKER';
    const res = validatePushRequest({
      apnsDeviceToken: secret,
      ciphertext: secret,
      collapseId: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(JSON.stringify(res.error)).not.toContain(secret);
  });
});

describe('exceedsDeclaredBodyLimit', () => {
  it('passes through a missing or unparseable header', () => {
    expect(exceedsDeclaredBodyLimit(null)).toBe(false);
    expect(exceedsDeclaredBodyLimit('not-a-number')).toBe(false);
  });

  it('flags a declared body over the cap', () => {
    expect(exceedsDeclaredBodyLimit(String(MAX_BODY_BYTES))).toBe(false);
    expect(exceedsDeclaredBodyLimit(String(MAX_BODY_BYTES + 1))).toBe(true);
  });
});
