/**
 * #2398 — the daemon died with 0xC0000005 when many ConPTY panes exited at
 * once: node-pty 1.1.0's conpty.cc kept `ptyHandles` in a global vector with
 * no lock, erased from it on every pane's exit-watch thread, and spawned into
 * it from the main thread. 1.2.0-beta.15 guards it with g_ptyHandlesMutex.
 *
 * The burst runs in a child process so the crash is an exit status rather
 * than the death of the test runner. It uses the bundled conpty.dll, wmux's
 * Windows default, whose kill is a direct TerminateProcess; the in-box path
 * staggers its kills and did not reproduce.
 *
 * WMUX_TEST_NODE_PTY_DIR points the burst at another node-pty install, to
 * show the same test failing on 1.1.0.
 *
 * Skipped off Windows.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const onWindows = process.platform === 'win32';
const nodePtyDir = process.env.WMUX_TEST_NODE_PTY_DIR || path.dirname(createRequire(__filename).resolve('node-pty/package.json'));

/** Each round: spawn KILLED shells, kill them all at once, spawn RESPAWNED more right away. */
const BURST = `
const pty = require(process.env.BURST_NODE_PTY);
const [killed, respawned, rounds] = ['BURST_KILLED', 'BURST_RESPAWNED', 'BURST_ROUNDS'].map((k) => Number(process.env[k]));
const shell = require('node:path').join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnMany = (n) => Array.from({ length: n }, () => {
  const p = pty.spawn(shell, ['-NoLogo', '-NoProfile'], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: process.env, useConpty: true, useConptyDll: true,
  });
  p.onData(() => {});
  return p;
});
(async () => {
  for (let r = 0; r < rounds; r++) {
    const first = spawnMany(killed);
    await sleep(1500);
    for (const p of first) p.kill();
    const second = spawnMany(respawned);
    await sleep(3000);
    for (const p of second) p.kill();
    await sleep(1500);
    console.log('round ' + r + ' survived');
  }
  console.log('SURVIVED');
  // node-pty's conout workers can keep the loop alive; the verdict is in.
  process.exit(0);
})();
`;

describe.skipIf(!onWindows)('node-pty mass ConPTY exit (win32 only)', () => {
  it('22 panes killed at once while 10 more spawn does not crash the process', () => {
    const result = spawnSync(process.execPath, ['-e', BURST], {
      encoding: 'utf8',
      timeout: 150_000,
      windowsHide: true,
      env: { ...process.env, BURST_NODE_PTY: nodePtyDir, BURST_KILLED: '22', BURST_RESPAWNED: '10', BURST_ROUNDS: '4' },
    });
    const status = result.status === null ? 'none' : `0x${(result.status >>> 0).toString(16)}`;
    const rounds = (result.stdout ?? '').split('\n').filter((l) => l.includes('survived')).length;
    expect({ status, signal: result.signal, survivedRounds: rounds }, (result.stderr ?? '').slice(-2000))
      .toEqual({ status: '0x0', signal: null, survivedRounds: 4 });
    expect(result.stdout).toContain('SURVIVED');
  }, 180_000);
});
