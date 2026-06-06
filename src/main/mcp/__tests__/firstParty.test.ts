// Source-invariant guard for FIRST_PARTY_METHODS.
//
// The first-party allowlist (firstParty.ts) must stay a superset of every RPC
// method the bundled MCP server actually calls — otherwise a tool silently
// breaks under enforce mode. Rather than trust a hand-maintained list, this
// test parses the real bundled-server source (src/mcp/**) for every
// callRpc/sendRpc method literal and fails if any valid RpcMethod is missing
// from the allowlist. Add a tool that calls a new RPC → this test tells you to
// allowlist it.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FIRST_PARTY_CLIENT_NAMES, FIRST_PARTY_METHODS, isFirstPartyClient } from '../firstParty';
import { METHOD_CAPABILITY } from '../methodCapabilityMap';
import type { RpcMethod } from '../../../shared/rpc';

// src/main/mcp/__tests__ -> src/mcp
const MCP_DIR = path.resolve(__dirname, '..', '..', '..', 'mcp');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function extractCalledMethods(): Set<string> {
  const called = new Set<string>();
  const re = /\b(?:callRpc|sendRpc)\(\s*'([a-zA-Z0-9_.]+)'/g;
  for (const file of collectTsFiles(MCP_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      called.add(m[1]);
    }
  }
  return called;
}

const VALID_METHODS = new Set<string>(Object.keys(METHOD_CAPABILITY));

describe('FIRST_PARTY_METHODS source invariant', () => {
  it('found a non-trivial set of bundled-server RPC calls (parser sanity)', () => {
    const called = extractCalledMethods();
    // If this drops near zero the regex/path broke and the invariant is vacuous.
    expect(called.size).toBeGreaterThan(20);
  });

  it('covers every valid RpcMethod the bundled MCP server calls', () => {
    const called = extractCalledMethods();
    const missing = [...called]
      .filter((m) => VALID_METHODS.has(m)) // drop event-topic strings (pane.closed, ...)
      .filter((m) => !FIRST_PARTY_METHODS.has(m as RpcMethod))
      .sort();
    expect(
      missing,
      `These methods are called by src/mcp/** but missing from FIRST_PARTY_METHODS — ` +
        `add them to firstParty.ts or the tool will break under enforce mode:\n  ${missing.join(
          '\n  ',
        )}`,
    ).toEqual([]);
  });

  it('every entry in FIRST_PARTY_METHODS is a real RpcMethod (no typos / dead entries)', () => {
    const bogus = [...FIRST_PARTY_METHODS].filter((m) => !VALID_METHODS.has(m)).sort();
    expect(bogus, `FIRST_PARTY_METHODS contains non-RpcMethod entries`).toEqual([]);
  });

  it('does not allowlist reserved/destructive surface (least privilege)', () => {
    // These must NEVER be first-party-granted; the bundled server does not call
    // them and a clientName impersonator must not reach them.
    for (const m of [
      'daemon.shutdown',
      'daemon.compact',
      'workspace.new',
      'workspace.close',
      'company.create',
      'company.destroy',
    ] as const) {
      expect(FIRST_PARTY_METHODS.has(m)).toBe(false);
    }
  });
});

describe('isFirstPartyClient', () => {
  it('recognizes claude-code, rejects everything else', () => {
    expect(isFirstPartyClient('claude-code')).toBe(true);
    expect(FIRST_PARTY_CLIENT_NAMES.has('claude-code')).toBe(true);
    for (const name of [undefined, '', 'claude', 'Claude-Code', 'evil', 'wmux-orchestrator-e2e']) {
      expect(isFirstPartyClient(name as string | undefined)).toBe(false);
    }
  });
});
