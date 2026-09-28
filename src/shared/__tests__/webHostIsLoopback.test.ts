import { describe, it, expect } from 'vitest';
import { webHostIsLoopback } from '../web';
import { isCredentialSafeOrigin, parseRemotePairInput } from '../remotePairInput';

/**
 * Loopback decides whether a credential may cross plain http. A HOSTNAME that
 * merely starts with "127." resolves wherever its owner says, so it must never
 * count.
 */
describe('webHostIsLoopback', () => {
  it.each([
    '127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST', 'localhost.',
    '::1', '[::1]', '[0:0:0:0:0:0:0:1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', ' 127.0.0.1 ',
  ])('%j is loopback', (host) => {
    expect(webHostIsLoopback(host)).toBe(true);
  });

  it.each([
    '127.0.0.1.nip.io', '127.evil.example', '127.0.0.1.evil.com', '127.', '127.0.0', '127.0.0.256',
    '0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'localhost.evil.com', 'mylocalhost', 'localhost..',
    '::ffff:192.168.1.5', '[::ffff:c0a8:105]', '[::2]', 'desk.tail1234.ts.net', '',
  ])('%j is NOT loopback', (host) => {
    expect(webHostIsLoopback(host)).toBe(false);
  });
});

describe('credential-safe origins (the pairing parser and every token-carrying call)', () => {
  it.each([
    ['http://127.0.0.1:7681', true],
    ['http://localhost:7681', true],
    ['http://[::1]:7681', true],
    ['http://[::ffff:7f00:1]:7681', true],
    ['https://127.0.0.1.nip.io', true],
    ['http://127.0.0.1.nip.io:7681', false],
    ['http://127.evil.example', false],
    ['http://127.0.0.1.evil.com', false],
    ['http://0.0.0.0:7681', false],
    ['HTTP://127.0.0.1.NIP.IO', false],
  ])('%s → %s', (origin, safe) => {
    expect(isCredentialSafeOrigin(new URL(origin))).toBe(safe);
  });

  it('the pairing parser refuses the bypass hostnames over http', () => {
    for (const link of [
      'http://127.0.0.1.nip.io:7681/pair#wmux-desktop-code=QWXZ7K9M',
      'http://127.evil.example/pair?code=QWXZ7K9M',
      'http://127.0.0.1.evil.com QWXZ7K9M',
      'http://0.0.0.0:7681/?token=abc',
    ]) {
      expect(parseRemotePairInput(link)).toEqual({ kind: 'error', reason: 'insecure' });
    }
    expect(parseRemotePairInput('http://127.0.0.1:7681/pair#wmux-desktop-code=QWXZ7K9M')).toMatchObject({ kind: 'pair' });
  });
});
