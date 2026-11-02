import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hermesVersionStatus } from '../../../shared/hermesEngine';
import {
  HERMES_SETTINGS,
  clearHermesProbeCache,
  hermesEnv,
  hermesReadiness,
  hermesSettingsMismatches,
  liveGatewayOf,
  parseWindowsProcess,
  parseWmicProcess,
  type HermesProbeResult,
  type HermesRun,
} from '../hermesEngine';

// A fake `hermes` over an in-memory config: `config get --json`, `config set`
// (YAML-ish scalars and `[a, b]` lists), `config unset`. `--version` fails the
// test: its update check fetches in the install, so wmux never runs it.
function fakeHermes(opts: { config?: Record<string, unknown>; sticky?: Record<string, unknown> } = {}) {
  const config = new Map<string, unknown>(Object.entries(opts.config ?? {}));
  const calls: string[][] = [];
  const parse = (s: string): unknown => {
    if (s.startsWith('[')) return s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    if (s === 'true' || s === 'false') return s === 'true';
    if (/^\d+$/.test(s)) return Number(s);
    return s;
  };
  const run: HermesRun = async (_exe, args) => {
    calls.push(args);
    if (args.includes('--version') || args.includes('-V') || args[0] === 'version') throw new Error('hermes --version must never run: its update check fetches in the install');
    const key = args[args.length - 1];
    if (args[1] === 'get') {
      const v = opts.sticky && key in opts.sticky ? opts.sticky[key] : config.get(key);
      return v === undefined ? { code: 1, stdout: '', stderr: 'Config key not set' } : { code: 0, stdout: JSON.stringify(v), stderr: '' };
    }
    if (args[1] === 'set') config.set(args[2], parse(args[3]));
    if (args[1] === 'unset') config.delete(args[2]);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls, config };
}

describe('hermesSettingsMismatches', () => {
  it('names a widened toolset and any MCP server, plugin or command allowlist as wrong', () => {
    const good = new Map<string, unknown>([
      ['platform_toolsets.acp', ['todo', 'web']],
      ['agent.disabled_toolsets', ['terminal', 'code_execution', 'file', 'browser', 'delegation', 'connections', 'skills', 'memory', 'vision', 'session_search']],
      ['updates.check', false],
      ['tools.tool_search.enabled', 'off'],
      ['approvals.mode', 'manual'],
      ['approvals.timeout', 300],
      ['gateway.unmanaged_idle_exit_seconds', 600],
      ['security.allow_private_urls', false],
    ]);
    expect(hermesSettingsMismatches(good)).toEqual([]);

    const bad = new Map(good);
    bad.set('platform_toolsets.acp', ['web', 'todo', 'terminal']);
    bad.set('mcp_servers', { fs: { command: 'npx' } });
    bad.set('plugins.enabled', ['x']);
    bad.set('command_allowlist', ['rm']);
    bad.set('security.allow_private_urls', true);
    expect(hermesSettingsMismatches(bad).sort()).toEqual(
      ['command_allowlist', 'mcp_servers', 'platform_toolsets.acp', 'plugins.enabled', 'security.allow_private_urls'].sort());
  });
});

describe('hermesEnv', () => {
  it('passes only the allowlist, points HERMES_HOME at R and adds the installer folder to PATH', () => {
    const env = hermesEnv('/data/factory/hermes', {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      ANTHROPIC_API_KEY: 'sk-x',
      OPENROUTER_API_KEY: 'or-x',
      WMUX_PANE_ID: 'p1',
      WMUX_AUTH_TOKEN: 't',
      HERMES_HOME: '/home/u/.hermes',
    }, 'darwin', '/home/u');
    expect(env).toEqual({
      PATH: '/usr/bin:/home/u/.local/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      HERMES_HOME: '/data/factory/hermes',
      PYTHONIOENCODING: 'utf-8',
    });
  });

  it('keeps Windows\' Path and a proxy under their own names', () => {
    const env = hermesEnv('C:\\data\\factory\\hermes', {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      HTTPS_PROXY: 'http://proxy:3128',
      OPENAI_API_KEY: 'k',
    }, 'win32', 'C:\\Users\\u');
    expect(env).toEqual({
      Path: 'C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\hermes\\bin',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      HTTPS_PROXY: 'http://proxy:3128',
      HERMES_HOME: 'C:\\data\\factory\\hermes',
      PYTHONIOENCODING: 'utf-8',
    });
  });
});

