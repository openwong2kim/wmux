import { describe, it, expect } from 'vitest';
import { parseRemoteAttachmentKey, parseWebUrl, remoteAttachmentKey } from '../remoteHosts';

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

// The attach descriptor key is minted renderer-side and enforced main-side —
// both go through these, so the two cannot drift.
describe('remote attachment key', () => {
  it('round-trips a host/workspace pair', () => {
    const key = remoteAttachmentKey('h1', 'ws-1');
    expect(key).toBe('h1:ws-1');
    expect(parseRemoteAttachmentKey(key)).toEqual({ hostId: 'h1', workspaceId: 'ws-1' });
  });

  it('splits on the FIRST colon, so a workspace id may contain one', () => {
    expect(parseRemoteAttachmentKey('h1:ws:1')).toEqual({ hostId: 'h1', workspaceId: 'ws:1' });
  });

  it('rejects a key with no separator or an empty half', () => {
    expect(parseRemoteAttachmentKey('h1')).toBeNull();
    expect(parseRemoteAttachmentKey(':ws-1')).toBeNull();
    expect(parseRemoteAttachmentKey('h1:')).toBeNull();
    expect(parseRemoteAttachmentKey('')).toBeNull();
  });
});
