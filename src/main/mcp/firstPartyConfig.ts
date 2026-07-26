// Config loader for the operator-extensible first-party client list (#636).
//
// Why this exists
// ---------------
// `FIRST_PARTY_CLIENT_NAMES` (firstParty.ts) is compiled into the bundle, so
// recognising a new agent host meant edit source -> rebuild -> ship a release.
// This reads `mcp.firstPartyClients` from `~/.wmux/config.json` so an operator
// can extend the list for their own machine without a release.
//
// This module ONLY reads and shape-checks. It deliberately does NOT decide
// which names are acceptable: that gate lives in
// `setConfiguredFirstPartyClients` (firstParty.ts) so every caller — this
// loader, tests, any future Settings UI — passes through the same denylist.
// A reader that also authorised would be a second, bypassable gate.
//
// The JSON read mirrors `enforcementMode.ts` (which in turn mirrors
// `daemon/config.ts`): same prototype-pollution reviver, same
// tolerate-everything failure posture. The duplication is deliberate and
// pre-existing in this codebase — each config consumer owns its own read so a
// change to one section's parsing cannot silently alter another's.

import * as fs from 'fs';
import { getConfigPath } from '../../daemon/config';

export interface FirstPartyClientsReadOptions {
  /** Override the config path for tests. */
  configPath?: string;
}

/**
 * Candidate first-party client names declared in `~/.wmux/config.json` under
 * `mcp.firstPartyClients`. Returns trimmed, non-empty strings in file order.
 *
 * Fail-closed in every failure mode — missing file, unreadable file, invalid
 * JSON, wrong shape, non-string entries — all yield `[]`, which leaves the
 * compiled defaults as the only recognised names. A malformed config must
 * never widen recognition, and must never prevent boot.
 */
export function readConfiguredFirstPartyClients(
  opts: FirstPartyClientsReadOptions = {},
): string[] {
  const cfgPath = opts.configPath ?? getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value) => {
      // Prototype pollution guard — mirrors daemon/config.ts.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const mcp = (parsed as Record<string, unknown>).mcp;
  if (!mcp || typeof mcp !== 'object') return [];
  const list = (mcp as Record<string, unknown>).firstPartyClients;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    // `clientName` is already trimmed by PipeServer when it builds RpcContext,
    // so trim here too or a config entry with stray whitespace would silently
    // never match the name it was meant to allow.
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}