describe('hermesReadiness', () => {
  let root: string;
  const okProbe = async (): Promise<HermesProbeResult> => ({ ok: true });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ready-'));
    clearHermesProbeCache();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** An installer-shaped install of `version` under `root`, and its launcher. */
  const install = (version: string): string => {
    const dir = path.join(root, `install-${version}`);
    const venvExe = path.join(dir, 'hermes-agent', 'venv', 'bin', 'hermes');
    fs.mkdirSync(path.dirname(venvExe), { recursive: true });
    fs.writeFileSync(venvExe, '#!/usr/bin/env python3\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'hermes-agent', 'hermes_cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hermes-agent', 'hermes_cli', '__init__.py'), `__version__ = "${version}"\n`);
    const launcher = path.join(dir, 'bin', 'hermes');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, `#!/usr/bin/env bash\nexec "${venvExe}" "$@"\n`, { mode: 0o755 });
    return launcher;
  };
  const deps = (run: HermesRun, probe = okProbe, version = '0.22.5') => {
    const exe = install(version);
    return { root, run, probe, resolveExe: () => exe, env: (r: string) => ({ HERMES_HOME: r }) };
  };

  it('writes wmux\'s settings, unsets MCP servers and the command allowlist, then is ready', async () => {
    const h = fakeHermes({ config: { model: { default: 'm1' }, mcp_servers: { fs: {} }, command_allowlist: ['ls'] } });
    expect(await hermesReadiness(deps(h.run))).toEqual({ ready: true, version: '0.22.5' });
    expect(h.config.has('mcp_servers')).toBe(false);
    expect(h.config.has('command_allowlist')).toBe(false);
    expect(hermesSettingsMismatches(new Map(HERMES_SETTINGS.map((s) => [s.key, h.config.get(s.key)])))).toEqual([]);
  });

  it('is not ready when a setting does not read back, the version is outside the range, or MCP is missing', async () => {
    const sticky = fakeHermes({ config: { model: 'm1' }, sticky: { 'platform_toolsets.acp': ['web', 'todo', 'terminal'] } });
    expect(await hermesReadiness(deps(sticky.run))).toMatchObject({ ready: false, reason: 'config-mismatch' });

    expect(await hermesReadiness(deps(fakeHermes().run, okProbe, '0.19.0'))).toMatchObject({ ready: false, reason: 'outdated', version: '0.19.0' });
    expect(await hermesReadiness(deps(fakeHermes().run, okProbe, '0.23.0'))).toMatchObject({ ready: false, reason: 'unsupported' });
    expect(await hermesReadiness(deps(fakeHermes().run))).toMatchObject({ ready: false, reason: 'not-set-up' });

    const missing = async (): Promise<HermesProbeResult> => ({ ok: false, reason: 'mcp-missing', detail: 'no mcp' });
    const fixed = fakeHermes({ config: { model: 'm1' } });
    expect(await hermesReadiness(deps(fixed.run, missing))).toMatchObject({ ready: false, reason: 'mcp-missing' });
    // The extra added in a terminal leaves the executable as it was: probed again.
    expect(await hermesReadiness(deps(fixed.run))).toEqual({ ready: true, version: '0.22.5' });
  });
});

describe('hermesReadiness reads the version from the install', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ver-'));
    clearHermesProbeCache();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a version that cannot be read is unknown, before any Hermes command runs', async () => {
    const h = fakeHermes({ config: { model: 'm1' } });
    const exe = path.join(root, 'bin', 'hermes');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    expect(await hermesReadiness({ root, run: h.run, probe: async () => ({ ok: true }), resolveExe: () => exe, env: (r: string) => ({ HERMES_HOME: r }) }))
      .toMatchObject({ ready: false, reason: 'unknown', message: expect.stringMatching(/could not read the version/) });
    expect(h.calls).toEqual([]);
  });
});

describe('liveGatewayOf and the version range', () => {
  it('a live gateway of R by its command line and HERMES_HOME, else by its start record; a pre-release is before its release', () => {
    const same = (a: string, b: string) => a === b;
    const cmd = 'python -m hermes_cli.main --profile default gateway run --quiet --idle-exit';
    const state = { startTime: 179289636767, writtenAt: 1_792_896_400_000 };
    expect(liveGatewayOf('/r', { command: cmd, hermesHome: '/r' }, state, same, 'darwin')).toBe(true);
    expect(liveGatewayOf('/r', { command: cmd, hermesHome: '/home/u/.hermes' }, state, same, 'darwin')).toBe(false);
    expect(liveGatewayOf('/r', { command: 'python -m hermes_cli.main acp' }, state, same, 'darwin')).toBe(false);
    expect(liveGatewayOf('/r', { command: '/usr/sbin/sshd -D' }, state, same, 'darwin')).toBe(false);
    expect(liveGatewayOf('/r', null, state, same, 'darwin')).toBe(false);
    // No environment (Windows): created by the recorded start (centiseconds), with 2 s slack.
    expect(liveGatewayOf('/r', { command: cmd, createdAt: 1_792_896_367_670 + 1_500 }, state, same, 'win32')).toBe(true);
    expect(liveGatewayOf('/r', { command: cmd, createdAt: 1_792_896_367_670 + 5_000 }, state, same, 'win32')).toBe(false);
    expect(liveGatewayOf('/r', { command: cmd }, state, same, 'win32')).toBe(false);
    // No start record: the file's last write stands in.
    expect(liveGatewayOf('/r', { command: cmd, createdAt: 1_792_896_399_000 }, { writtenAt: 1_792_896_400_000 }, same, 'win32')).toBe(true);
    // Linux: the same start ticks Hermes recorded.
    expect(liveGatewayOf('/r', { command: cmd, startTicks: 5 }, { startTime: 5, writtenAt: 0 }, same, 'linux')).toBe(true);
    expect(liveGatewayOf('/r', { command: cmd, startTicks: 6 }, { startTime: 5, writtenAt: 0 }, same, 'linux')).toBe(false);

    expect(parseWindowsProcess('1792896367670\r\nC:\\py\\python.exe -m hermes_cli.main gateway run\r\n')).toEqual({ command: 'C:\\py\\python.exe -m hermes_cli.main gateway run', createdAt: 1792896367670 });
    expect(parseWmicProcess('\r\nCommandLine=python -m hermes_cli.main gateway run\r\nCreationDate=20261025120607.670000+540\r\n')).toEqual({ command: 'python -m hermes_cli.main gateway run', createdAt: Date.UTC(2026, 9, 25, 3, 6, 7, 670) });

    expect(hermesVersionStatus('0.22.5-rc1')).toBe('outdated');
    expect(hermesVersionStatus('0.22.6-rc1')).toBe('ok');
    expect(hermesVersionStatus('0.23.0-rc1')).toBe('unsupported');
  });
});
