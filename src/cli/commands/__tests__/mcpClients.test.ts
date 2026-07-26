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
import { readObservedClients, type ObservedClientsResult } from '../mcp';
import { MAX_PLUGIN_NAME_LEN } from '../../../shared/rpc';

const tmpDirs: string[] = [];

function writeTrust(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-clients-test-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'plugin-trust.json');
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

// Narrowing helper — every success-path assertion needs the clients array, and
// `expect(...).toBe(true)` does not narrow the union for TypeScript.
function clientsOf(result: ObservedClientsResult) {
  if (!result.ok) throw new Error(`expected ok result, got reason=${result.reason}`);
  return result.clients;
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
    const clients = clientsOf(readObservedClients(p));
    expect(clients.map((c) => c.name)).toEqual(['mcp', 'claude-code']);
    expect(clients[0].version).toBe('0.1.0');
    expect(clients[0].status).toBe('unconfirmed');
  });

  it('flags the SDK-default name as not configurable', () => {
    // The whole reason this command exists: an operator seeing `mcp` here must
    // be told they cannot allowlist it, not left to paste it into config.json.
    const p = writeTrust(
      JSON.stringify({
        plugins: { mcp: { name: 'mcp', version: '0.1.0', status: 'unconfirmed' } },
      }),
    );
    expect(clientsOf(readObservedClients(p))[0].nonIdentifying).toBe(true);
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
    const byName = new Map(clientsOf(readObservedClients(p)).map((c) => [c.name, c]));
    expect(byName.get('wmux-cli')?.nonIdentifying).toBe(true);
    expect(byName.get('unknown')?.nonIdentifying).toBe(true);
    expect(byName.get('hermes-agent')?.nonIdentifying).toBe(false);
  });

  it('falls back to the record key when the entry has no name field', () => {
    const p = writeTrust(JSON.stringify({ plugins: { 'odd-client': { status: 'unconfirmed' } } }));
    expect(clientsOf(readObservedClients(p))[0].name).toBe('odd-client');
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
    expect(clientsOf(readObservedClients(p)).map((c) => c.name)).toEqual(['good']);
  });

  it('does not pollute Object.prototype via __proto__ in the trust file', () => {
    const p = writeTrust('{"__proto__":{"polluted":true},"plugins":{"a":{"name":"a","status":"unconfirmed"}}}');
    expect(clientsOf(readObservedClients(p)).map((c) => c.name)).toEqual(['a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // --- read-failure reporting (codex P2) ---------------------------------
  // A caller must be able to tell "nothing has connected" from "I could not
  // read my own source". Collapsing both to an empty list would let a script
  // treat an unreadable trust DB as an authoritative "no clients".

  it('reports `absent` for a missing file, distinct from an empty DB', () => {
    const missing = readObservedClients(
      path.join(os.tmpdir(), 'wmux-nope-does-not-exist', 'plugin-trust.json'),
    );
    expect(missing).toEqual({ ok: false, reason: 'absent' });

    // A file that exists but records nothing is a real, authoritative empty.
    const empty = readObservedClients(writeTrust(JSON.stringify({ schemaVersion: 1 })));
    expect(empty).toEqual({ ok: true, clients: [] });
  });

  it('reports `unreadable` for corrupt JSON and a non-object root', () => {
    expect(readObservedClients(writeTrust('{ not json'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(readObservedClients(writeTrust('"a string"'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  // --- terminal safety (codex P1) ---------------------------------------
  // Names and versions are self-asserted and stored verbatim; the trust store
  // bounds their length but does not strip control characters. This listing
  // prints them, so a previously-connected client must not be able to repaint
  // the terminal or forge output around its own row.

  it('strips control characters from name, version, and status', () => {
    const p = writeTrust(
      JSON.stringify({
        plugins: {
          evil: {
            name: 'ev\u001b[31mil',
            version: '1.0\u0007]0;pwned',
            status: 'unconfirmed',
          },
        },
      }),
    );
    const c = clientsOf(readObservedClients(p))[0];
    for (const field of [c.name, c.version ?? '', c.status]) {
      expect(field).not.toContain('\u001b');
      expect(field).not.toContain('\u0007');
    }
    expect(c.name).toBe('ev[31mil');
    expect(c.version).toBe('1.0]0;pwned');
  });

  it('clips an over-long name to the stored bound', () => {
    const p = writeTrust(
      JSON.stringify({
        plugins: { long: { name: 'x'.repeat(MAX_PLUGIN_NAME_LEN + 50), status: 'unconfirmed' } },
      }),
    );
    expect(clientsOf(readObservedClients(p))[0].name.length).toBe(MAX_PLUGIN_NAME_LEN);
  });
});
