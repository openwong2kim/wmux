// My Hermes readiness against fake Hermes homes: each reason it is not
// ready, the notices, the install check, and that a check is static: it
// runs no process at all (no Hermes CLI, whose startup can write the home)
// and no file in the home changes.
// My Hermes is macOS and Linux only in v1: on Windows the same fixtures
// answer `unsupported-os` before anything runs, and the POSIX shapes are
// checked on macOS and Linux.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every way to start a process, counted: a readiness check must start none.
const procCalls = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const counted = <F extends (...a: never[]) => unknown>(name: string, fn: F): F => ((...a: Parameters<F>) => {
    procCalls.push(name);
    return fn(...a);
  }) as F;
  return {
    ...real,
    default: real,
    execFile: counted('execFile', real.execFile),
    execFileSync: counted('execFileSync', real.execFileSync),
    spawn: counted('spawn', real.spawn),
    spawnSync: counted('spawnSync', real.spawnSync),
    exec: counted('exec', real.exec),
    execSync: counted('execSync', real.execSync),
  };
});

import { envNames, hermesExeOwnedBy, installHasAcp, listMyHermesProfiles, myHermesReadiness, parseInstallVersion, type MyHermesReadinessDeps } from '../myHermes';

const WIN = process.platform === 'win32';

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-myhermes-'));
  procCalls.length = 0;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const READY_CONFIG = 'model:\n  default: anthropic/claude-x\napprovals:\n  mode: manual\n';

interface HomeOpts {
  /** `__version__` of the install; null: no __init__.py. */
  version?: string | null;
  /** The venv holds the acp package (default true); null: no venv lib. */
  acp?: boolean | null;
  /** The profile's config.yaml; null: none. */
  config?: string | null;
}

/** A home with ~/.hermes, its install (version module, venv), the
 *  installer's launcher and the default profile's config.yaml. */
function makeHome(o: HomeOpts = {}): { exe: string; root: string } {
  const root = path.join(home, '.hermes');
  const install = path.join(root, 'hermes-agent');
  const venvExe = path.join(install, 'venv', 'bin', 'hermes');
  fs.mkdirSync(path.dirname(venvExe), { recursive: true });
  fs.writeFileSync(venvExe, '#!/usr/bin/env python3\n', { mode: 0o755 });
  const version = o.version === undefined ? '0.22.5' : o.version;
  if (version !== null) {
    fs.mkdirSync(path.join(install, 'hermes_cli'), { recursive: true });
    fs.writeFileSync(path.join(install, 'hermes_cli', '__init__.py'), `"""Hermes CLI."""\n\n__version__ = "${version}"\n__release_date__ = "2026.10.1"\n`);
  }
  const acp = o.acp === undefined ? true : o.acp;
  if (acp !== null) {
    const site = path.join(install, 'venv', 'lib', 'python3.11', 'site-packages');
    fs.mkdirSync(acp ? path.join(site, 'acp') : site, { recursive: true });
  }
  const config = o.config === undefined ? READY_CONFIG : o.config;
  if (config !== null) fs.writeFileSync(path.join(root, 'config.yaml'), config);
  const exe = path.join(home, '.local', 'bin', 'hermes');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, `#!/usr/bin/env bash\nunset PYTHONPATH\nexec "${venvExe}" "$@"\n`, { mode: 0o755 });
  return { exe, root };
}

/** Every file under the home with its content hash (what a write would change). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function rig(o: HomeOpts = {}, over: Partial<MyHermesReadinessDeps> = {}) {
  const { exe, root } = makeHome(o);
  const deps: MyHermesReadinessDeps = { home, platform: process.platform, resolveExe: () => exe, baseEnv: { PATH: '/usr/bin' }, pidAlive: () => true, ...over };
  return { deps, exe, root };
}

/** Fresh home per case. */
function reset(): void {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home);
}

describe.runIf(WIN)('myHermesReadiness on Windows', () => {
  it('answers unsupported-os before it reads the home or runs anything', async () => {
    const r = rig();
    const before = snapshot(home);
    expect(await myHermesReadiness('default', r.deps)).toMatchObject({ ready: false, reason: 'unsupported-os' });
    expect(procCalls).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });
});

