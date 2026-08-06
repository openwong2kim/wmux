import { describe, it, expect } from 'vitest';
import { parseWebUrl } from '../remoteHosts';

describe('parseWebUrl', () => {
  it('parses origin and token from a wmux web URL', () => {
    expect(parseWebUrl('https://mac.tailnet.ts.net:9600/?token=abc123')).toEqual({
      origin: 'https://mac.tailnet.ts.net:9600',
      token: 'abc123',
    });
  });
  it('strips path and keeps only origin', () => {
    expect(parseWebUrl('http://192.168.0.5:9600/terminal.html?token=t')!.origin)
      .toBe('http://192.168.0.5:9600');
  });
  it('rejects a URL without token', () => {
    expect(parseWebUrl('https://mac.ts.net:9600/')).toBeNull();
  });
  it('rejects non-http schemes and garbage', () => {
    expect(parseWebUrl('ftp://x?token=t')).toBeNull();
    expect(parseWebUrl('not a url')).toBeNull();
  });
});
