#!/usr/bin/env node
/**
 * Dynamic verification for the shared shell-resolution consolidation
 * (#183 / #185).
 *
 * Drives the COMPILED DaemonSessionManager directly (dist/daemon/...), so it
 * exercises the exact resolveShellPath() / getDefaultShell() code the daemon
 * runs — then spawns the resolved shell for real and probes the running
 * process. A path table that merely *returns* the right string is not enough:
 * dogfood (2026-06-10) found node-pty silently falls back to 5.1 when handed
 * the Store App Execution Alias stub, so the only trustworthy signal is the
 * live process's own $PSVersionTable.PSVersion.
 *
 * Scenarios (this machine has Store-only pwsh 7 — the original #179 repro):
 *   S1  default fallback  — createSession with NO cmd → getDefaultShell()
 *                           → expect a live pwsh 7.x (was 5.1 before the fix).
 *   S2  bare "pwsh.exe"    — resolveShellPath('pwsh.exe') → resolveBareShellName
 *                           → expect a live pwsh 7.x.
 *   S3  regression cmd.exe — resolveShellPath('cmd.exe') → System32\cmd.exe
 *                           → expect a working cmd shell (no pwsh assumptions).
 *
 * The probe marker is split ('PS'+'VER') so the command echo can never
 * self-match the polled output — only the executed result carries "PSVER=".
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGER_JS = path.join(REPO_ROOT, 'dist', 'daemon', 'daemon', 'DaemonSessionManager.js');

let DaemonSessionManager;
try {
  ({ DaemonSessionManager } = require(MANAGER_JS));
} catch (err) {
  console.error(`Failed to load compiled daemon (${MANAGER_JS}). Run \`npm run build:daemon\` first.`);
  console.error(err.message);
  process.exit(2);
}

if (process.platform !== 'win32') {
  console.error('This dynamic test targets Windows shell resolution. Skipping on non-Windows.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a session with the given cmd, run a probe line, and collect output
 * until `matcher` succeeds or we time out. Returns { resolvedCmd, output,
 * match }.
 */
async function runScenario(manager, { id, cmd, probeLine, matcher, settleMs = 1500, timeoutMs = 12_000 }) {
  const session = manager.createSession({ id, cmd, cwd: os.homedir() });
  const resolvedCmd = session.cmd;
  const managed = manager.getSession(id);
  if (!managed || !managed.ptyProcess) throw new Error('no ptyProcess on managed session');

  let output = '';
  const disposable = managed.ptyProcess.onData((d) => { output += d.toString(); });

  // Let the shell finish its cold start before typing, so the probe lands at
  // a live prompt rather than into the boot banner.
  await sleep(settleMs);
  managed.ptyProcess.write(probeLine + '\r');

  const deadline = Date.now() + timeoutMs;
  let match = null;
  while (Date.now() < deadline) {
    match = matcher(output);
    if (match) break;
    await sleep(150);
  }

  disposable.dispose?.();
  manager.destroySession(id);
  return { resolvedCmd, output, match };
}

const report = [];

async function main() {
  const manager = new DaemonSessionManager();

  // S1 — default fallback (no cmd): getWindowsDefaultShell()
  {
    const probe = `$m='PS'+'VER'; Write-Output "$m=$($PSVersionTable.PSVersion.ToString())"`;
    const { resolvedCmd, output, match } = await runScenario(manager, {
      id: 's1-default', cmd: undefined, probeLine: probe,
      matcher: (o) => o.match(/PSVER=(\d+)\.(\d+)\.(\d+)/),
    });
    const major = match ? Number(match[1]) : null;
    report.push({
      scenario: 'S1 default-fallback (getDefaultShell)',
      pass: major === 7,
      resolvedCmd, psVersion: match ? match.slice(1, 4).join('.') : null,
      note: 'Store-only box: pwsh 7 expected; 5.1 would mean the daemon fallback regressed',
      outputTail: major === 7 ? undefined : output.slice(-400).replace(/\s+/g, ' '),
    });
  }

  // S2 — bare "pwsh.exe": resolveShellPath → resolveBareShellName (Store alias)
  {
    const probe = `$m='PS'+'VER'; Write-Output "$m=$($PSVersionTable.PSVersion.ToString())"`;
    const { resolvedCmd, output, match } = await runScenario(manager, {
      id: 's2-bare-pwsh', cmd: 'pwsh.exe', probeLine: probe,
      matcher: (o) => o.match(/PSVER=(\d+)\.(\d+)\.(\d+)/),
    });
    const major = match ? Number(match[1]) : null;
    report.push({
      scenario: 'S2 bare-pwsh.exe (resolveBareShellName)',
      pass: major === 7,
      resolvedCmd, psVersion: match ? match.slice(1, 4).join('.') : null,
      note: 'bare name must resolve the Store alias to a spawnable target',
      outputTail: major === 7 ? undefined : output.slice(-400).replace(/\s+/g, ' '),
    });
  }

  // S3 — regression: cmd.exe still resolves and runs (no pwsh assumptions)
  {
    // cmd echo: split marker the same way so the typed line can't self-match.
    const probe = `echo CMD%CD:~0,0%OK_837`;
    const { resolvedCmd, output, match } = await runScenario(manager, {
      id: 's3-cmd', cmd: 'cmd.exe', probeLine: probe,
      matcher: (o) => o.match(/CMDOK_837/),
      settleMs: 800,
    });
    const resolvedIsCmd = /\\cmd\.exe$/i.test(resolvedCmd || '');
    report.push({
      scenario: 'S3 regression cmd.exe',
      pass: Boolean(match) && resolvedIsCmd,
      resolvedCmd, sawMarker: Boolean(match),
      outputTail: match && resolvedIsCmd ? undefined : output.slice(-400).replace(/\s+/g, ' '),
    });
  }

  manager.disposeAll();
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : String(reason));
});

await main();

console.log('\n=== SHELL-RESOLUTION DYNAMIC REPORT (#183/#185) ===');
for (const entry of report) console.log(JSON.stringify(entry));

const failed = report.filter((r) => r.pass === false);
if (failed.length > 0) {
  console.error(`\n[FAIL] ${failed.length} scenario(s) failed.`);
  process.exit(1);
}
console.log('\n[PASS] daemon resolves + spawns the correct shell on a Store-only pwsh 7 box.');
process.exit(0);
