// The generated hook entries, run the way each host runs them, end to end:
// host shell (or no shell) → node → shared bridge → a fake wmux pipe.
//
// On Windows a CLI may run a hook command through PowerShell (Gemini CLI does;
// Claude Code does when it finds no Git Bash), cmd, or Git Bash. #1882 was a
// hook line PowerShell could not parse. These cases pin that every command form
// wmux generates for the shared bridge runs under each shell it can meet, with
// a home directory containing a space.
//
// Isolation: a throwaway home (USERPROFILE and HOME both point at it), a data
// suffix, and an explicit pipe override, with every inherited WMUX_* variable
// removed, so nothing here can reach a live wmux or a real config directory.
// A shell that is not installed is skipped, not failed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { installCompatHooks, resolveCompatHookPaths } from '../../../src/shared/hooks/compatHookInstall';
import { compatHookShellCommand } from '../../../src/shared/hooks/hookFlavours';
// The Kiro agent config builder is the source of the Kiro command line.
import { buildKiroAgentConfig, isWindowsBarePath } from '../../kiro/agent/wmuxAgent.mjs';
import { rustCmdCSpawn, rustWindowsQuoteArg } from './rustWindowsSpawn';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SUFFIX = '-compat-shell-test';
const TOKEN = 'compat-shell-token';
const isWin = process.platform === 'win32';

const POWERSHELL = isWin ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
const CMD = isWin ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') : null;
// Git Bash specifically — on Windows a bare `bash` may be WSL's, which would
// run a Linux node against a Windows path.
const BASH = isWin
  ? [
    process.env.WMUX_TEST_GIT_BASH,
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'PortableGit', 'bin', 'bash.exe'),
  ].find((p): p is string => !!p && fs.existsSync(p)) ?? null
  : (fs.existsSync('/bin/bash') ? '/bin/bash' : null);
const have = (p: string | null): p is string => !!p && fs.existsSync(p);
// The Windows Kiro layouts live under the temp dir, so it must be a path the
// builder accepts bare (#1917).
const WINDOWS_TMP_NOT_BARE = isWin && !isWindowsBarePath(os.tmpdir());

interface Received { method: string; params: Record<string, unknown>; clientName?: string }

let home: string;
let pipeName: string;
let server: net.Server;
const received: Received[] = [];

