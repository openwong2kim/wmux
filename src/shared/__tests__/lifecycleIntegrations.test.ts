// Lifecycle asset install/refresh.
//
// wmux ships hook bridges into directories other tools own (~/.wmux/hooks,
// ~/.config/opencode/plugins). The installer therefore has one hard rule: it
// only ever replaces a destination it can PROVE is wmux-owned, identified by a
// marker in the file itself. Anything else is reported as foreign and left
// exactly as the user wrote it. Writes are atomic (temp + rename) so a crash
// mid-install cannot leave a truncated bridge that a hook would then execute.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inspectLifecycleAsset,
  installLifecycleAsset,
  findLifecycleAssetSourceFrom,
  resolveLifecycleIntegrationPaths,
  statusLifecycleIntegrations,
  OPENCODE_PLUGIN_BUNDLE_BASENAME,
  OPENCODE_PLUGIN_INSTALL_BASENAME,
  OPENCODE_PLUGIN_MANAGED_MARKER,
  CODEX_NOTIFY_MANAGED_MARKER,
} from '../lifecycleIntegrations';

const MARKER = OPENCODE_PLUGIN_MANAGED_MARKER;

let dir: string;
let src: string;
let dest: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-lifecycle-'));
  src = path.join(dir, 'source.js');
  dest = path.join(dir, 'installed', 'wmux.js');
  writeFileSync(src, `// ${MARKER}\nexport const v = 2;\n`, 'utf8');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Partial<Parameters<typeof inspectLifecycleAsset>[0]> = {}) => ({
  sourcePath: src,
  destinationPath: dest,
  ownershipMarkers: [MARKER],
  ...over,
});

describe('inspectLifecycleAsset', () => {
  it('reports missing when nothing is installed yet', () => {
    expect(inspectLifecycleAsset(spec()).state).toBe('missing');
  });

  it('reports current when the bytes already match', () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
    expect(inspectLifecycleAsset(spec()).state).toBe('current');
  });

  it('reports stale for an OLDER wmux-owned copy', () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, `// ${MARKER}\nexport const v = 1;\n`, 'utf8');
    expect(inspectLifecycleAsset(spec()).state).toBe('stale');
  });

  it('reports FOREIGN for a same-name file without a wmux marker', () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, 'export const mine = true;\n', 'utf8');
    expect(inspectLifecycleAsset(spec()).state).toBe('foreign');
  });

  it('accepts any of several markers so an older naming still reads as ours', () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, '// wmux ↔ OpenCode plugin bridge (old header)\n', 'utf8');
    expect(
      inspectLifecycleAsset(spec({ ownershipMarkers: [MARKER, 'wmux ↔ OpenCode plugin bridge'] })).state,
    ).toBe('stale');
  });

  it('reports source-missing rather than throwing when the bundle is absent', () => {
    expect(inspectLifecycleAsset(spec({ sourcePath: null })).state).toBe('source-missing');
    expect(inspectLifecycleAsset(spec({ sourcePath: path.join(dir, 'nope.js') })).state)
      .toBe('source-missing');
  });

  it('never creates the destination directory (read-only probe)', () => {
    inspectLifecycleAsset(spec());
    expect(() => statSync(path.dirname(dest))).toThrow();
  });
});

