// Another account against the relay pipe, on a GitHub-hosted Windows runner
// only: the runner is a throwaway VM, so the test may create a local account
// there. Never anywhere else (a developer's PC keeps its accounts as they are).
//
// Control first: under the default DACL the other account can open the pipe
// for reading. Then, once narrow() has run, it cannot open it at all.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPipeSecurity, relayPipePath, type PipeSecurity } from '../relayPipeWin';

const onHostedRunner = process.platform === 'win32'
  && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted';

const user = `wmuxci${randomBytes(3).toString('hex')}`;
const password = `Aa1!${randomBytes(12).toString('hex')}`;
const servers: net.Server[] = [];

/**
 * The credentials go through the environment, never on a command line.
 * PSModulePath is left out: a CI step run under pwsh 7 hands down its own
 * module path, and Windows PowerShell 5.1 then fails to load its built-in
 * modules (ConvertTo-SecureString, New-LocalUser). Without it, 5.1 uses its
 * default.
 */
function powershell(script: string, env: Record<string, string> = {}): string {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'));
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...inherited, WMUX_CI_USER: user, WMUX_CI_PASSWORD: password, ...env },
    timeout: 60_000,
  });
}

/**
 * Exit code of a pwsh, started as the other account, that opens `pipePath`
 * for reading (.NET Core opens \\.\ paths; Windows PowerShell's .NET does
 * not). 0 opened, 5 access denied, 9 anything else.
 */
function openAsOtherAccount(pipePath: string): number {
  const child = [
    '$p = $env:WMUX_PIPE;',
    "try { $s = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); $s.Dispose(); exit 0 }",
    'catch [System.UnauthorizedAccessException] { exit 5 }',
    'catch { exit 9 }',
  ].join(' ');
  const out = powershell([
    '$pw = ConvertTo-SecureString $env:WMUX_CI_PASSWORD -AsPlainText -Force;',
    '$cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\\$env:WMUX_CI_USER", $pw);',
    `$p = Start-Process -FilePath pwsh -ArgumentList @('-NoProfile','-NonInteractive','-Command','${child.replace(/'/g, "''")}') -Credential $cred -WorkingDirectory $env:SystemRoot -WindowStyle Hidden -Wait -PassThru;`,
    '[Console]::Out.Write($p.ExitCode)',
  ].join(' '), { WMUX_PIPE: pipePath });
  return Number(out.trim());
}

function security(): PipeSecurity {
  const loaded = loadPipeSecurity();
  if (!('security' in loaded)) throw new Error(`pipe security unavailable: ${loaded.unavailable}`);
  return loaded.security;
}

function listen(): string {
  const path = relayPipePath();
  const server = net.createServer((socket) => socket.on('error', () => undefined));
  server.on('error', () => undefined);
  server.listen(path);
  servers.push(server);
  return path;
}

describe.runIf(onHostedRunner)('the relay pipe against another local account (hosted runner only)', () => {
  beforeAll(() => {
    // New-LocalUser, not `net user /add`: net asks a Y/N question for a
    // password over 14 characters, which fails when nobody can answer.
    powershell([
      '$pw = ConvertTo-SecureString $env:WMUX_CI_PASSWORD -AsPlainText -Force;',
      'New-LocalUser -Name $env:WMUX_CI_USER -Password $pw -AccountNeverExpires -ErrorAction Stop | Out-Null',
    ].join(' '));
  }, 60_000);

  afterAll(() => {
    for (const server of servers) server.close();
    try {
      powershell('net use \\\\127.0.0.1\\IPC$ /delete /y 2>$null | Out-Null; Remove-LocalUser -Name $env:WMUX_CI_USER -ErrorAction SilentlyContinue');
    } catch { /* the VM goes away anyway */ }
  }, 60_000);

  it('the other account can read-open a pipe under the default DACL (control)', () => {
    expect(openAsOtherAccount(listen())).toBe(0);
  }, 90_000);

  it('the other account cannot open the pipe once narrow() has run', () => {
    const path = listen();
    expect(security().narrow(path)).toEqual({ ok: true });
    expect(openAsOtherAccount(path)).toBe(5);
  }, 90_000);

  it('over SMB as the other account: reported, and fails only if the pipe opens (the runner may not serve SMB)', () => {
    const path = listen();
    expect(security().narrow(path)).toEqual({ ok: true });
    const name = path.slice('\\\\.\\pipe\\'.length);
    let outcome: string;
    try {
      powershell('net use \\\\127.0.0.1\\IPC$ $env:WMUX_CI_PASSWORD /user:"$env:COMPUTERNAME\\$env:WMUX_CI_USER" | Out-Null');
      outcome = powershell(
        "try { $s = [System.IO.File]::Open(\"\\\\127.0.0.1\\pipe\\$env:WMUX_PIPE_NAME\", 'Open', 'Read', 'ReadWrite'); $s.Dispose(); 'opened' } catch { $_.Exception.GetType().Name }",
        { WMUX_PIPE_NAME: name },
      ).trim();
    } catch (err) {
      outcome = `not run: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
    console.log(`[relay pipe] SMB open as another account: ${outcome}`);
    expect(outcome).not.toBe('opened');
  }, 90_000);
});