beforeAll(async () => {
  // A space in the home path is the case quoting has to survive.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux compat shells-'));
  fs.writeFileSync(path.join(home, `.wmux${SUFFIX}-auth-token`), TOKEN);
  pipeName = isWin ? `\\\\.\\pipe\\wmux-compat-shell-${randomUUID()}` : path.join(home, 'main.sock');
  server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      if (req.token === TOKEN) received.push({ method: req.method, params: req.params, clientName: req.clientName });
      sock.end(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(pipeName, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

function hookEnv(ptyId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('WMUX_')) env[k] = v;
  return {
    ...env,
    USERPROFILE: home,
    HOME: home,
    WMUX_DATA_SUFFIX: SUFFIX,
    WMUX_PIPE_NAME: pipeName,
    WMUX_PTY_ID: ptyId,
  };
}

function run(
  file: string,
  args: string[],
  ptyId: string,
  payload: unknown,
  opts: { verbatim?: boolean; argv0?: string } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(file, args, {
      env: hookEnv(ptyId),
      cwd: home,
      shell: false,
      windowsVerbatimArguments: opts.verbatim ?? false,
      ...(opts.argv0 ? { argv0: opts.argv0 } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function signalFor(ptyId: string): Received | undefined {
  return received.find((r) => r.params?.ptyId === ptyId);
}

describe('copilot exec form (no shell)', () => {
  it('the installed entry runs the bridge and delivers the signal', async () => {
    const paths = resolveCompatHookPaths(home, REPO_ROOT);
    expect((await installCompatHooks('copilot', paths)).ok).toBe(true);
    const file = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'hooks', 'wmux.json'), 'utf8'));
    for (const event of Object.keys(file.hooks)) {
      const [leaf] = file.hooks[event];
      const ptyId = `copilot-exec-${event}`;
      const result = await run(leaf.exec, leaf.args, ptyId, { session_id: 'sess-1', cwd: home });
      expect(result, event).toMatchObject({ code: 0, stdout: '' });
      const got = signalFor(ptyId);
      expect(got?.method, event).toBe('hooks.signal');
      expect(got?.clientName).toBe('wmux-hook-bridge');
      expect(got?.params).toMatchObject({ agent: 'copilot', agentSessionId: 'sess-1', cwd: home });
    }
  }, 60_000);
});

describe('shell form under every host shell', () => {
  let bridge: string;
  beforeAll(async () => {
    const paths = resolveCompatHookPaths(home, REPO_ROOT);
    await installCompatHooks('copilot', paths);
    bridge = paths.bridge.destinationPath;
    expect(bridge).toContain(' ');
  });

  const payload = () => ({ hook_event_name: 'AfterAgent', session_id: 'gem-1', cwd: home, prompt_response: 'SECRET' });

  it.skipIf(!have(POWERSHELL))('PowerShell 5.1 (-NoProfile -Command), as Gemini CLI runs hooks on Windows', async () => {
    const cmd = compatHookShellCommand(bridge, 'gemini', 'AfterAgent') as string;
    const result = await run(POWERSHELL as string, ['-NoProfile', '-NonInteractive', '-Command', cmd], 'gemini-ps', payload());
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('gemini-ps')?.params).toMatchObject({ kind: 'agent.stop', agent: 'gemini', agentSessionId: 'gem-1' });
    expect(JSON.stringify(signalFor('gemini-ps'))).not.toContain('SECRET');
  }, 60_000);

  it.skipIf(!have(CMD))('cmd.exe /d /s /c', async () => {
    const cmd = compatHookShellCommand(bridge, 'gemini', 'AfterAgent') as string;
    const result = await run(CMD as string, ['/d', '/s', '/c', `"${cmd}"`], 'gemini-cmd', payload(), { verbatim: true });
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('gemini-cmd')?.params).toMatchObject({ kind: 'agent.stop', agent: 'gemini' });
  }, 60_000);

  it.skipIf(!have(BASH))('Git Bash (bash -c)', async () => {
    const cmd = compatHookShellCommand(bridge, 'gemini', 'AfterAgent') as string;
    const result = await run(BASH as string, ['-c', cmd], 'gemini-bash', payload());
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('gemini-bash')?.params).toMatchObject({ kind: 'agent.stop', agent: 'gemini' });
  }, 60_000);
});

describe.skipIf(WINDOWS_TMP_NOT_BARE)('kiro through the shared bridge, installed layout', () => {
  // The Kiro entry point copied NEXT TO the shared bridge, as the Kiro README
  // tells an operator to place them, and run with the exact command line the
  // Kiro agent config builder writes.
  //
  // POSIX keeps a quoted path, so the folder there has a space. Windows takes
  // an unquoted one (#1917) and refuses a space, so the folder there is
  // space-free and non-ASCII instead.
  let command: string;
  let windowsRoot: string | undefined;
  beforeAll(() => {
    if (isWin) windowsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-kiro-layout-'));
    const dir = windowsRoot ? path.join(windowsRoot, 'kiro-한글') : path.join(home, 'kiro hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'integrations', 'kiro', 'bin', 'wmux-kiro-bridge.mjs'), path.join(dir, 'wmux-kiro-bridge.mjs'));
    fs.copyFileSync(path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs'), path.join(dir, 'wmux-hooks-bridge.mjs'));
    const config = buildKiroAgentConfig(path.join(dir, 'wmux-kiro-bridge.mjs'), home);
    command = config.hooks.stop[0].command;
    if (isWin) expect(command).toMatch(/^node [^"]*kiro-한글\/wmux-kiro-bridge\.mjs$/);
    else expect(command).toMatch(/^node ".* hooks\/wmux-kiro-bridge\.mjs"$/);
  });
  afterAll(() => {
    if (windowsRoot) fs.rmSync(windowsRoot, { recursive: true, force: true });
  });

  const stop = () => ({ hook_event_name: 'stop', cwd: home, assistant_response: 'SECRET' });

  it.skipIf(!have(POWERSHELL))('PowerShell 5.1', async () => {
    const result = await run(POWERSHELL as string, ['-NoProfile', '-NonInteractive', '-Command', command], 'kiro-ps', stop());
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('kiro-ps')?.params).toEqual({
      kind: 'agent.stop', agent: 'kiro', ptyId: 'kiro-ps', cwd: home, payload: {}, ts: expect.any(Number),
    });
  }, 60_000);

  it.skipIf(!have(BASH))('Git Bash', async () => {
    const result = await run(BASH as string, ['-c', command], 'kiro-bash', stop());
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('kiro-bash')?.params).toMatchObject({ kind: 'agent.stop', agent: 'kiro' });
  }, 60_000);

  it.skipIf(!have(CMD))('cmd.exe /d /s /c', async () => {
    const result = await run(CMD as string, ['/d', '/s', '/c', `"${command}"`], 'kiro-cmd', stop(), { verbatim: true });
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('kiro-cmd')?.params).toMatchObject({ kind: 'agent.stop', agent: 'kiro' });
  }, 60_000);

  it.skipIf(isWin || !fs.existsSync('/bin/sh'))('POSIX sh (sh -c), the quoted path with a space', async () => {
    const result = await run('/bin/sh', ['-c', command], 'kiro-sh', stop());
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(signalFor('kiro-sh')?.params).toMatchObject({ kind: 'agent.stop', agent: 'kiro' });
  }, 60_000);

  // Copied without the shared bridge beside it (the pre-move README habit):
  // no signal, but still the bridge contract — exit 0, nothing on stdout.
  it('still exits 0 silently when copied alone', async () => {
    const lone = path.join(home, 'kiro alone');
    fs.mkdirSync(lone, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'integrations', 'kiro', 'bin', 'wmux-kiro-bridge.mjs'), path.join(lone, 'wmux-kiro-bridge.mjs'));
    const result = await run(process.execPath, [path.join(lone, 'wmux-kiro-bridge.mjs')], 'kiro-lone', stop());
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(signalFor('kiro-lone')).toBeUndefined();
  }, 60_000);
});

describe.skipIf(!have(CMD) || WINDOWS_TMP_NOT_BARE)('kiro under its own Windows hook spawn (cmd /C, Rust quoting)', () => {
  // Kiro's predecessor runs a hook on Windows as `cmd /C <command>`, the
  // command being ONE argument quoted by Rust std (see rustWindowsSpawn.ts).
  // Rust wraps it in quotes (it holds a space) and escapes every inner `"` as
  // `\"`; cmd /C then strips only the outer pair, and node's argument parser
  // reads `\"` as a literal quote. So a quoted path reaches node WITH its
  // quotes, and no quoting can protect a space. The verbatim-shell cases above
  // cannot see this, since they hand the command to the shell unchanged.
  // The builder's Windows line is therefore unquoted (kiroHookCommand).
  //
  // The layout dirs must be space-free, as no command form survives a space
  // here (hence the skip for a temp dir with one). One of them is non-ASCII.
  let root: string;
  const scripts: Record<string, string> = {};
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-kiro-rust-'));
    for (const name of ['plain', 'kiro-한글']) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      fs.copyFileSync(path.join(REPO_ROOT, 'integrations', 'kiro', 'bin', 'wmux-kiro-bridge.mjs'), path.join(dir, 'wmux-kiro-bridge.mjs'));
      fs.copyFileSync(path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs'), path.join(dir, 'wmux-hooks-bridge.mjs'));
      scripts[name] = path.join(dir, 'wmux-kiro-bridge.mjs');
    }
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const stop = () => ({ hook_event_name: 'stop', cwd: home, assistant_response: 'SECRET' });
  const runAsKiro = (command: string, ptyId: string) => {
    const { args, argv0 } = rustCmdCSpawn(command);
    return run(CMD as string, args, ptyId, stop(), { verbatim: true, argv0 });
  };

  it('a quoted path reaches node with its quotes (#1917)', async () => {
    // The form the Kiro README used to document, and the builder used to
    // write. It fails even with no space in the path.
    const command = `node "${scripts.plain}"`;
    expect(rustWindowsQuoteArg(command)).toBe(`"node \\"${scripts.plain}\\""`);
    const result = await runAsKiro(command, 'kiro-rust-quoted');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`Cannot find module`);
    expect(result.stderr).toContain(`"${scripts.plain}"`);
    expect(signalFor('kiro-rust-quoted')).toBeUndefined();
  }, 60_000);

  for (const name of ['plain', 'kiro-한글']) {
    it(`the command the Kiro config builder writes survives it (${name})`, async () => {
      const ptyId = `kiro-rust-builder-${name}`;
      const command = buildKiroAgentConfig(scripts[name], home).hooks.stop[0].command;
      const result = await runAsKiro(command, ptyId);
      expect(result).toMatchObject({ code: 0, stdout: '' });
      expect(signalFor(ptyId)?.params).toMatchObject({ kind: 'agent.stop', agent: 'kiro', ptyId });
      expect(command).not.toContain('"');
    }, 60_000);
  }
});
