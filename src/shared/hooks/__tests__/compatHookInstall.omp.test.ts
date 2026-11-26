// #3276 — the omp extension module installer, against a throwaway home.
// Nothing here may touch the real ~/.omp or ~/.wmux.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  compatHookConfigPath,
  installCompatHooks,
  removeCompatHooks,
  resolveCompatHookPaths,
  statusCompatHooks,
  type CompatHookPaths,
} from '../compatHookInstall';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SOURCE = path.join(REPO_ROOT, 'integrations', 'omp', 'extensions', 'wmux.js');

let home: string;
let paths: CompatHookPaths;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-omp-hooks-'));
  paths = { ...resolveCompatHookPaths(home, REPO_ROOT, {}), nativeHooks: null };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const moduleFile = () => compatHookConfigPath('omp', paths) as string;

describe('omp extension install', () => {
  it('targets ~/.omp/agent/extensions/wmux.js, or $PI_CODING_AGENT_DIR/extensions', () => {
    expect(moduleFile()).toBe(path.join(home, '.omp', 'agent', 'extensions', 'wmux.js'));
    const agentDir = path.join(home, 'profile-agent');
    const moved = resolveCompatHookPaths(home, REPO_ROOT, { PI_CODING_AGENT_DIR: agentDir });
    expect(compatHookConfigPath('omp', moved)).toBe(path.join(agentDir, 'extensions', 'wmux.js'));
  });

  it('copies the shipped module and the shared bridge; a re-run changes nothing', async () => {
    expect(statusCompatHooks('omp', paths).config).toBe('absent');
    const first = await installCompatHooks('omp', paths);
    expect(first).toMatchObject({ ok: true, action: 'installed', before: 'absent' });
    expect(fs.readFileSync(moduleFile())).toEqual(fs.readFileSync(SOURCE));
    expect(fs.existsSync(path.join(home, '.wmux', 'hooks', 'wmux-hooks-bridge.mjs'))).toBe(true);
    expect(statusCompatHooks('omp', paths).config).toBe('current');
    expect(await installCompatHooks('omp', paths)).toMatchObject({ ok: true, action: 'none', before: 'current' });
  });

  it('refreshes an older wmux copy and never touches a foreign file', async () => {
    fs.mkdirSync(path.dirname(moduleFile()), { recursive: true });
    fs.writeFileSync(moduleFile(), '// wmux-managed: omp-extension\nexport default () => {};\n');
    expect(statusCompatHooks('omp', paths).config).toBe('stale');
    expect(await installCompatHooks('omp', paths)).toMatchObject({ ok: true, action: 'refreshed', before: 'stale' });

    const mine = 'export default (pi) => pi.on("agent_end", () => {});\n';
    fs.writeFileSync(moduleFile(), mine);
    expect(await installCompatHooks('omp', paths)).toMatchObject({ ok: false, before: 'foreign' });
    expect(removeCompatHooks('omp', paths)).toMatchObject({ removed: false, before: 'foreign' });
    expect(fs.readFileSync(moduleFile(), 'utf8')).toBe(mine);
  });

  it('--remove deletes the module and keeps the shared bridge', async () => {
    await installCompatHooks('omp', paths);
    expect(removeCompatHooks('omp', paths)).toMatchObject({ ok: true, removed: true, before: 'current' });
    expect(fs.existsSync(moduleFile())).toBe(false);
    expect(fs.existsSync(paths.bridge.destinationPath)).toBe(true);
    expect(statusCompatHooks('omp', paths).config).toBe('absent');
  });
});
