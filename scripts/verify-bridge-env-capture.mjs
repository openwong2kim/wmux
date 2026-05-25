#!/usr/bin/env node
// Dynamic verification for Codex P1 #7 + 2026-05-25 dogfood fix:
//   - wmux-bridge.mjs must capture process.env.WMUX_WORKSPACE_ID /
//     WMUX_SURFACE_ID into the AgentSignal envelope (env-first routing).
//   - Empty env values must produce `undefined` envelope fields (not "").
//   - Cwd from payload.cwd should override process.cwd() when present.
//
// Strategy: spawn the bridge with WMUX_BRIDGE_DEBUG=1, feed a minimal
// Stop hook JSON on stdin, and read the WMUX_BRIDGE_DEBUG_ENVELOPE=...
// line from stderr. Assert the captured fields match the env vars set
// for the spawn. No wmux daemon is required — the bridge's pipe RPC
// will fail (no daemon at the fake pipe path), but the envelope dump
// happens *before* the RPC, so we still get our evidence.
//
// Exits 0 on all assertions passing, 1 on any mismatch. Prints a short
// pass/fail line per case so the harness output is grep-able.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, '..', 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');

const cases = [
  {
    name: 'both env vars present',
    env: { WMUX_WORKSPACE_ID: 'ws-test-1', WMUX_SURFACE_ID: 'surface-test-1' },
    payload: { session_id: 'sess-1', cwd: 'C:\\fake\\path' },
    expect: { workspaceId: 'ws-test-1', surfaceId: 'surface-test-1', cwd: 'C:\\fake\\path' },
  },
  {
    name: 'workspaceId only',
    env: { WMUX_WORKSPACE_ID: 'ws-test-2' },
    payload: { session_id: 'sess-2' },
    expect: { workspaceId: 'ws-test-2', surfaceId: undefined },
  },
  {
    name: 'empty env strings → undefined envelope fields',
    env: { WMUX_WORKSPACE_ID: '', WMUX_SURFACE_ID: '' },
    payload: { session_id: 'sess-3' },
    expect: { workspaceId: undefined, surfaceId: undefined },
  },
  {
    name: 'no env at all → undefined envelope fields',
    env: {},
    payload: { session_id: 'sess-4' },
    expect: { workspaceId: undefined, surfaceId: undefined },
  },
];

// Create a temp dir so we don't pollute ~/.wmux/bridge.log with verification runs.
const tmpHome = mkdtempSync(join(tmpdir(), 'wmux-bridge-verify-'));
// Bridge bails before envelope build when `~/.wmux-auth-token` is missing
// (production correctness — token must exist before sending RPC). Drop a
// fake token so the envelope is built and the debug dump runs. The token
// never leaves the bridge in this test because the RPC will fail at the
// named pipe step (no daemon at the fake pipe path).
writeFileSync(join(tmpHome, '.wmux-auth-token'), 'fake-verification-token');

let failures = 0;
for (const tc of cases) {
  const childEnv = {
    PATH: process.env.PATH,
    USERPROFILE: tmpHome,
    HOME: tmpHome,
    WMUX_BRIDGE_DEBUG: '1',
    ...tc.env,
  };
  const proc = spawn(process.execPath, [BRIDGE, 'Stop'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write(JSON.stringify(tc.payload));
  proc.stdin.end();
  let stderr = '';
  proc.stderr.on('data', (b) => { stderr += b.toString(); });
  // eslint-disable-next-line no-await-in-loop
  await new Promise((res) => proc.on('close', res));
  const match = /WMUX_BRIDGE_DEBUG_ENVELOPE=(.+)/.exec(stderr);
  if (!match) {
    console.error(`FAIL [${tc.name}] — no debug envelope in stderr. stderr was:\n${stderr.slice(0, 400)}`);
    failures += 1;
    continue;
  }
  let envelope;
  try {
    envelope = JSON.parse(match[1]);
  } catch (err) {
    console.error(`FAIL [${tc.name}] — could not parse envelope JSON: ${String(err)}`);
    failures += 1;
    continue;
  }
  const checks = [];
  for (const [k, v] of Object.entries(tc.expect)) {
    const actual = envelope[k];
    const ok = actual === v;
    checks.push({ k, expected: v, actual, ok });
  }
  const allOk = checks.every((c) => c.ok);
  if (allOk) {
    console.log(`PASS [${tc.name}] — envelope.workspaceId=${envelope.workspaceId ?? 'undef'}, surfaceId=${envelope.surfaceId ?? 'undef'}, cwd=${envelope.cwd}`);
  } else {
    failures += 1;
    console.error(`FAIL [${tc.name}]`);
    for (const c of checks) {
      if (!c.ok) console.error(`  - ${c.k}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
    }
  }
}

rmSync(tmpHome, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log('\nAll bridge env-capture cases passed.');
