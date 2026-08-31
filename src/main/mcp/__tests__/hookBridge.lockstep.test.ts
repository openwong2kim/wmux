// Source-lockstep guard for the hook-bridge lane (#1111).
//
// The bridges under `integrations/<agent>/bin/` are standalone .mjs/.js
// scripts outside the main build, so nothing but this test keeps them in step
// with the enforcer. Two ways to silently break main-pipe turn-state
// reporting, both caught here:
//
//   1. A bridge stops sending the recognised clientName (or a typo drifts it)
//      -> its `hooks.signal` is refused as identity-status:legacy.
//   2. A bridge starts calling a main-pipe method outside HOOK_BRIDGE_METHODS
//      -> that call is refused, because the lane is deliberately one method.
//
// Failures here are actionable: either fix the bridge, or deliberately widen
// hookBridge.ts (and think about least privilege while doing it).

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HOOK_BRIDGE_METHODS, WMUX_HOOK_BRIDGE_CLIENT_NAME } from '../hookBridge';

// src/main/mcp/__tests__ -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const INTEGRATIONS = path.join(REPO_ROOT, 'integrations');

// Every bridge that talks to the MAIN pipe. Kept explicit rather than globbed
// so a NEW bridge is a deliberate addition here (the #1107 bridge included).
const BRIDGES = [
  path.join('claude', 'bin', 'wmux-bridge.mjs'),
  path.join('codex', 'bin', 'wmux-codex-notify.mjs'),
  path.join('kiro', 'bin', 'wmux-kiro-bridge.mjs'),
  path.join('openclaude', 'bin', 'wmux-bridge.mjs'),
  path.join('opencode', 'plugins', 'wmux.js'),
];

function readBridge(rel: string): string {
  return fs.readFileSync(path.join(INTEGRATIONS, rel), 'utf8');
}

describe('hook bridges — enforcer lockstep (#1111)', () => {
  it.each(BRIDGES)('%s sends the recognised clientName', (rel) => {
    const src = readBridge(rel);
    expect(
      src.includes(`'${WMUX_HOOK_BRIDGE_CLIENT_NAME}'`),
      `${rel} must declare clientName '${WMUX_HOOK_BRIDGE_CLIENT_NAME}' — without it the ` +
        `enforcer refuses its main-pipe hooks.signal as identity-status:legacy (#1111)`,
    ).toBe(true);
    expect(
      /clientName:/.test(src),
      `${rel} must actually put clientName on the request envelope`,
    ).toBe(true);
  });

  it.each(BRIDGES)('%s calls no main-pipe method outside the lane', (rel) => {
    const src = readBridge(rel);
    // Method names as they appear in the target tables / request builders.
    const found = new Set(
      [...src.matchAll(/method:\s*'([a-zA-Z][A-Za-z0-9]*\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]),
    );
    // `daemon.*` targets the DaemonPipeServer, which has no enforcer.
    const mainPipeMethods = [...found].filter((m) => !m.startsWith('daemon.'));
    const outside = mainPipeMethods.filter((m) => !HOOK_BRIDGE_METHODS.has(m as never));
    expect(
      outside,
      `${rel} calls main-pipe method(s) outside HOOK_BRIDGE_METHODS. Either route them ` +
        `through the daemon pipe or add them to src/main/mcp/hookBridge.ts deliberately.`,
    ).toEqual([]);
  });
});
