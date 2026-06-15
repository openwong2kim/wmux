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

  // Belt regression for the #113 first-party residual-risk follow-up.
  //
  // The first-party bypass's ONLY incremental power over the normal
  // declare/approve flow is the set of `wmux.internal` methods: permissionGrammar
  // reserves the `wmux.*` prefix, so a reserved method can NEVER appear in a
  // plugin declaration, which means name-recognition is the only code path that
  // can ever reach one. So the security-relevant invariant is precisely: which
  // RESERVED methods may the bypass touch? Pin that to the curated read/observe +
  // company-scoped agent-messaging set. Everything else reserved — daemon
  // control, workspace/surface lifecycle, company mutation, hooks.signal, notify
  // — must stay unreachable through the bypass. The reserved set is DERIVED from
  // METHOD_CAPABILITY (not hand-listed), so a newly-added `wmux.internal` method
  // that someone also drops into FIRST_PARTY_METHODS trips this test unless it is
  // consciously added to the exception set below.
  it('first-party never reaches a reserved (wmux.internal) method outside the curated read/messaging exceptions', () => {
    const reserved = (Object.keys(METHOD_CAPABILITY) as RpcMethod[]).filter(
      (m) => METHOD_CAPABILITY[m].capability === 'wmux.internal',
    );

    // The ONLY reserved methods the bundled first-party server legitimately
    // calls: a workspace/window read and the company-scoped A2A messaging tools.
    // These are observe/message surfaces, not lifecycle or mutation.
    const ALLOWED_RESERVED_FIRST_PARTY = new Set<RpcMethod>([
      'surface.list',
      'company.a2a.whoami',
      'company.a2a.send',
      'company.a2a.broadcast',
      'company.a2a.inbox',
      'company.a2a.ack',
      'company.a2a.status',
    ]);

    const leaked = reserved
      .filter((m) => FIRST_PARTY_METHODS.has(m))
      .filter((m) => !ALLOWED_RESERVED_FIRST_PARTY.has(m))
      .sort();
    expect(
      leaked,
      `FIRST_PARTY_METHODS grants reserved wmux.internal lifecycle/mutation ` +
        `methods the name-recognition bypass must never reach. Either the bundled ` +
        `server should not call these, or — if one is genuinely required — widen ` +
        `ALLOWED_RESERVED_FIRST_PARTY here with explicit security review:\n  ${leaked.join(
          '\n  ',
        )}`,
    ).toEqual([]);

    // Keep the exception set honest: every curated entry must still be a reserved
    // method AND still be in the allowlist, or it is stale and should be pruned.
    for (const m of ALLOWED_RESERVED_FIRST_PARTY) {
      expect(
        reserved.includes(m),
        `${m} is no longer wmux.internal in methodCapabilityMap — re-review whether it still belongs in the first-party reserved exception`,
      ).toBe(true);
      expect(
        FIRST_PARTY_METHODS.has(m),
        `${m} was dropped from FIRST_PARTY_METHODS — remove it from ALLOWED_RESERVED_FIRST_PARTY`,
      ).toBe(true);
    }

    // Least-privilege direction: a reserved grant is only justified while the
    // bundled server actually CALLS the method. If a tool is removed from
    // src/mcp/**, its undeclarable wmux.internal grant must not linger as
    // stale attack surface for a clientName impersonator.
    const called = extractCalledMethods();
    const stale = [...ALLOWED_RESERVED_FIRST_PARTY].filter((m) => !called.has(m)).sort();
    expect(
      stale,
      `These reserved methods are first-party-granted but no longer called by ` +
        `src/mcp/** — prune them from FIRST_PARTY_METHODS and from ` +
        `ALLOWED_RESERVED_FIRST_PARTY (least privilege):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('isFirstPartyClient', () => {
  it('recognizes the verified agent hosts, rejects everything else', () => {
    // Empirically-captured agent MCP clientInfo.name values (see firstParty.ts).
    expect(isFirstPartyClient('claude-code')).toBe(true);
    expect(isFirstPartyClient('codex-mcp-client')).toBe(true);
    expect(FIRST_PARTY_CLIENT_NAMES.has('claude-code')).toBe(true);
    expect(FIRST_PARTY_CLIENT_NAMES.has('codex-mcp-client')).toBe(true);
    // Near-misses and impersonation attempts must NOT be first-party (exact match).
    for (const name of [undefined, '', 'claude', 'Claude-Code', 'codex', 'Codex', 'evil', 'wmux-orchestrator-e2e']) {
      expect(isFirstPartyClient(name as string | undefined)).toBe(false);
    }
  });
});
