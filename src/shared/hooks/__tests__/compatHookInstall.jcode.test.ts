// #3067 — `wmux setup-hooks --agent jcode` against a throwaway home. Nothing
// here may touch the real ~/.jcode or ~/.wmux.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'smol-toml';
import {
  compatHookConfigPath,
  installCompatHooks,
  removeCompatHooks,
  resolveCompatHookPaths,
  statusCompatHooks,
  tomlHookCommand,
  type CompatHookPaths,
} from '../compatHookInstall';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let home: string;
let paths: CompatHookPaths;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-jcode-hooks-'));
  paths = { ...resolveCompatHookPaths(home, REPO_ROOT, {}), nativeHooks: null };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const configFile = () => compatHookConfigPath('jcode', paths) as string;
const entry = () => path.join(home, '.wmux', 'hooks', 'wmux-jcode-bridge.mjs');

describe('jcode hook install', () => {
  it('targets ~/.jcode/config.toml, or $JCODE_HOME/config.toml', () => {
    expect(configFile()).toBe(path.join(home, '.jcode', 'config.toml'));
    const moved = resolveCompatHookPaths(home, REPO_ROOT, { JCODE_HOME: path.join(home, 'jh') });
    expect(compatHookConfigPath('jcode', moved)).toBe(path.join(home, 'jh', 'config.toml'));
  });

  it("copies the entry point beside the bridge and adds wmux's command next to the user's", async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), '# mine\n[hooks]\nturn_end = "~/bin/notify"\n');
    expect(statusCompatHooks('jcode', paths).config).toBe('absent');

    const outcome = await installCompatHooks('jcode', paths);
    expect(outcome).toMatchObject({ ok: true, action: 'installed', before: 'absent' });
    expect(fs.readFileSync(entry(), 'utf8').split(/\r?\n/)[0]).toBe('// wmux-managed: jcode-hooks-bridge');
    expect(fs.existsSync(path.join(home, '.wmux', 'hooks', 'wmux-hooks-bridge.mjs'))).toBe(true);
    const cmd = tomlHookCommand(entry()) as string;
    const text = fs.readFileSync(configFile(), 'utf8');
    expect(text.startsWith('# mine\n')).toBe(true);
    expect((parse(text) as { hooks: Record<string, string[]> }).hooks).toEqual({
      session_start: [cmd], turn_start: [cmd], turn_end: ['~/bin/notify', cmd], session_end: [cmd],
    });
    expect(statusCompatHooks('jcode', paths).config).toBe('current');
    expect(await installCompatHooks('jcode', paths)).toMatchObject({ ok: true, action: 'none' });

    const removed = removeCompatHooks('jcode', paths);
    expect(removed).toMatchObject({ ok: true, removed: true });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('# mine\n[hooks]\nturn_end = ["~/bin/notify"]\n');
    expect(statusCompatHooks('jcode', paths).config).toBe('absent');
  });

  it('writes nothing and returns the lines when the file cannot be edited safely', async () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    const original = '[hooks]\nturn_end = [\n  "a", # keep this\n]\n';
    fs.writeFileSync(configFile(), original);
    const outcome = await installCompatHooks('jcode', paths);
    expect(outcome.ok).toBe(false);
    expect(outcome.manualLines).toContain(`turn_end = ["a", ${JSON.stringify(tomlHookCommand(entry()))}]`);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(original);
  });

  it('writes forward slashes and refuses a path with a quote', () => {
    expect(tomlHookCommand('C:\\Users\\me\\.wmux\\hooks\\wmux-jcode-bridge.mjs')).toBe('node "C:/Users/me/.wmux/hooks/wmux-jcode-bridge.mjs"');
    expect(tomlHookCommand('/a"b/wmux-jcode-bridge.mjs')).toBeNull();
  });
});
