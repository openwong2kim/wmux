import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_NOTIFY_MANAGED_MARKER,
  OPENCODE_PLUGIN_MANAGED_MARKER,
  findLifecycleAssetSourceFrom,
  inspectLifecycleAsset,
  installLifecycleAsset,
  installLifecycleIntegrations,
  resolveLifecycleIntegrationPaths,
  statusLifecycleIntegrations,
  type LifecycleAssetSpec,
  type LifecycleIntegrationPaths,
} from '../lifecycleIntegrations';
import { CODEX_NOTIFY_BASENAME } from '../configIO';
import { getMcpTarget } from '../mcpTargets';

let home = '';
const codexTarget = getMcpTarget('codex')!;

const SOURCE_TEXT = `${CODEX_NOTIFY_MANAGED_MARKER}\n// wmux-managed lifecycle bridge body\n`;
const FOREIGN_TEXT = '// a user-owned script; no wmux marker anywhere\n';
const MARKERS = [CODEX_NOTIFY_MANAGED_MARKER] as const;

/** Build a spec whose source is a real temp file with the given contents. */
function specWithSource(text: string, destinationPath: string): LifecycleAssetSpec {
  const sourcePath = path.join(home, `src-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(sourcePath, text, 'utf8');
  return { sourcePath, destinationPath, ownershipMarkers: MARKERS };
}

function writeCodexConfig(text: string): string {
  const p = codexTarget.configPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-life-'));
  // Two tests assert the default ~/.config opencode destination. An ambient
  // XDG_CONFIG_HOME in the runner env would silently reroute that and flake
  // CI, so clear it; the XDG-honoring test sets its own value after this.
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('inspectLifecycleAsset — read-only freshness/ownership', () => {
  it('reports source-missing when no source path is supplied', () => {
    const dest = path.join(home, 'dest.mjs');
    const status = inspectLifecycleAsset({ sourcePath: null, destinationPath: dest, ownershipMarkers: MARKERS });
    expect(status.state).toBe('source-missing');
    expect(status.error).toBeNull();
  });

  it('reports source-missing when the source file does not exist', () => {
    const dest = path.join(home, 'dest.mjs');
    const status = inspectLifecycleAsset({ sourcePath: path.join(home, 'absent.mjs'), destinationPath: dest, ownershipMarkers: MARKERS });
    expect(status.state).toBe('source-missing');
  });

  it('reports missing when the destination does not exist', () => {
    const dest = path.join(home, 'dest.mjs');
    const status = inspectLifecycleAsset(specWithSource(SOURCE_TEXT, dest));
    expect(status.state).toBe('missing');
  });

  it('reports current when source and destination are byte-identical', () => {
    const dest = path.join(home, 'dest.mjs');
    const spec = specWithSource(SOURCE_TEXT, dest);
    fs.copyFileSync(spec.sourcePath!, dest);
    expect(inspectLifecycleAsset(spec).state).toBe('current');
  });

  it('reports stale when the destination differs but carries an ownership marker', () => {
    const dest = path.join(home, 'dest.mjs');
    // An OLDER wmux build: same marker, different body.
    fs.writeFileSync(dest, `${CODEX_NOTIFY_MANAGED_MARKER}\n// older body\n`, 'utf8');
    const status = inspectLifecycleAsset(specWithSource(SOURCE_TEXT, dest));
    expect(status.state).toBe('stale');
  });

  it('reports foreign when the destination differs and has no ownership marker', () => {
    const dest = path.join(home, 'dest.mjs');
    fs.writeFileSync(dest, FOREIGN_TEXT, 'utf8');
    const status = inspectLifecycleAsset(specWithSource(SOURCE_TEXT, dest));
    expect(status.state).toBe('foreign');
  });

  it('reports error (not missing) when the destination exists but is unreadable as a file', () => {
    const dest = path.join(home, 'a-directory');
    fs.mkdirSync(dest, { recursive: true });
    const status = inspectLifecycleAsset(specWithSource(SOURCE_TEXT, dest));
    expect(status.state).toBe('error');
    expect(status.error).not.toBeNull();
  });

  it('never creates a directory or throws on an unreadable source', () => {
    const sourceAsDir = path.join(home, 'src-dir');
    fs.mkdirSync(sourceAsDir, { recursive: true });
    const status = inspectLifecycleAsset({ sourcePath: sourceAsDir, destinationPath: path.join(home, 'd.mjs'), ownershipMarkers: MARKERS });
    expect(status.state).toBe('error');
    expect(status.error).not.toBeNull();
  });
});

