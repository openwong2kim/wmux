/**
 * `wmux setup-hooks` writes every Claude folder a claude can run with:
 * $CLAUDE_CONFIG_DIR (else ~/.claude) and each Claude account. Runs the real
 * command against a temp HOME; only the Codex/OpenCode lanes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawnSync: () => ({ error: new Error('no codex in this test'), status: null, stdout: '', stderr: '' }),
}));
vi.mock('../../../shared/lifecycleIntegrations', () => ({
  resolveLifecycleIntegrationPaths: (home: string) => ({ opencode: { destinationPath: path.join(home, '.config', 'opencode', 'plugin', 'wmux.js') } }),
  statusLifecycleIntegrations: () => ({ ok: true }),
  installLifecycleIntegrations: () => ({ ok: true }),
}));
vi.mock('../../../shared/openCodeTerminalChatIntegration', () => ({
  openCodeTerminalChatIntegration: () => ({ state: 'absent', configPath: '', pluginUrl: '' }),
}));

import { handleSetupHooks, hookTargets, installHooks, isPermissionGateInstalled, refreshHookBridgeAtBootFor, statusHooks, type SetupHooksPaths } from '../setupHooks';

class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

let tmp: string;
let home: string;
let envDir: string;
let printed: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hook-targets-'));
  home = path.join(tmp, 'home');
  envDir = path.join(tmp, 'cfg');
  fs.mkdirSync(path.join(home, '.wmux'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'bridge-src.mjs'), 'BRIDGE', 'utf8');
  // os.homedir() follows these, so nothing here can reach the real home.
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('WMUX_DATA_SUFFIX', '');
  vi.stubEnv('CLAUDE_CONFIG_DIR', envDir);
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const settingsIn = (dir: string) => path.join(dir, 'settings.json');
const paths = (dir: string): SetupHooksPaths => ({
  settingsPath: settingsIn(dir),
  bridgeDest: path.join(home, '.wmux', 'hooks', 'wmux-bridge.mjs'),
  bridgeSource: path.join(tmp, 'bridge-src.mjs'),
});
const hooksIn = (dir: string) => statusHooks(paths(dir)).installedEvents.length;
const defaultDir = () => path.join(home, '.claude');

function writeAccounts(rows: Array<{ name: string; configDir: string; vendor?: string }>): void {
  fs.writeFileSync(path.join(home, '.wmux', 'accounts.json'),
    JSON.stringify({ version: 1, accounts: rows.map((r) => ({ vendor: 'claude', ...r })) }), 'utf8');
}

async function run(args: string[]): Promise<{ json: Record<string, unknown>; exit: number }> {
  let exit = 0;
  try {
    await handleSetupHooks(args, true);
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    exit = err.code;
  }
  return { json: JSON.parse(printed.join('\n')) as Record<string, unknown>, exit };
}

type TargetRow = { kind: string; settingsPath: string; outcome: { ok?: boolean; error?: string | null } };

describe('setup-hooks with CLAUDE_CONFIG_DIR set', () => {
  it('installs into the env folder and every account, keeps foreign hooks, and is idempotent', async () => {
    const a = path.join(tmp, 'acct-a');
    writeAccounts([{ name: 'A', configDir: a }, { name: 'X', configDir: path.join(tmp, 'codex'), vendor: 'codex' }]);
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(settingsIn(envDir), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-stop' }] }] } }), 'utf8');

    const { json, exit } = await run([]);
    expect(exit).toBe(0);
    expect(json.settingsPath).toBe(settingsIn(envDir)); // the primary keeps the top-level fields
    expect((json.claudeTargets as TargetRow[]).map((t) => t.kind)).toEqual(['env', 'account']);
    expect(hooksIn(envDir)).toBeGreaterThan(0);
    expect(hooksIn(a)).toBeGreaterThan(0);
    expect(fs.readFileSync(settingsIn(envDir), 'utf8')).toContain('my-own-stop');
    // ~/.claude had no wmux hooks: not a target, not created.
    expect(fs.existsSync(settingsIn(defaultDir()))).toBe(false);

    const first = fs.readFileSync(settingsIn(envDir), 'utf8');
    printed = [];
    await run([]);
    expect(fs.readFileSync(settingsIn(envDir), 'utf8')).toBe(first);
  });

  it('keeps an existing ~/.claude install current, and a corrupt account fails only itself', async () => {
    expect(installHooks(paths(defaultDir())).ok).toBe(true);
    const bad = path.join(tmp, 'acct-bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(settingsIn(bad), '{ not json', 'utf8');
    writeAccounts([{ name: 'bad', configDir: bad }]);

    const { json, exit } = await run([]);
    expect(exit).toBe(1);
    const rows = json.claudeTargets as TargetRow[];
    expect(rows.map((t) => [t.kind, t.outcome.ok])).toEqual([['env', true], ['default', true], ['account', false]]);
    expect(hooksIn(envDir)).toBeGreaterThan(0);
    expect(fs.readFileSync(settingsIn(bad), 'utf8')).toBe('{ not json');
  });

  it('--remove clears every folder, the orphaned ~/.claude included; --status lists them all', async () => {
    const a = path.join(tmp, 'acct-a');
    writeAccounts([{ name: 'A', configDir: a }]);
    for (const dir of [envDir, defaultDir(), a]) expect(installHooks(paths(dir)).ok).toBe(true);

    const status = await run(['--status']);
    expect((status.json.claudeTargets as TargetRow[]).map((t) => t.kind)).toEqual(['env', 'default', 'account']);

    printed = [];
    const removed = await run(['--remove']);
    expect(removed.exit).toBe(0);
    for (const dir of [envDir, defaultDir(), a]) expect(hooksIn(dir)).toBe(0);
  });

  it('a relative CLAUDE_CONFIG_DIR is left out with a warning: ~/.claude is the primary', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', 'relative/cfg');
    const { json } = await run([]);
    expect(json.settingsPath).toBe(settingsIn(defaultDir()));
    expect(vi.mocked(console.error).mock.calls.some(([m]) => String(m).includes('not an absolute path'))).toBe(true);
  });
});

describe('the boot bridge refresh', () => {
  it('refreshes the shared bridge when only the CLAUDE_CONFIG_DIR folder references it', () => {
    const base = paths(defaultDir());
    expect(installHooks(paths(envDir)).ok).toBe(true);
    fs.writeFileSync(base.bridgeDest, 'OLD', 'utf8');
    // At boot, before the shell probe: ~/.claude and the accounts only.
    const before = hookTargets({ action: 'install', env: undefined, base }).targets;
    expect(refreshHookBridgeAtBootFor(before)).toBe('not-installed');
    // Once the probe answered: the env folder too.
    const withEnv = hookTargets({ action: 'install', env: envDir, base }).targets.filter((t) => t.kind === 'env');
    expect(refreshHookBridgeAtBootFor(withEnv)).toBe('refreshed');
    expect(fs.readFileSync(base.bridgeDest, 'utf8')).toBe('BRIDGE');
  });
});

describe('the permission gate check (wmux web)', () => {
  it('reads the CLAUDE_CONFIG_DIR folder, where Claude reads its hooks', () => {
    expect(isPermissionGateInstalled()).toBe(false);
    expect(installHooks(paths(envDir), 'full').ok).toBe(true);
    expect(isPermissionGateInstalled()).toBe(true);
  });
});
