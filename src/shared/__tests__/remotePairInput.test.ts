import { describe, it, expect } from 'vitest';
import { normalizePairCode, parseRemotePairInput } from '../remotePairInput';
import { buildDesktopPairLink } from '../web';

const pair = (origin: string, code: string) => ({ kind: 'pair', origin, code });
const err = (reason: string) => ({ kind: 'error', reason });

describe('parseRemotePairInput', () => {
  it.each([
    // The computer link, exactly as the host's Copy link writes it.
    [buildDesktopPairLink('https://desk.tail1234.ts.net', 'QWXZ7K9M'), pair('https://desk.tail1234.ts.net', 'QWXZ7K9M')],
    // Pasted with the whitespace a copy tends to carry, in any case.
    ['  https://desk.tail1234.ts.net/pair#wmux-desktop-code=qwxz7k9m \n', pair('https://desk.tail1234.ts.net', 'QWXZ7K9M')],
    ['HTTPS://Desk.Tail1234.ts.net/pair#WMUX-DESKTOP-CODE=QWXZ7K9M', pair('https://desk.tail1234.ts.net', 'QWXZ7K9M')],
    ['https://192.168.1.5:7795/pair#wmux-desktop-code=QWXZ7K9M', pair('https://192.168.1.5:7795', 'QWXZ7K9M')],
    // The phone QR link still works here.
    ['https://desk.tail1234.ts.net/pair?code=QWXZ7K9M', pair('https://desk.tail1234.ts.net', 'QWXZ7K9M')],
    // Both present: the computer link wins.
    ['https://h.ts.net/pair?code=AAAAAAAA#wmux-desktop-code=QWXZ7K9M', pair('https://h.ts.net', 'QWXZ7K9M')],
    // Address + code, as the old two-field form asked for them.
    ['https://h.ts.net:7681 qwxz7k9m', pair('https://h.ts.net:7681', 'QWXZ7K9M')],
    ['https://h.ts.net:7681/pair\tQWXZ7K9M', pair('https://h.ts.net:7681', 'QWXZ7K9M')],
    // Plaintext is parsed; the host refuses it at redemption with its own reason.
    ['http://192.168.1.5:7681/pair#wmux-desktop-code=QWXZ7K9M', pair('http://192.168.1.5:7681', 'QWXZ7K9M')],
  ])('pairs from %j', (input, expected) => {
    expect(parseRemotePairInput(input)).toEqual(expected);
  });

  it('keeps a `wmux web` token URL as a token URL', () => {
    expect(parseRemotePairInput(' https://h.ts.net:7681/?token=abc-123 ')).toEqual({
      kind: 'token',
      url: 'https://h.ts.net:7681/?token=abc-123',
      origin: 'https://h.ts.net:7681',
    });
  });

  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    ['javascript:alert(1)//https://h.ts.net/pair?code=QWXZ7K9M', 'not-a-link'],
    ['file:///etc/passwd#wmux-desktop-code=QWXZ7K9M', 'not-a-link'],
    ['data:text/html,<script>x</script>', 'not-a-link'],
    ['ftp://h.ts.net/pair?code=QWXZ7K9M', 'not-a-link'],
    ['h.ts.net/pair?code=QWXZ7K9M', 'not-a-link'],
    ['javascript:alert(1) QWXZ7K9M', 'not-a-link'],
    ['https://h.ts.net a b', 'not-a-link'],
    ['https://h.ts.net:7681', 'missing-code'],
    ['https://h.ts.net/pair', 'missing-code'],
    ['https://h.ts.net/pair#wmux-desktop-code=SHORT', 'bad-code'],
    ['https://h.ts.net/pair#wmux-desktop-code=OOOOOOOO', 'bad-code'],
    ['https://h.ts.net/pair?code=12345678', 'bad-code'],
    ['https://h.ts.net nope', 'bad-code'],
  ])('rejects %j as %s', (input, reason) => {
    expect(parseRemotePairInput(input)).toEqual(err(reason));
  });
});

describe('normalizePairCode', () => {
  it('uppercases, trims and drops a separator a person might type', () => {
    expect(normalizePairCode(' qwxz-7k9m ')).toBe('QWXZ7K9M');
    expect(normalizePairCode('QWXZ 7K9M')).toBe('QWXZ7K9M');
    expect(normalizePairCode('QWXZ7K9')).toBe('');
    expect(normalizePairCode('QWXZ7K9I')).toBe('');
  });
});
