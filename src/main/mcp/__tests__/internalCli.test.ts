// Source-invariant guard for WMUX_CLI_METHODS (mirrors firstParty.test.ts).
//
// The internal-CLI allowlist (internalCli.ts) must stay a superset of every
// MAIN-PIPE RPC method `wmux <command>` actually calls — otherwise, once the
// legacy grandfather is closed (trust-root plan Stage 3), that CLI command
// silently breaks under enforce mode. Rather than trust a hand-maintained list,
// this test parses the real CLI source (src/cli/**) for every `sendRequest(...)`
// method literal and fails if any valid RpcMethod is missing from the allowlist.
//
// Daemon-control-pipe calls are EXCLUDED: the CLI reaches the daemon pipe via
// `sendDaemonRequest` / `sendRequestToPipe(daemonPipe, method, ...)` (the method
// is the SECOND arg), which this `\bsendRequest\(` regex deliberately does not
// match — those go to the DaemonPipeServer, which has no enforcer.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WMUX_CLI_METHODS, WMUX_CLI_CLIENT_NAME, isInternalCliClient } from '../internalCli';
import { METHOD_CAPABILITY, resolveRequiredCapability } from '../methodCapabilityMap';
import type { RpcMethod } from '../../../shared/rpc';

// src/main/mcp/__tests__ -> src/cli
const CLI_DIR = path.resolve(__dirname, '..', '..', '..', 'cli');

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

// Match `sendRequest('method'` and `sendRequest<T>('method'` — the main-pipe
// call. Deliberately NOT `sendRequestToPipe(` / `sendDaemonRequest(`: those put
// the method in a later arg and target the daemon control pipe.
function extractCalledMethods(): Set<string> {
  const called = new Set<string>();
  const re = /\bsendRequest(?:<[^>]*>)?\(\s*'([a-zA-Z0-9_.]+)'/g;
  for (const file of collectTsFiles(CLI_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      called.add(m[1]);
    }
  }
  return called;
}

const VALID_METHODS = new Set<string>(Object.keys(METHOD_CAPABILITY));

describe('WMUX_CLI_METHODS source invariant', () => {
  it('found a non-trivial set of CLI RPC calls (parser sanity)', () => {
    const called = extractCalledMethods();
    expect(called.size).toBeGreaterThan(10);
  });

  it('covers every valid main-pipe RpcMethod the CLI calls', () => {
    const called = extractCalledMethods();
    const missing = [...called]
      .filter((m) => VALID_METHODS.has(m)) // drop non-RPC literals (file names, etc.)
      .filter((m) => !m.startsWith('daemon.') && !m.startsWith('lanlink.')) // daemon-pipe, no enforcer
      .filter((m) => !WMUX_CLI_METHODS.has(m as RpcMethod))
      .sort();
    expect(
      missing,
      `These methods are called via sendRequest() in src/cli/** but are missing ` +
        `from WMUX_CLI_METHODS — add them to internalCli.ts or the CLI command ` +
        `breaks once the grandfather closes:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every entry in WMUX_CLI_METHODS is a real RpcMethod (no typos / dead entries)', () => {
    const bogus = [...WMUX_CLI_METHODS].filter((m) => !VALID_METHODS.has(m)).sort();
    expect(bogus, `WMUX_CLI_METHODS contains non-RpcMethod entries`).toEqual([]);
  });

  it('does not allowlist destructive control surface the CLI never calls (least privilege)', () => {
    // The CLI legitimately does workspace/surface lifecycle (wmux workspace new,
    // wmux surface close), so those ARE allowed — but daemon control and company
    // mutation must never be reachable through the wmux-cli tier.
    for (const m of [
      'daemon.shutdown',
      'daemon.compact',
      'company.create',
      'company.destroy',
    ] as const) {
      expect(WMUX_CLI_METHODS.has(m as RpcMethod)).toBe(false);
    }
  });

  it('the reserved (wmux.internal) methods it grants are exactly the ones the CLI calls', () => {
    const reserved = (Object.keys(METHOD_CAPABILITY) as RpcMethod[]).filter(
      (m) => resolveRequiredCapability(METHOD_CAPABILITY[m], {}) === 'wmux.internal',
    );
    // The CLI is a user-driven first-party tool, so unlike the bundled MCP server
    // it legitimately drives workspace/surface LIFECYCLE + notify (all reserved,
    // hence undeclarable — name-recognition is the only path that reaches them).
    const ALLOWED_RESERVED_CLI = new Set<RpcMethod>([
      'workspace.new',
      'workspace.focus',
      'workspace.close',
      'surface.list',
      'surface.new',
      'surface.focus',
      'surface.close',
      'notify',
    ]);
    const leaked = reserved
      .filter((m) => WMUX_CLI_METHODS.has(m))
      .filter((m) => !ALLOWED_RESERVED_CLI.has(m))
      .sort();
    expect(
      leaked,
      `WMUX_CLI_METHODS grants reserved wmux.internal methods beyond the curated ` +
        `CLI set. Either the CLI should not call these, or widen ` +
        `ALLOWED_RESERVED_CLI here with explicit security review:\n  ${leaked.join('\n  ')}`,
    ).toEqual([]);

    // Keep the exception set honest: every entry must still be reserved AND still
    // be granted (else it is stale).
    for (const m of ALLOWED_RESERVED_CLI) {
      expect(reserved.includes(m), `${m} is no longer wmux.internal — re-review`).toBe(true);
      expect(WMUX_CLI_METHODS.has(m), `${m} was dropped from WMUX_CLI_METHODS`).toBe(true);
    }

    // Least-privilege direction: a reserved grant is only justified while the CLI
    // actually calls the method.
    const called = extractCalledMethods();
    const stale = [...ALLOWED_RESERVED_CLI].filter((m) => !called.has(m)).sort();
    expect(
      stale,
      `These reserved methods are granted but no longer called by src/cli/** — ` +
        `prune them (least privilege):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('isInternalCliClient', () => {
  it('recognizes only the exact wmux-cli clientName', () => {
    expect(isInternalCliClient(WMUX_CLI_CLIENT_NAME)).toBe(true);
    expect(WMUX_CLI_CLIENT_NAME).toBe('wmux-cli');
    for (const name of [undefined, '', 'wmux', 'wmux-CLI', 'WMUX-CLI', 'claude-code', 'evil']) {
      expect(isInternalCliClient(name as string | undefined)).toBe(false);
    }
  });
});
