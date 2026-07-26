// `wmux mcp clients` — the trust-DB reader behind the discoverability half of
// issue #636.
//
// Separate from mcp.test.ts because that file mocks `fs` wholesale; this one
// needs real files on a tmpdir. It reads plugin-trust.json directly (not over
// RPC) so it keeps working with the app closed — which is exactly when someone
// is editing config.json to add a first-party name.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readObservedClients } from '../mcp';

const tmpDirs: string[] = [];

function writeTrust(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-clients-test-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'plugin-trust.json');
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readObservedClients', () => {
  it('lists observed clients most-recently-seen first', () => {
    const p = writeTrust(
      JSON.stringify({
        schemaVersion: 1,
        plugins: {
          'claude-code': { name: 'claude-code', version: '2.1.220', status: 'unconfirmed', firstSeen: 1, lastSeen: 100 },
          mcp: { name: 'mcp', version: '0.1.0', status: 'unconfirmed', firstSeen: 5, lastSeen: 900 },
        },
      }),
    );
    const out = readObservedClients(p);
    expect(out?.map((c) => c.name)).toEqual(['mcp', 'claude-code']);
    expect(out?.[0].version).toBe('0.1.0');
    expect(out?.[0].status).toBe('unconfirmed');
  });

  it('flags the SDK-default name as not configurable', () => {
    // The whole reason this command exists: an operator seeing `mcp` here must
    // be told they cannot allowlist it, not left to paste it into config.json.
    const p = writeTrust(
      JSON.stringify({
        plugins: { mcp: { name: 'mcp', version: '0.1.0', status: 'unconfirmed' } },
      }),
    );
    expect(readObservedClients(p)?.[0].nonIdentifying).toBe(true);
  });

  it('flags wmux-internal names too, and leaves real identities alone', () => {
    const p = writeTrust(
      JSON.stringify({
        plugins: {
          'wmux-cli': { name: 'wmux-cli', status: 'unconfirmed' },
          unknown: { name: 'unknown', status: 'unconfirmed' },
          'hermes-agent': { name: 'hermes-agent', status: 'unconfirmed' },
        },
      }),
    );
    const byName = new Map(readObservedClients(p)?.map((c) => [c.name, c]));
    expect(byName.get('wmux-cli')?.nonIdentifying).toBe(true);
    expect(byName.get('unknown')?.nonIdentifying).toBe(true);
    expect(byName.get('hermes-agent')?.nonIdentifying).toBe(false);
  });

  it('falls back to the record key when the entry has no name field', () => {
    const p = writeTrust(JSON.stringify({ plugins: { 'odd-client': { status: 'unconfirmed' } } }));
    expect(readObservedClients(p)?.[0].name).toBe('odd-client');
  });

  it('returns null when the file is missing or corrupt, and [] when it has no plugins', () => {
    expect(readObservedClients(path.join(os.tmpdir(), 'wmux-nope', 'plugin-trust.json'))).toBeNull();
    expect(readObservedClients(writeTrust('{ not json'))).toBeNull();
    expect(readObservedClients(writeTrust(JSON.stringify({ schemaVersion: 1 })))).toEqual([]);
  });

  it('skips malformed entries rather than dropping the whole listing', () => {
    const p = writeTrust(
      JSON.stringify({
        plugins: {
          good: { name: 'good', status: 'unconfirmed', lastSeen: 10 },
          bad: 'not-an-object',
          alsoBad: null,
        },
      }),
    );
    expect(readObservedClients(p)?.map((c) => c.name)).toEqual(['good']);
  });

  it('does not pollute Object.prototype via __proto__ in the trust file', () => {
    const p = writeTrust('{"__proto__":{"polluted":true},"plugins":{"a":{"name":"a","status":"unconfirmed"}}}');
    expect(readObservedClients(p)?.map((c) => c.name)).toEqual(['a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
