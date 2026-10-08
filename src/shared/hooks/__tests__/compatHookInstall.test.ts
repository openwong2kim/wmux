// The opt-in installer, against a throwaway home. Nothing here may touch the
// real ~/.copilot or ~/.wmux: every path is derived from the temp `home`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOwnedHookFile,
  compatHookConfigPath,
  installCompatHooks,
  removeCompatHooks,
  resolveCompatHookPaths,
  statusCompatHooks,
  type CompatHookPaths,
} from '../compatHookInstall';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let home: string;
let paths: CompatHookPaths;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-compat-hooks-'));
  paths = resolveCompatHookPaths(home, REPO_ROOT);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const configFile = () => compatHookConfigPath('copilot', home) as string;
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));

describe('resolveCompatHookPaths', () => {
  it('finds the shared bridge in a source checkout and targets ~/.wmux/hooks', () => {
    expect(paths.bridge.sourcePath).toBe(path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs'));
    expect(paths.bridge.destinationPath).toBe(path.join(home, '.wmux', 'hooks', 'wmux-hooks-bridge.mjs'));
  });

  it('puts Copilot hooks in a wmux-owned file under ~/.copilot/hooks', () => {
    expect(configFile()).toBe(path.join(home, '.copilot', 'hooks', 'wmux.json'));
  });

  it('has no installer for flavours that stay manual or unverified', () => {
    expect(compatHookConfigPath('kiro', home)).toBeNull();
    expect(compatHookConfigPath('gemini', home)).toBeNull();
  });
});

describe('buildOwnedHookFile', () => {
  // Exec form: no shell, so no quoting for PowerShell or cmd to misread.
  it('writes exec-form entries with the event in argv', () => {
    const bridge = 'C:\\Users\\Jane Doe\\.wmux\\hooks\\wmux-hooks-bridge.mjs';
    expect(buildOwnedHookFile('copilot', bridge)).toEqual({
      version: 1,
      hooks: {
        SessionStart: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'SessionStart'], timeoutSec: 5 }],
        UserPromptSubmit: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'UserPromptSubmit'], timeoutSec: 5 }],
        Stop: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'Stop'], timeoutSec: 5 }],
        PermissionRequest: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'PermissionRequest'], timeoutSec: 5 }],
      },
    });
  });

  it('refuses a flavour without an owned-file installer', () => {
    expect(() => buildOwnedHookFile('gemini', '/b.mjs')).toThrow();
  });
});

describe('installCompatHooks', () => {
  it('copies the bridge and writes the hook file on a fresh home', () => {
    const outcome = installCompatHooks('copilot', paths);
    expect(outcome).toMatchObject({ ok: true, before: 'absent', action: 'installed' });
    expect(outcome.bridge.state).toBe('current');
    expect(fs.existsSync(paths.bridge.destinationPath)).toBe(true);
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
  });

  it('is idempotent: a second run writes nothing', () => {
    installCompatHooks('copilot', paths);
    const mtime = fs.statSync(configFile()).mtimeMs;
    const again = installCompatHooks('copilot', paths);
    expect(again).toMatchObject({ ok: true, before: 'current', action: 'none' });
    expect(fs.statSync(configFile()).mtimeMs).toBe(mtime);
  });

  it('refreshes its own file when the bridge path moved', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(buildOwnedHookFile('copilot', '/old/place/wmux-hooks-bridge.mjs')));
    const outcome = installCompatHooks('copilot', paths);
    expect(outcome).toMatchObject({ ok: true, before: 'stale', action: 'refreshed' });
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
  });

  it('never overwrites a file the user wrote', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    const theirs = JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: './mine.sh' }] } });
    fs.writeFileSync(configFile(), theirs);
    const outcome = installCompatHooks('copilot', paths);
    expect(outcome).toMatchObject({ ok: false, before: 'foreign', action: 'none' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(theirs);
  });

  // One foreign entry beside ours makes the whole file the user's.
  it('treats a file with our entry plus one of theirs as foreign', () => {
    const mixed = buildOwnedHookFile('copilot', paths.bridge.destinationPath) as { hooks: Record<string, unknown[]> };
    mixed.hooks.Stop.push({ type: 'command', bash: './mine.sh' });
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(mixed));
    expect(installCompatHooks('copilot', paths).before).toBe('foreign');
  });

  it('leaves a malformed file alone', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), '{ not json');
    expect(installCompatHooks('copilot', paths)).toMatchObject({ ok: false, before: 'malformed', action: 'none' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{ not json');
  });

  it('writes no config when the bridge cannot be installed', () => {
    const missing = { ...paths, bridge: { ...paths.bridge, sourcePath: null } };
    const outcome = installCompatHooks('copilot', missing);
    expect(outcome.ok).toBe(false);
    expect(outcome.bridge.state).toBe('source-missing');
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('reports flavours without an installer as unsupported', () => {
    expect(installCompatHooks('gemini', paths)).toMatchObject({ ok: false, before: 'unsupported', action: 'none' });
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
  });
});

describe('removeCompatHooks / statusCompatHooks', () => {
  it('removes its own file and keeps the shared bridge', () => {
    installCompatHooks('copilot', paths);
    expect(removeCompatHooks('copilot', paths)).toMatchObject({ ok: true, removed: true, before: 'current' });
    expect(fs.existsSync(configFile())).toBe(false);
    expect(fs.existsSync(paths.bridge.destinationPath)).toBe(true);
    expect(removeCompatHooks('copilot', paths)).toMatchObject({ ok: true, removed: false, before: 'absent' });
  });

  it('does not remove a file it did not write', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), '{"version":1,"hooks":{}}');
    expect(removeCompatHooks('copilot', paths)).toMatchObject({ removed: false, before: 'foreign' });
    expect(fs.existsSync(configFile())).toBe(true);
  });

  it('reports written state and that the flavour is docs-verified only', () => {
    expect(statusCompatHooks('copilot', paths)).toMatchObject({ config: 'absent', verified: 'docs' });
    installCompatHooks('copilot', paths);
    const status = statusCompatHooks('copilot', paths);
    expect(status.config).toBe('current');
    expect(status.bridge.state).toBe('current');
  });
});
