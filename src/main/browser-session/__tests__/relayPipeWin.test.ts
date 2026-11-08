// The relay pipe's name, endpoint spelling and DACL checks: pure, every OS.
import { describe, expect, it } from 'vitest';
import { isOwnerOnlyDacl, ownerOnlyDaclSddl, parseDacl, relayPipeEndpoint, relayPipePath, RELAY_PIPE_PREFIX } from '../relayPipeWin';

const RELAY = '/devtools/browser/relay';
const SID = 'S-1-5-21-1000-2000-3000-1001';

/** How the ws client splits a ws+unix URL into a socket path and a request path. */
function wsSplit(endpoint: string): { socketPath: string; path: string } {
  const url = new URL(endpoint);
  const [socketPath, path] = (url.pathname + url.search).split(':');
  return { socketPath, path };
}

describe('relay pipe name and endpoint', () => {
  it('names a fresh pipe with 32 hex characters and nothing else', () => {
    const a = relayPipePath();
    expect(a).toMatch(new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\${RELAY_PIPE_PREFIX}[0-9a-f]{32}$`));
    expect(relayPipePath()).not.toBe(a);
  });

  it.each([['a:b'], ['a b'], ['naïve'], ['a/b'], ['a\\b'], ['']])('refuses a name part %j', (part) => {
    expect(() => relayPipePath(part)).toThrow(/unsafe/);
  });

  it('spells the endpoint so the ws client dials the pipe path itself', () => {
    const pipe = relayPipePath('0123456789abcdef0123456789abcdef');
    const endpoint = relayPipeEndpoint(pipe, RELAY);
    expect(endpoint).toBe(`ws+unix:${pipe}:${RELAY}`);
    expect(wsSplit(endpoint)).toEqual({ socketPath: pipe, path: RELAY });
  });

  it('the spellings with // do not reach the pipe', () => {
    const name = `${RELAY_PIPE_PREFIX}0123456789abcdef0123456789abcdef`;
    // The `.` segment goes in URL parsing: a UNC path to a host called "pipe".
    expect(wsSplit(`ws+unix:////./pipe/${name}:${RELAY}`).socketPath).toBe(`//pipe/${name}`);
    expect(() => new URL(`ws+unix://\\\\.\\pipe\\${name}:${RELAY}`)).toThrow();
    expect(wsSplit(`ws+unix:///\\\\.\\pipe\\${name}:${RELAY}`).socketPath).toBe(`/\\\\.\\pipe\\${name}`);
  });

  it('refuses anything but a relay pipe path', () => {
    expect(() => relayPipeEndpoint('\\\\.\\pipe\\x:y', RELAY)).toThrow();
    expect(() => relayPipeEndpoint('/tmp/r.sock', RELAY)).toThrow();
  });
});

describe('the owner-only DACL', () => {
  it('reads what the relay sets back as owner-only (GA reads back as FA)', () => {
    expect(isOwnerOnlyDacl(parseDacl(`D:P(A;;FA;;;SY)(A;;FA;;;${SID})`), SID)).toBe(true);
    expect(isOwnerOnlyDacl(parseDacl(`D:P(A;;FA;;;${SID})(A;;0x1F01FF;;;SY)`), SID)).toBe(true);
    expect(ownerOnlyDaclSddl(SID)).toBe(`D:P(A;;GA;;;SY)(A;;GA;;;${SID})`);
  });

  it('takes the alias SDDL writes for some accounts (LA for the built-in Administrator)', () => {
    const admin = 'S-1-5-21-1000-2000-3000-500';
    expect(isOwnerOnlyDacl(parseDacl('D:P(A;;FA;;;SY)(A;;FA;;;LA)'), admin)).toBe(false);
    expect(isOwnerOnlyDacl(parseDacl('D:P(A;;FA;;;SY)(A;;FA;;;LA)'), [admin, 'LA'])).toBe(true);
    // An alias is not a pass for anyone else.
    expect(isOwnerOnlyDacl(parseDacl('D:P(A;;FA;;;SY)(A;;FA;;;LG)'), [admin, 'LA'])).toBe(false);
  });

  it.each([
    ['the default pipe DACL', `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${SID})(A;;FR;;;WD)(A;;FR;;;AN)`],
    ['not protected', `D:(A;;FA;;;SY)(A;;FA;;;${SID})`],
    ['an extra entry', `D:P(A;;FA;;;SY)(A;;FA;;;${SID})(A;;FR;;;WD)`],
    ['another user', 'D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1-2-3-4)'],
    ['an inherited entry', `D:P(A;ID;FA;;;SY)(A;;FA;;;${SID})`],
    ['a deny entry', `D:P(D;;FA;;;SY)(A;;FA;;;${SID})`],
    ['read only', `D:P(A;;FA;;;SY)(A;;FR;;;${SID})`],
    ['SYSTEM twice', 'D:P(A;;FA;;;SY)(A;;FA;;;SY)'],
    ['not a DACL', 'O:SYG:SY'],
  ])('refuses %s', (_name, sddl) => {
    expect(isOwnerOnlyDacl(parseDacl(sddl), SID)).toBe(false);
  });

  it('refuses to build a DACL for something that is not a SID', () => {
    expect(() => ownerOnlyDaclSddl('S-1-5-21)(A;;GA;;;WD')).toThrow();
  });
});
