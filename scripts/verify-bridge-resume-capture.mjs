#!/usr/bin/env node
// Dynamic verification for X6 ③ (resume-by-id) bridge capture:
//   - agentSessionId is derived from basename(transcript_path) WITHOUT the
//     .jsonl extension, NOT payload.session_id (upstream #12235: `--resume`
//     mints a new session_id but appends to the same transcript file, so the
//     filename is the only stable handle on the ORIGIN conversation).
//   - permissionMode is extracted from the LAST user turn of the transcript
//     (F5), for Stop AND SessionStart kinds (live capture, not teardown).
//   - SessionStart before the transcript exists (F9) still yields the id, with
//     permissionMode absent until the first turn lands.
//
// Strategy mirrors verify-bridge-env-capture.mjs: spawn the bridge with
// WMUX_BRIDGE_DEBUG=1, feed a hook JSON on stdin, parse the
// WMUX_BRIDGE_DEBUG_ENVELOPE=... line from stderr. The envelope dump happens
// before the RPC, so no daemon is required. Exits 0 on all passing, 1 on any
// mismatch.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  EXECUTABLE_NAME,
  authTokenPath as appAuthTokenPath,
} from './helpers/packaged-app.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, '..', 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');

const tmpHome = mkdtempSync(join(tmpdir(), `${EXECUTABLE_NAME}-bridge-resume-`));
writeFileSync(appAuthTokenPath(tmpHome, ''), 'fake-verification-token');

// A transcript JSONL line for a user turn stamped with a permission mode (F5).
const userLine = (mode) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hi' },
    permissionMode: mode,
    cwd: 'C:\\fake',
    version: '2.1.177',
    gitBranch: 'main',
  });
const assistantLine = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 } } });

function writeTranscript(name, lines) {
  const p = join(tmpHome, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const ORIGIN_ID = '86b7e519-aaaa-bbbb-cccc-000000000001';
const bypassTranscript = writeTranscript(`${ORIGIN_ID}.jsonl`, [userLine('bypassPermissions'), assistantLine()]);
// Last user turn wins: starts in bypass, switches to acceptEdits.
const switchTranscript = writeTranscript('switch-mode-session.jsonl', [
  userLine('bypassPermissions'),
  assistantLine(),
  userLine('acceptEdits'),
]);
const nonexistentTranscript = join(tmpHome, 'never-written-yet-session.jsonl');

const cases = [
  {
    name: '#12235: id = transcript basename, NOT payload.session_id',
    hook: 'Stop',
    payload: { session_id: 'DRIFTED-on-resume-9999', transcript_path: bypassTranscript, cwd: 'C:\\fake' },
    expect: { agentSessionId: ORIGIN_ID, permissionMode: 'bypassPermissions' },
  },
  {
    name: 'permissionMode = last user turn (acceptEdits overrides earlier bypass)',
    hook: 'Stop',
    payload: { session_id: 's2', transcript_path: switchTranscript, cwd: 'C:\\fake' },
    expect: { agentSessionId: 'switch-mode-session', permissionMode: 'acceptEdits' },
  },
  {
    name: 'SessionStart also captures (id + mode)',
    hook: 'SessionStart',
    payload: { session_id: 's3', transcript_path: bypassTranscript, cwd: 'C:\\fake' },
    expect: { agentSessionId: ORIGIN_ID, permissionMode: 'bypassPermissions' },
  },
  {
    name: 'F9: SessionStart before transcript exists → id present, mode absent',
    hook: 'SessionStart',
    payload: { session_id: 's4', transcript_path: nonexistentTranscript, cwd: 'C:\\fake' },
    expect: { agentSessionId: basename(nonexistentTranscript).replace(/\.jsonl$/, ''), permissionMode: undefined },
  },
];

let failures = 0;
for (const tc of cases) {
  const childEnv = { PATH: process.env.PATH, USERPROFILE: tmpHome, HOME: tmpHome, WMUX_BRIDGE_DEBUG: '1' };
  const proc = spawn(process.execPath, [BRIDGE, tc.hook], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write(JSON.stringify(tc.payload));
  proc.stdin.end();
  let stderr = '';
  proc.stderr.on('data', (b) => { stderr += b.toString(); });
  // eslint-disable-next-line no-await-in-loop
  await new Promise((res) => proc.on('close', res));
  const match = /WMUX_BRIDGE_DEBUG_ENVELOPE=(.+)/.exec(stderr);
  if (!match) {
    console.error(`FAIL [${tc.name}] — no debug envelope. stderr:\n${stderr.slice(0, 400)}`);
    failures += 1;
    continue;
  }
  let envelope;
  try {
    envelope = JSON.parse(match[1]);
  } catch (err) {
    console.error(`FAIL [${tc.name}] — bad envelope JSON: ${String(err)}`);
    failures += 1;
    continue;
  }
  const checks = Object.entries(tc.expect).map(([k, v]) => ({ k, expected: v, actual: envelope[k], ok: envelope[k] === v }));
  if (checks.every((c) => c.ok)) {
    console.log(`PASS [${tc.name}] — agentSessionId=${envelope.agentSessionId}, permissionMode=${envelope.permissionMode ?? 'undef'}`);
  } else {
    failures += 1;
    console.error(`FAIL [${tc.name}]`);
    for (const c of checks) if (!c.ok) console.error(`  - ${c.k}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`);
  }
}

rmSync(tmpHome, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log('\nAll bridge resume-capture cases passed.');