describe.skipIf(WIN)('myHermesReadiness', () => {
  it('a ready profile reports its version and notices; nothing runs and nothing in the home changes', async () => {
    const r = rig({ config: 'model: anthropic/claude-x\napprovals:\n  mode: smart\ncommand_allowlist: ["git *", "ls"]\nmcp_servers:\n  github: {}\n  linear: {}\n' });
    const before = snapshot(home);
    expect(await myHermesReadiness('default', r.deps)).toEqual({
      ready: true,
      version: '0.22.5',
      notices: [{ kind: 'approvals-smart' }, { kind: 'allowlist', count: 2 }, { kind: 'mcp-servers', names: ['github', 'linear'] }],
    });
    expect(procCalls).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  it('reads the version from the pinned install\'s hermes_cli/__init__.py; an old one says to update', async () => {
    const r = rig({ version: '0.19.0' });
    expect(await myHermesReadiness('default', r.deps)).toMatchObject({ ready: false, reason: 'outdated', version: '0.19.0', message: expect.stringContaining('`hermes update`') });
    reset();
    expect(await myHermesReadiness('default', rig({ version: '0.23.1' }).deps)).toMatchObject({ reason: 'unsupported', version: '0.23.1' });
    expect(procCalls).toEqual([]);
  });

  it('a missing or unreadable version module, install or config.yaml is unknown, never a guess', async () => {
    const cases: Array<[HomeOpts, string]> = [
      [{ version: null }, 'version'],
      [{ version: 'banana' }, 'version'],
      [{ acp: null }, 'install'],
      [{ config: null }, 'config.yaml'],
      [{ config: 'model: [unclosed\n  - x: : :\n' }, 'config.yaml'],
      [{ config: '- just\n- a list\n' }, 'config.yaml'],
    ];
    for (const [opts, what] of cases) {
      reset();
      const res = await myHermesReadiness('default', rig(opts).deps);
      expect(res, JSON.stringify(opts)).toMatchObject({ ready: false, reason: 'unknown', message: expect.stringContaining(what) });
    }
    expect(procCalls).toEqual([]);
  });

  it('an install without the acp package is acp-missing', async () => {
    expect(await myHermesReadiness('default', rig({ acp: false }).deps)).toMatchObject({ ready: false, reason: 'acp-missing' });
  });

  it('approvals.mode left out is Hermes\'s default, smart (a notice); off in any spelling is not ready', async () => {
    expect(await myHermesReadiness('default', rig({ config: 'model: x/y\n' }).deps)).toMatchObject({ ready: true, notices: [{ kind: 'approvals-smart' }] });
    for (const mode of ['off', '"off"', 'false', 'Off']) {
      reset();
      expect(await myHermesReadiness('default', rig({ config: `model: x/y\napprovals:\n  mode: ${mode}\n` }).deps), mode).toMatchObject({ ready: false, reason: 'approvals-off' });
    }
  });

  it('no model and a wmux MCP server are each not ready', async () => {
    expect(await myHermesReadiness('default', rig({ config: 'approvals:\n  mode: manual\n' }).deps)).toMatchObject({ ready: false, reason: 'no-model' });
    for (const name of ['wmux', 'mcp-wmux']) {
      reset();
      const r = rig({ config: `${READY_CONFIG}mcp_servers:\n  ${name}:\n    command: x\n  github: {}\n` });
      const before = snapshot(home);
      expect(await myHermesReadiness('default', r.deps)).toMatchObject({ ready: false, reason: 'wmux-mcp', message: expect.stringContaining('config.yaml'), notices: [{ kind: 'mcp-servers', names: ['github'] }] });
      expect(snapshot(home)).toEqual(before);
    }
    expect(procCalls).toEqual([]);
  });

  it('a messenger in the config or a messenger token name in .env is not ready; the value is never read out', async () => {
    const byConfig = rig({ config: `${READY_CONFIG}platforms:\n  telegram:\n    enabled: true\n  local:\n    enabled: true\ngateway:\n  platforms:\n    discord:\n      enabled: yes\n` });
    expect(await myHermesReadiness('default', byConfig.deps)).toMatchObject({ ready: false, reason: 'messengers', platforms: ['discord', 'telegram'] });
    reset();
    const byEnv = rig();
    fs.writeFileSync(path.join(home, '.hermes', '.env'), '# keys\nOPENAI_API_KEY=sk-secret-value\nexport SLACK_BOT_TOKEN=xoxb-secret-value\n');
    const before = snapshot(home);
    const r = await myHermesReadiness('default', byEnv.deps);
    expect(r).toMatchObject({ ready: false, reason: 'messengers', platforms: ['slack'] });
    expect(JSON.stringify(r)).not.toMatch(/secret-value/);
    expect(snapshot(home)).toEqual(before);
    // An explicit `enabled: false` wins over a token (Hermes #41112).
    reset();
    const off = rig({ config: `${READY_CONFIG}platforms:\n  slack:\n    enabled: false\n` });
    fs.writeFileSync(path.join(home, '.hermes', '.env'), 'SLACK_BOT_TOKEN=x\n');
    expect(await myHermesReadiness('default', off.deps)).toMatchObject({ ready: true });
    expect(procCalls).toEqual([]);
  });

  it('a running gateway with messaging platforms is not ready; a stale state file is ignored', async () => {
    const live = rig();
    fs.writeFileSync(path.join(home, '.hermes', 'gateway_state.json'), JSON.stringify({ pid: 4242, argv: ['hermes', 'gateway', 'run'], hermes_home: path.join(home, '.hermes'), platforms: { telegram: {} } }));
    expect(await myHermesReadiness('default', live.deps)).toMatchObject({ ready: false, reason: 'gateway-messengers', platforms: ['telegram'] });
    expect(await myHermesReadiness('default', { ...live.deps, pidAlive: () => false })).toMatchObject({ ready: true });
  });

  it('a hermes from another install, a missing profile, Windows, and not installed', async () => {
    const r = rig();
    const stray = path.join(home, 'elsewhere', 'hermes');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, '#!/bin/sh\nexec /opt/hermes/bin/hermes "$@"\n', { mode: 0o755 });
    expect(await myHermesReadiness('default', { ...r.deps, resolveExe: () => stray })).toMatchObject({ ready: false, reason: 'foreign-install' });
    expect(await myHermesReadiness('coder', r.deps)).toMatchObject({ ready: false, reason: 'profile-missing' });
    expect(await myHermesReadiness('../etc', r.deps)).toMatchObject({ ready: false, reason: 'profile-missing' });
    expect(await myHermesReadiness('default', { ...r.deps, platform: 'win32' })).toMatchObject({ ready: false, reason: 'unsupported-os' });
    expect(await myHermesReadiness('default', { ...r.deps, resolveExe: () => null })).toMatchObject({ ready: false, reason: 'not-installed' });
    // Not installed wins over a missing ~/.hermes.
    expect(await myHermesReadiness('default', { ...r.deps, resolveExe: () => null, isDir: () => false })).toMatchObject({ reason: 'not-installed' });
    expect(procCalls).toEqual([]);
  });

  it('a named profile reads its own config.yaml, and the version of the shared install', async () => {
    const r = rig({ config: 'approvals:\n  mode: manual\n' });
    const dir = path.join(home, '.hermes', 'profiles', 'coder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), READY_CONFIG);
    expect(await myHermesReadiness('coder', r.deps)).toMatchObject({ ready: true, version: '0.22.5' });
    // The default profile's own config has no model.
    expect(await myHermesReadiness('default', r.deps)).toMatchObject({ reason: 'no-model' });
  });
});

describe('My Hermes helpers', () => {
  it('lists default and the named profile folders Hermes accepts', () => {
    // No Hermes at all: `default` is still offered (its readiness says why).
    expect(listMyHermesProfiles(home)).toEqual(['default']);
    makeHome();
    for (const n of ['coder', 'Bad Name', 'default']) fs.mkdirSync(path.join(home, '.hermes', 'profiles', n), { recursive: true });
    fs.writeFileSync(path.join(home, '.hermes', 'profiles', 'file'), '');
    expect(listMyHermesProfiles(home)).toEqual(['default', 'coder']);
  });

  // A bash launcher and a symlink are POSIX shapes; Windows answers unsupported-os first.
  it.skipIf(WIN)('knows the installer launcher and a symlink into the install, not another hermes', () => {
    const { exe, root } = makeHome();
    expect(hermesExeOwnedBy(exe, root)).toBe(true);
    const link = path.join(home, 'link-hermes');
    fs.symlinkSync(path.join(root, 'hermes-agent', 'venv', 'bin', 'hermes'), link);
    expect(hermesExeOwnedBy(link, root)).toBe(true);
    const other = path.join(home, 'other');
    fs.writeFileSync(other, '\x7fELF binary');
    expect(hermesExeOwnedBy(other, root)).toBe(false);
  });

  it('parses only a plain __version__ assignment', () => {
    expect(parseInstallVersion('__version__ = "0.22.5"\n')).toBe('0.22.5');
    expect(parseInstallVersion("x = 1\n__version__ = '0.23.0-rc1'\n")).toBe('0.23.0-rc1');
    expect(parseInstallVersion('# __version__ = "9.9.9"\n')).toBeNull();
    expect(parseInstallVersion('__version__ = get_version()\n')).toBeNull();
  });

  it('finds the acp package in the venv, and cannot tell without a venv', () => {
    const { root } = makeHome();
    expect(installHasAcp(path.join(root, 'hermes-agent'))).toBe(true);
    expect(installHasAcp(path.join(home, 'nowhere'))).toBeNull();
  });

  it('reads .env names only', () => {
    expect(envNames('A=1\n  export B_2 = two\n# C=3\nnot a line\n=x\n')).toEqual(['A', 'B_2']);
  });
});