describe('installLifecycleAsset', () => {
  it('installs when absent', () => {
    const out = installLifecycleAsset(spec());
    expect(out).toMatchObject({ action: 'installed', state: 'current' });
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(src, 'utf8'));
  });

  it('refreshes a stale wmux-owned copy', () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, `// ${MARKER}\nexport const v = 1;\n`, 'utf8');
    const out = installLifecycleAsset(spec());
    expect(out).toMatchObject({ action: 'refreshed', state: 'current' });
    expect(readFileSync(dest, 'utf8')).toContain('v = 2');
  });

  it('is idempotent when already current (no rewrite)', () => {
    installLifecycleAsset(spec());
    const before = statSync(dest).mtimeMs;
    const out = installLifecycleAsset(spec());
    expect(out.action).toBe('none');
    expect(statSync(dest).mtimeMs).toBe(before);
  });

  it('REFUSES to overwrite a foreign file and leaves it byte-identical', () => {
    mkdirSync(path.dirname(dest), { recursive: true });
    const mine = 'export const mine = true;\n';
    writeFileSync(dest, mine, 'utf8');

    const out = installLifecycleAsset(spec());
    expect(out).toMatchObject({ action: 'none', state: 'foreign' });
    expect(readFileSync(dest, 'utf8')).toBe(mine);
  });

  it('does nothing when the bundled source is unavailable', () => {
    const out = installLifecycleAsset(spec({ sourcePath: null }));
    expect(out).toMatchObject({ action: 'none', state: 'source-missing' });
    expect(() => statSync(dest)).toThrow();
  });

  it('leaves no temp file behind after a successful install', () => {
    installLifecycleAsset(spec());
    const leftovers = readdirSync(path.dirname(dest)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('creates the destination directory when it does not exist', () => {
    expect(installLifecycleAsset(spec()).state).toBe('current');
    expect(statSync(path.dirname(dest)).isDirectory()).toBe(true);
  });
});

describe('findLifecycleAssetSourceFrom', () => {
  it('finds a bundled asset by walking up from the start directory', () => {
    const deep = path.join(dir, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const bundled = path.join(dir, 'a', OPENCODE_PLUGIN_BUNDLE_BASENAME);
    writeFileSync(bundled, 'x', 'utf8');
    expect(findLifecycleAssetSourceFrom(deep, OPENCODE_PLUGIN_BUNDLE_BASENAME, ['nope'])).toBe(bundled);
  });

  it('finds a repo-layout asset through the dev-relative path', () => {
    const start = path.join(dir, 'dist', 'main');
    mkdirSync(start, { recursive: true });
    const repoCopy = path.join(dir, 'integrations', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME);
    mkdirSync(path.dirname(repoCopy), { recursive: true });
    writeFileSync(repoCopy, 'x', 'utf8');
    expect(
      findLifecycleAssetSourceFrom(start, OPENCODE_PLUGIN_BUNDLE_BASENAME, [
        'integrations', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME,
      ]),
    ).toBe(repoCopy);
  });

  it('returns null instead of throwing when nothing is found', () => {
    expect(findLifecycleAssetSourceFrom(dir, 'absent-bundle.js', ['also', 'absent'])).toBeNull();
  });
});

describe('resolveLifecycleIntegrationPaths', () => {
  it('targets the conventional install locations and carries ownership markers', () => {
    const paths = resolveLifecycleIntegrationPaths('/home/u', dir);
    expect(paths.codex.destinationPath).toBe(path.join('/home/u', '.wmux', 'hooks', 'wmux-codex-notify.mjs'));
    expect(paths.codex.ownershipMarkers).toContain(CODEX_NOTIFY_MANAGED_MARKER);
    expect(paths.opencode.destinationPath).toBe(
      path.join('/home/u', '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME),
    );
    expect(paths.opencode.ownershipMarkers).toContain(OPENCODE_PLUGIN_MANAGED_MARKER);
  });

  it('honours an ABSOLUTE XDG_CONFIG_HOME for the OpenCode plugin', () => {
    // OpenCode reads its config from XDG_CONFIG_HOME; installing into ~/.config
    // regardless would put the plugin somewhere OpenCode never loads.
    process.env.XDG_CONFIG_HOME = '/xdg/cfg';
    try {
      const paths = resolveLifecycleIntegrationPaths('/home/u', dir);
      expect(paths.opencode.destinationPath).toBe(
        path.join('/xdg/cfg', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME),
      );
      // The wmux-owned hook dir is NOT an XDG location and must not move.
      expect(paths.codex.destinationPath).toContain(path.join('/home/u', '.wmux'));
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  it('IGNORES a relative XDG_CONFIG_HOME (spec says it must be absolute)', () => {
    process.env.XDG_CONFIG_HOME = 'relative/cfg';
    try {
      expect(resolveLifecycleIntegrationPaths('/home/u', dir).opencode.destinationPath).toBe(
        path.join('/home/u', '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME),
      );
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  it('statusLifecycleIntegrations reports without writing anything', () => {
    const home = path.join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const status = statusLifecycleIntegrations(resolveLifecycleIntegrationPaths(home, dir));
    expect(status.codexBridge.state).toBeDefined();
    expect(status.opencodePlugin.state).toBeDefined();
    // No install happened as a side effect of asking.
    expect(() => statSync(path.join(home, '.wmux', 'hooks'))).toThrow();
    expect(() => statSync(path.join(home, '.config', 'opencode', 'plugins'))).toThrow();
  });
});

describe('source preference', () => {
  it('prefers a live repo checkout over a possibly stale dist build', () => {
    // A developer running from source after an old `build:cli` must not have the
    // installed integration downgraded to the stale bundle.
    const start = path.join(dir, 'app');
    mkdirSync(start, { recursive: true });
    const distCopy = path.join(dir, 'dist', 'cli-bundle', OPENCODE_PLUGIN_BUNDLE_BASENAME);
    mkdirSync(path.dirname(distCopy), { recursive: true });
    writeFileSync(distCopy, 'stale', 'utf8');
    const repoCopy = path.join(dir, 'integrations', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME);
    mkdirSync(path.dirname(repoCopy), { recursive: true });
    writeFileSync(repoCopy, 'fresh', 'utf8');

    const found = findLifecycleAssetSourceFrom(start, OPENCODE_PLUGIN_BUNDLE_BASENAME, [
      'integrations', 'opencode', 'plugins', OPENCODE_PLUGIN_INSTALL_BASENAME,
    ]);
    expect(found).toBe(repoCopy);
    expect(readFileSync(found!, 'utf8')).toBe('fresh');
  });
});