describe('installLifecycleAsset — atomic install with foreign preservation', () => {
  it('installs into a missing destination and reports action=installed', () => {
    const dest = path.join(home, 'nested', 'dest.mjs');
    const spec = specWithSource(SOURCE_TEXT, dest);
    const outcome = installLifecycleAsset(spec);
    expect(outcome.state).toBe('current');
    expect(outcome.action).toBe('installed');
    expect(fs.readFileSync(dest, 'utf8')).toBe(SOURCE_TEXT);
    // No leftover temp files in the destination directory.
    expect(fs.readdirSync(path.dirname(dest)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refreshes a stale wmux-owned destination and reports action=refreshed', () => {
    const dest = path.join(home, 'dest.mjs');
    fs.writeFileSync(dest, `${CODEX_NOTIFY_MANAGED_MARKER}\n// older body\n`, 'utf8');
    const spec = specWithSource(SOURCE_TEXT, dest);
    const outcome = installLifecycleAsset(spec);
    expect(outcome.action).toBe('refreshed');
    expect(fs.readFileSync(dest, 'utf8')).toBe(SOURCE_TEXT);
  });

  it('is a no-op (action=none) when already current', () => {
    const dest = path.join(home, 'dest.mjs');
    const spec = specWithSource(SOURCE_TEXT, dest);
    fs.copyFileSync(spec.sourcePath!, dest);
    expect(installLifecycleAsset(spec).action).toBe('none');
  });

  it('NEVER overwrites a foreign destination', () => {
    const dest = path.join(home, 'dest.mjs');
    fs.writeFileSync(dest, FOREIGN_TEXT, 'utf8');
    const spec = specWithSource(SOURCE_TEXT, dest);
    const outcome = installLifecycleAsset(spec);
    expect(outcome.action).toBe('none');
    expect(outcome.state).toBe('foreign');
    expect(fs.readFileSync(dest, 'utf8')).toBe(FOREIGN_TEXT);
  });

  it('reports action=none / source-missing when the source is absent', () => {
    const dest = path.join(home, 'dest.mjs');
    const outcome = installLifecycleAsset({ sourcePath: path.join(home, 'nope.mjs'), destinationPath: dest, ownershipMarkers: MARKERS });
    expect(outcome.action).toBe('none');
    expect(outcome.state).toBe('source-missing');
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('findLifecycleAssetSourceFrom — source resolution prefers live checkout over dist', () => {
  it('prefers the integrations/ source over a stale dist build at the same level', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-find-'));
    try {
      const devFile = path.join(root, 'integrations', 'codex', 'bin', CODEX_NOTIFY_BASENAME);
      const distFile = path.join(root, 'dist', 'cli-bundle', CODEX_NOTIFY_BASENAME);
      fs.mkdirSync(path.dirname(devFile), { recursive: true });
      fs.mkdirSync(path.dirname(distFile), { recursive: true });
      fs.writeFileSync(devFile, 'dev', 'utf8');
      fs.writeFileSync(distFile, 'stale-dist', 'utf8');
      const found = findLifecycleAssetSourceFrom(root, CODEX_NOTIFY_BASENAME, ['integrations', 'codex', 'bin', CODEX_NOTIFY_BASENAME]);
      expect(found).toBe(devFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks up parent directories until a candidate is found', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-findup-'));
    try {
      const deep = path.join(root, 'a', 'b', 'c');
      fs.mkdirSync(deep, { recursive: true });
      const candidate = path.join(root, 'integrations', 'opencode', 'plugins', 'wmux.js');
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, 'x', 'utf8');
      // The opencode dev file has a DIFFERENT basename than its bundle name.
      const found = findLifecycleAssetSourceFrom(deep, 'wmux-opencode-plugin.js', ['integrations', 'opencode', 'plugins', 'wmux.js']);
      expect(found).toBe(candidate);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no candidate exists anywhere up the tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-findnull-'));
    try {
      expect(findLifecycleAssetSourceFrom(root, 'nope.mjs', ['x', 'y', 'nope.mjs'])).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveLifecycleIntegrationPaths — destination + marker wiring', () => {
  it('resolves codex + opencode destinations and carries ownership markers', () => {
    const paths = resolveLifecycleIntegrationPaths(home, home);
    expect(paths.codex.destinationPath).toBe(path.join(home, '.wmux', 'hooks', CODEX_NOTIFY_BASENAME));
    expect(paths.codex.ownershipMarkers).toContain(CODEX_NOTIFY_MANAGED_MARKER);
    expect(paths.opencode.destinationPath).toBe(path.join(home, '.config', 'opencode', 'plugins', 'wmux.js'));
    expect(paths.opencode.ownershipMarkers).toEqual([OPENCODE_PLUGIN_MANAGED_MARKER, 'wmux ↔ OpenCode plugin bridge']);
  });

  it('honors XDG_CONFIG_HOME for the opencode plugin destination', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-xdg-'));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const paths = resolveLifecycleIntegrationPaths(home, home);
      expect(paths.opencode.destinationPath.startsWith(xdg)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('ignores a relative XDG_CONFIG_HOME (falls back to ~/.config)', () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = 'relative/path';
    try {
      const paths = resolveLifecycleIntegrationPaths(home, home);
      expect(paths.opencode.destinationPath).toBe(path.join(home, '.config', 'opencode', 'plugins', 'wmux.js'));
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe('statusLifecycleIntegrations — codexNotify staleness', () => {
  function pathsWithSource(): LifecycleIntegrationPaths {
    const paths = resolveLifecycleIntegrationPaths(home, home);
    // Give the codex bridge a real source so inspect does not short-circuit.
    const src = path.join(home, 'codex-src.mjs');
    fs.writeFileSync(src, SOURCE_TEXT, 'utf8');
    paths.codex = { ...paths.codex, sourcePath: src };
    return paths;
  }

  it('marks codexNotify stale when wmux notify points at a different path', () => {
    const paths = pathsWithSource();
    writeCodexConfig(`notify = ["node", "C:\\\\some\\\\other\\\\${CODEX_NOTIFY_BASENAME}"]\n`);
    const status = statusLifecycleIntegrations(paths);
    // isWmuxOwnedNotify is true (ends with the basename), but the configured
    // path differs from the managed destination → statusLifecycleIntegrations
    // downgrades 'wmux' to 'stale'. Deterministic, not a maybe.
    expect(status.codexNotify.state).toBe('stale');
  });

  it('marks codexNotify stale when the configured script no longer exists', () => {
    const paths = pathsWithSource();
    // Point at the managed destination path, but never install the script there.
    // JSON.stringify yields a valid TOML basic string (escapes backslashes),
    // mirroring configIO.notifyLineText — do NOT pre-escape the path.
    writeCodexConfig(`notify = ["node", ${JSON.stringify(paths.codex.destinationPath)}]\n`);
    const status = statusLifecycleIntegrations(paths);
    expect(status.codexNotify.state).toBe('stale');
  });

  it('reports codexNotify wmux when the registered script exists at the managed path', () => {
    const paths = pathsWithSource();
    fs.mkdirSync(path.dirname(paths.codex.destinationPath), { recursive: true });
    fs.writeFileSync(paths.codex.destinationPath, SOURCE_TEXT, 'utf8');
    writeCodexConfig(`notify = ["node", ${JSON.stringify(paths.codex.destinationPath)}]\n`);
    const status = statusLifecycleIntegrations(paths);
    expect(status.codexNotify.state).toBe('wmux');
  });
});

describe('installLifecycleIntegrations — aggregation + codexNotify gating', () => {
  it('returns ok=false when a source is missing (fatal), and leaves codexNotify null', () => {
    // No source files resolvable from an empty home → both sources missing.
    const paths = resolveLifecycleIntegrationPaths(home, home);
    const outcome = installLifecycleIntegrations(paths);
    expect(outcome.ok).toBe(false);
    expect(outcome.codexNotify).toBeNull();
  });

  it('registers codex notify only when the codex bridge reached current', () => {
    const paths = resolveLifecycleIntegrationPaths(home, home);
    // Provide real sources for BOTH bridges so neither is source-missing (fatal).
    const codexSrc = path.join(home, 'codex-src.mjs');
    const opencodeSrc = path.join(home, 'opencode-src.js');
    fs.writeFileSync(codexSrc, SOURCE_TEXT, 'utf8');
    fs.writeFileSync(opencodeSrc, SOURCE_TEXT, 'utf8');
    paths.codex = { ...paths.codex, sourcePath: codexSrc };
    paths.opencode = { ...paths.opencode, sourcePath: opencodeSrc };
    writeCodexConfig('model = "x"\n');

    const outcome = installLifecycleIntegrations(paths);
    expect(outcome.codexBridge.state).toBe('current');
    expect(outcome.codexBridge.action).toBe('installed');
    expect(outcome.codexNotify).not.toBeNull();
    expect(outcome.codexNotify!.skipped).toBeNull();
    expect(outcome.ok).toBe(true);
  });
});
