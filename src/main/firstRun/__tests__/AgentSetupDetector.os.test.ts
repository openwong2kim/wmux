import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentSetupDetector,
  buildProbeEnv,
  readLoginState,
} from '../AgentSetupDetector';
import {
  agentCandidates,
  isExecutableFile,
  resolveAgentExecutableWith,
  type ResolveClaudeEnv,
} from '../../claude/resolveClaudeExecutable';
import type { AgentId } from '../../../shared/agentSetup';

// Fake agent executables only: nothing here runs a real install or login.

describe('AgentSetupDetector with fake executables', () => {
  let root: string;
  let bin: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agent-setup-'));
    bin = path.join(root, 'bin');
    home = path.join(root, 'home');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function detector(timeoutMs?: number): AgentSetupDetector {
    const resolveEnv = (env: NodeJS.ProcessEnv): ResolveClaudeEnv => ({
      platform: process.platform,
      env,
      homedir: home,
      // Fixture files only: the host's own claude/codex (Homebrew, nvm, ...) must not count.
      isFile: (p) => p.startsWith(root) && isExecutableFile(p),
    });
    return new AgentSetupDetector({
      // /bin and /usr/bin keep `sh` and `sleep` reachable for the scripts.
      env: () => ({ PATH: `${bin}:/bin:/usr/bin`, CLAUDECODE: '1', WMUX_SURFACE_ID: 'pane-1' }),
      resolve: (agent: AgentId, env) => resolveAgentExecutableWith(resolveEnv(env), agent),
      candidates: (agent: AgentId, env) => agentCandidates(resolveEnv(env), agent),
      homedir: () => home,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  function writeScript(name: string, body: string): void {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }

  const flag = (name: string) => path.join(root, name);

  function installFakeClaude(): void {
    // Mirrors the measured shape of `claude auth status --json`: exit 0 with
    // loggedIn true, exit 1 with loggedIn false. The e-mail must never leak.
    writeScript('claude', `
case "$1" in
  --version) echo "2.1.300 (Claude Code)" ;;
  auth)
    [ -n "$CLAUDECODE" ] && { echo "nested marker leaked" >&2; exit 3; }
    if [ -f "${flag('claude-in')}" ]; then echo '{"loggedIn":true,"email":"person@example.com"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none"}'; exit 1 ;;
esac`);
  }

  function installFakeCodex(): void {
    writeScript('codex', `
case "$1" in
  --version) echo "codex-cli 0.150.0" ;;
  login)
    if [ -f "${flag('codex-in')}" ]; then echo "Logged in using ChatGPT"; exit 0; fi
    echo "Not logged in"; exit 1 ;;
esac`);
  }

  it.skipIf(process.platform === 'win32')(
    'walks not installed -> installed -> login needed -> logged in for both agents',
    async () => {
      const d = detector();

      // 1. Nothing installed: both cards say so and list where wmux looked.
      let [claude, codex] = await d.detectAll();
      expect(claude).toMatchObject({ agent: 'claude', readiness: 'not-installed', executable: null });
      expect(codex).toMatchObject({ agent: 'codex', readiness: 'not-installed', executable: null });
      expect(claude.candidates).toContain(path.join(bin, 'claude'));
      expect(codex.candidates).toContain(path.join(home, '.local', 'bin', 'codex'));

      // 2. Installed, signed out: login needed, with a confirmed answer.
      installFakeClaude();
      installFakeCodex();
      [claude, codex] = await d.detectAll();
      expect(claude).toMatchObject({
        readiness: 'login-needed', loginKnown: true, executable: path.join(bin, 'claude'),
        version: '2.1.300', updateRecommended: false, candidates: [],
      });
      expect(codex).toMatchObject({
        readiness: 'login-needed', loginKnown: true, version: '0.150.0', updateRecommended: true,
      });

      // 3. Signed in: ready. Nothing from the status output but the boolean survives.
      fs.writeFileSync(flag('claude-in'), '');
      fs.writeFileSync(flag('codex-in'), '');
      [claude, codex] = await d.detectAll();
      expect(claude.readiness).toBe('ready');
      expect(codex.readiness).toBe('ready');
      expect(JSON.stringify([claude, codex])).not.toContain('person@example.com');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'an agent with no documented sign-in check is only asked its version, and reads as installed',
    async () => {
      const calls = flag('grok-calls');
      writeScript('grok', `echo "$*" >> "${calls}"
case "$1" in
  --version) echo "grok 0.9.0" ;;
esac`);
      const d = detector();
      expect(await d.detect('grok')).toMatchObject({
        agent: 'grok', readiness: 'installed', loginKnown: false, executable: path.join(bin, 'grok'),
        version: '0.9.0', updateRecommended: true, candidates: [],
      });
      // Nothing but --version ran: no sign-in command, no credential read.
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['--version']);
      expect(await d.detect('agy')).toMatchObject({ agent: 'agy', readiness: 'not-installed' });
    },
  );

  it.skipIf(process.platform === 'win32')('a status probe that hangs is "could not tell", not signed out', async () => {
    // Like an npm launcher: the probed process starts a child and waits on it.
    // The timeout must take the child down too, not only the launcher.
    const pidFile = flag('child.pid');
    writeScript('claude', `
case "$1" in
  --version) echo "2.1.300 (Claude Code)" ;;
  *) sleep 30 & echo $! > "${pidFile}"; wait ;;
esac`);
    const [claude] = await detector(2000).detectAll();
    expect(claude).toMatchObject({ readiness: 'login-needed', loginKnown: false, version: '2.1.300' });

    const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const alive = (): boolean => { try { process.kill(childPid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });
});

describe('Qwen Code on Windows', () => {
  it('asks its version through the vendor qwen.cmd (cmd.exe, verbatim), from the home folder', async () => {
    const shim = 'C:\\Users\\u\\AppData\\Local\\qwen-code\\qwen-code\\bin\\qwen.cmd';
    const calls: { command: string; args: string[]; cwd: string; verbatim?: boolean }[] = [];
    const d = new AgentSetupDetector({
      env: () => ({ Path: 'C:\\Windows' }),
      platform: 'win32',
      homedir: () => 'C:\\Users\\u',
      resolve: (agent) => (agent === 'qwen' ? shim : null),
      run: async (command, args, opts) => {
        calls.push({ command, args, cwd: opts.cwd, verbatim: opts.windowsVerbatimArguments });
        return { code: 0, stdout: '0.26.0\n', stderr: '', timedOut: false };
      },
    });
    expect(await d.detect('qwen')).toMatchObject({ readiness: 'installed', executable: shim, version: '0.26.0' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ args: ['/d', '/s', '/c', `""${shim}" "--version""`], cwd: 'C:\\Users\\u', verbatim: true });
    expect(calls[0].command.toLowerCase()).toMatch(/cmd\.exe$/);
  });
});

describe('readLoginState', () => {
  const r = (code: number | null, stdout: string, timedOut = false) => ({ code, stdout, stderr: '', timedOut });

  it('needs the exit code and the loggedIn boolean to agree for Claude', () => {
    expect(readLoginState('claude', r(0, '{"loggedIn":true}'))).toBe(true);
    expect(readLoginState('claude', r(1, '{"loggedIn":false}'))).toBe(false);
    expect(readLoginState('claude', r(1, '{"loggedIn":true}'))).toBeNull();
    // An old Claude without `auth status` prints usage text, not JSON.
    expect(readLoginState('claude', r(1, "error: unknown command 'auth'"))).toBeNull();
    expect(readLoginState('claude', r(null, '', true))).toBeNull();
  });

  // A box refuses a remote start on `false` alone, and only the signed-out
  // shape was measured (2.1.322: rc 1 + loggedIn:false). Any other shape is
  // "cannot tell", so the start goes on.
  it('reads signed out only from rc 1 with loggedIn:false; any other shape cannot tell', () => {
    const measured = '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", "loginExpiresAt": null}';
    expect(readLoginState('claude', r(1, measured))).toBe(false);
    for (const out of ['{"loggedIn":"false"}', '{"status":"signed-out"}', '{"loggedIn":null}', '[]', 'null', '']) {
      expect(readLoginState('claude', r(1, out)), out).toBeNull();
    }
    expect(readLoginState('claude', r(0, '{"loggedIn":false}'))).toBeNull();
    expect(readLoginState('claude', r(2, '{"loggedIn":false}'))).toBeNull();
  });

  it('reads Codex from the exit code and its "Not logged in" line', () => {
    expect(readLoginState('codex', r(0, 'Logged in using ChatGPT'))).toBe(true);
    expect(readLoginState('codex', r(1, 'Not logged in'))).toBe(false);
    expect(readLoginState('codex', r(1, 'Error loading config.toml'))).toBeNull();
  });
});

describe('buildProbeEnv', () => {
  it('drops pane identity and agent session markers but keeps the user config dirs', () => {
    const env = buildProbeEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      CODEX_HOME: '/home/u/.codex',
      CODEX_THREAD_ID: 't-1',
      WMUX_SURFACE_ID: 's-1',
      WMUX_WORKSPACE_ID: 'w-1',
      ELECTRON_RUN_AS_NODE: '1',
    }, '/opt/node/bin/codex', 'linux');
    expect(env).toEqual({
      PATH: '/opt/node/bin:/usr/bin',
      HOME: '/home/u',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      CODEX_HOME: '/home/u/.codex',
      DISABLE_AUTOUPDATER: '1',
    });
  });

  it('prepends to the Windows Path key whatever its case', () => {
    const env = buildProbeEnv({ Path: 'C:\\Windows' }, 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'win32');
    expect(env.Path).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin;C:\\Windows');
  });
});
