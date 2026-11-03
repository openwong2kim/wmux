import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginHostLoader } from '../PluginHostLoader';
import { UiPluginManager } from '../UiPluginManager';
import { ApprovalQueue } from '../../mcp/ApprovalQueue';
import { PluginTrustStore } from '../../mcp/PluginTrustStore';

/** Lets a test fail chosen directory renames; every other rename is real. */
const renames = vi.hoisted(() => ({ fail: null as null | ((call: number) => boolean), calls: 0 }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as typeof import('node:fs');
  return {
    ...real,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      renames.calls += 1;
      if (renames.fail?.(renames.calls)) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      return real.renameSync(from, to);
    },
  };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ui-plugin-manager-'));
  roots.push(root);
  const records = new Map<string, { name: string; status: string }>();
  const trust = {
    get: vi.fn(async (name: string) => records.get(name)),
    upsertDeclaration: vi.fn(async (name: string) => { if (!records.has(name)) records.set(name, { name, status: 'unconfirmed' }); return records.get(name); }),
    setUserDecision: vi.fn(async (name: string, status: string) => { records.set(name, { name, status }); return records.get(name); }),
  } as unknown as PluginTrustStore;
  const pluginsDir = path.join(root, 'plugins');
  const catalogDir = path.join(root, 'catalog');
  fs.mkdirSync(catalogDir);
  fs.cpSync(path.resolve('examples/plugins/agent-state-page'), path.join(catalogDir, 'agent-state-page'), { recursive: true });
  fs.cpSync(path.resolve('examples/plugins/office'), path.join(catalogDir, 'office'), { recursive: true });
  fs.cpSync(path.resolve('examples/plugins/commander'), path.join(catalogDir, 'commander'), { recursive: true });
  const loader = new PluginHostLoader(trust, pluginsDir);
  const approval = new ApprovalQueue(trust, { openPrompt: vi.fn() });
  const options = { loader, trust, approval: () => approval, pluginsDir, catalogDir, statePath: path.join(root, 'ui-plugins.json'), changed: vi.fn() };
  return { root, options, loader, trust, approval, manager: new UiPluginManager(options) };
}

it('installs the Office bundle with its scripts and sprite sheets, ungranted until approved', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('office');
  expect((await test.manager.inventory()).plugins.find((plugin) => plugin.name === 'office')).toMatchObject({ managed: true, enabled: true, trustStatus: 'denied' });
  for (const file of ['index.html', 'office.js', 'layout.js', 'sprites.js', 'characters.png', 'furniture.png']) {
    expect(test.loader.resolveBundlePath('office', file)).not.toBeNull();
  }
  await test.manager.remove('office');
  expect(test.loader.resolveBundlePath('office', 'index.html')).toBeNull();
});

it('installs without granting permissions, disables immediately and persists across restart', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('agent-state-page');
  expect((await test.manager.inventory()).plugins[0]).toMatchObject({ managed: true, enabled: true, trustStatus: 'denied' });
  expect(test.loader.resolveBundlePath('agent-state-page', 'page.html')).not.toBeNull();
  await test.trust.setUserDecision('agent-state-page', 'trusted');
  const handle = test.approval.requestApproval({ clientName: 'agent-state-page', declaredCapabilities: ['ui.rail-page'] });
  const rejected = expect(handle.resolution).rejects.toThrow('cancelled');
  await test.manager.setEnabled('agent-state-page', false);
  await rejected;
  expect(test.loader.get('agent-state-page')).toBeUndefined();
  expect(test.loader.resolveBundlePath('agent-state-page', 'page.html')).toBeNull();
  expect(await test.loader.summaries()).toEqual([]);
  const restartedLoader = new PluginHostLoader(test.trust, test.options.pluginsDir);
  const restarted = new UiPluginManager({ ...test.options, loader: restartedLoader });
  await restarted.initialize();
  expect(restartedLoader.get('agent-state-page')).toBeUndefined();
  expect((await restarted.inventory()).plugins[0]).toMatchObject({ enabled: false, trustStatus: 'trusted' });
  await restarted.setEnabled('agent-state-page', true);
  expect(restartedLoader.get('agent-state-page')).toBeDefined();
});

it('removes only a managed bundle and requires a fresh approval after reinstall', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('agent-state-page');
  await test.trust.setUserDecision('agent-state-page', 'trusted');
  await test.manager.remove('agent-state-page');
  expect(fs.existsSync(path.join(test.options.pluginsDir, 'agent-state-page'))).toBe(false);
  expect(test.loader.get('agent-state-page')).toBeUndefined();
  expect((await test.manager.inventory()).failures).toEqual([]);
  await test.manager.install('agent-state-page');
  expect((await test.manager.inventory()).plugins[0].trustStatus).toBe('denied');
});

it('retains disabled management ownership after interruption at bundle publication', async () => {
  const test = setup();
  const recovery = setup();
  await test.manager.initialize();
  const loadAll = test.loader.loadAll.bind(test.loader);
  vi.spyOn(test.loader, 'loadAll').mockImplementationOnce(async () => {
    // Snapshot the disk checkpoint immediately after rename, before final persistence.
    fs.copyFileSync(test.options.statePath, recovery.options.statePath);
    fs.cpSync(test.options.pluginsDir, recovery.options.pluginsDir, { recursive: true });
    return loadAll();
  });
  await test.manager.install('agent-state-page');
  await recovery.manager.initialize();
  expect((await recovery.manager.inventory()).plugins[0]).toMatchObject({ managed: true, enabled: false });
  expect(recovery.loader.get('agent-state-page')).toBeUndefined();
  await recovery.manager.remove('agent-state-page');
  expect(fs.existsSync(path.join(recovery.options.pluginsDir, 'agent-state-page'))).toBe(false);
});

it('rejects arbitrary IDs, traversal, duplicate installs and symlink roots without modifying targets', async () => {
  const test = setup();
  await test.manager.initialize();
  await expect(test.manager.install('../outside')).rejects.toThrow('Unknown catalog');
  await expect(test.manager.install('https://example.test/plugin')).rejects.toThrow('Unknown catalog');
  const outside = path.join(test.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, test.options.pluginsDir, 'junction');
  await expect(test.manager.install('agent-state-page')).rejects.toThrow('symlink');
  expect(fs.readdirSync(outside)).toEqual([]);
  fs.unlinkSync(test.options.pluginsDir);
  const results = await Promise.allSettled([test.manager.install('agent-state-page'), test.manager.install('agent-state-page')]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(fs.existsSync(path.join(test.options.pluginsDir, 'agent-state-page', 'page.html'))).toBe(true);
});

it('never overwrites or removes manually installed bundles', async () => {
  const test = setup();
  fs.mkdirSync(test.options.pluginsDir);
  const destination = path.join(test.options.pluginsDir, 'agent-state-page');
  fs.cpSync(path.join(test.options.catalogDir, 'agent-state-page'), destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'user content');
  await test.manager.initialize();
  await expect(test.manager.install('agent-state-page')).rejects.toThrow('already installed');
  await expect(test.manager.remove('agent-state-page')).rejects.toThrow('Only catalog-installed');
  expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('user content');
  await test.manager.setEnabled('agent-state-page', false);
  expect(test.loader.get('agent-state-page')).toBeUndefined();
});

it('fails closed on malformed persisted settings', async () => {
  const test = setup();
  fs.writeFileSync(test.options.statePath, '{bad');
  await expect(test.manager.initialize()).rejects.toThrow();
  expect(test.loader.list()).toEqual([]);
});

it('can remove a managed bundle even when its manifest is corrupt', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('agent-state-page');
  fs.writeFileSync(path.join(test.options.pluginsDir, 'agent-state-page', 'manifest.json'), '{broken');
  await test.loader.loadAll();
  expect((await test.manager.inventory()).plugins[0]).toMatchObject({ managed: true, invalid: true });
  await test.manager.remove('agent-state-page');
  expect((await test.manager.inventory()).plugins).toEqual([]);
});

describe('a catalog-installed bundle older than the shipped one', () => {
  const OLD_CAPABILITIES = ['ui.rail-page', 'agent.state.read', 'pane.read'];
  const shipped = () => JSON.parse(fs.readFileSync(path.resolve('examples/plugins/office/manifest.json'), 'utf8')) as { version: string; capabilities: string[] };

  /**
   * Startup over a data dir holding an Office installed before the update:
   * its manifest is the 1.0.0 one, approved for exactly that declaration.
   */
  async function startWith(options: { managed: boolean; version?: string }) {
    const test = setup();
    const destination = path.join(test.options.pluginsDir, 'office');
    fs.cpSync(path.join(test.options.catalogDir, 'office'), destination, { recursive: true });
    const manifestPath = path.join(destination, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...shipped(), version: options.version ?? '1.0.0', capabilities: OLD_CAPABILITIES }));
    fs.writeFileSync(path.join(destination, 'office.js'), '/* the 1.0.0 page */');
    fs.writeFileSync(test.options.statePath, JSON.stringify({ version: 1, disabled: [], managed: options.managed ? ['office'] : [] }));
    const trust = new PluginTrustStore(path.join(test.root, 'plugin-trust.json'));
    await trust.setUserDecision('office', 'trusted', OLD_CAPABILITIES);
    const loader = new PluginHostLoader(trust, test.options.pluginsDir);
    const manager = new UiPluginManager({ ...test.options, loader, trust });
    await manager.initialize();
    const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: string; capabilities: string[] };
    return { test, manager, loader, trust, destination, installed };
  }

  it('is replaced by the shipped bundle at startup, and its wider permissions are asked for again', async () => {
    const { manager, loader, trust, destination, installed } = await startWith({ managed: true });
    expect(installed).toMatchObject({ version: shipped().version, capabilities: shipped().capabilities });
    expect(installed.capabilities).toContain('agent.state.read.all');
    expect(fs.readFileSync(path.join(destination, 'office.js'))).toEqual(fs.readFileSync(path.resolve('examples/plugins/office/office.js')));
    // The approval covered the 1.0.0 declaration only.
    expect(await trust.get('office')).toMatchObject({ status: 'unconfirmed', declaredCapabilities: shipped().capabilities });
    expect(loader.get('office')?.manifest.version).toBe(shipped().version);
    expect((await manager.inventory()).plugins.find((plugin) => plugin.name === 'office')).toMatchObject({ managed: true, enabled: true, trustStatus: 'unconfirmed' });
    // Nothing half-published is left beside it.
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['office']);
  });

  it('never touches a bundle placed by hand', async () => {
    const { trust, destination, installed } = await startWith({ managed: false });
    expect(installed).toMatchObject({ version: '1.0.0', capabilities: OLD_CAPABILITIES });
    expect(fs.readFileSync(path.join(destination, 'office.js'), 'utf8')).toBe('/* the 1.0.0 page */');
    expect((await trust.get('office'))?.status).toBe('trusted');
  });

  it.each(['shipped', '9.0.0', 'not-a-version'])('leaves an installed copy at version %s alone', async (version) => {
    const { trust, destination, installed } = await startWith({ managed: true, version: version === 'shipped' ? shipped().version : version });
    expect(installed.capabilities).toEqual(OLD_CAPABILITIES);
    expect(fs.readFileSync(path.join(destination, 'office.js'), 'utf8')).toBe('/* the 1.0.0 page */');
    expect((await trust.get('office'))?.status).toBe('trusted');
  });
});

describe('a refresh that is interrupted', () => {
  /** A managed Office at 1.0.0, so startup refreshes it to the shipped bundle. */
  function oldOffice(test: ReturnType<typeof setup>, folder: string) {
    const destination = path.join(test.options.pluginsDir, folder);
    fs.cpSync(path.join(test.options.catalogDir, 'office'), destination, { recursive: true });
    const manifestPath = path.join(destination, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '1.0.0' }));
    fs.writeFileSync(path.join(destination, 'office.js'), '/* the 1.0.0 page */');
    fs.writeFileSync(test.options.statePath, JSON.stringify({ version: 1, disabled: [], managed: ['office'] }));
  }
  const shippedVersion = () => (JSON.parse(fs.readFileSync(path.resolve('examples/plugins/office/manifest.json'), 'utf8')) as { version: string }).version;
  const installedVersion = (test: ReturnType<typeof setup>) =>
    (JSON.parse(fs.readFileSync(path.join(test.options.pluginsDir, 'office', 'manifest.json'), 'utf8')) as { version: string }).version;

  it('keeps the old bundle when neither publishing nor putting it back works', async () => {
    const test = setup();
    oldOffice(test, 'office');
    // 1: park the old bundle (works). 2: publish the new one (fails). 3: put the old one back (fails).
    renames.calls = 0;
    renames.fail = (call) => call === 2 || call === 3;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await test.manager.initialize();
    } finally {
      renames.fail = null;
      warn.mockRestore();
    }
    const parked = fs.readdirSync(test.options.pluginsDir).filter((name) => name.startsWith('.retired@office@'));
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(test.options.pluginsDir, parked[0], 'office.js'), 'utf8')).toBe('/* the 1.0.0 page */');

    // The next start puts it back and refreshes it, leaving nothing beside it.
    const next = new UiPluginManager(test.options);
    await next.initialize();
    expect(installedVersion(test)).toBe(shippedVersion());
    expect(fs.readdirSync(test.options.pluginsDir)).toEqual(['office']);
  });

  it('restores a bundle parked by a refresh that stopped between its renames', async () => {
    const test = setup();
    oldOffice(test, '.retired@office@0b5e4c1a-0000-4000-8000-000000000000');
    await test.manager.initialize();
    expect(installedVersion(test)).toBe(shippedVersion());
    expect(test.loader.get('office')?.manifest.version).toBe(shippedVersion());
    expect(fs.readdirSync(test.options.pluginsDir)).toEqual(['office']);
  });

  it('keeps a parked bundle it could not restore, and restores it at the next start', async () => {
    const test = setup();
    const parkedName = '.retired@office@0b5e4c1a-0000-4000-8000-000000000001';
    oldOffice(test, parkedName);
    // The first rename of this start is the restore; make it fail.
    renames.calls = 0;
    renames.fail = (call) => call === 1;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await test.manager.initialize();
    } finally {
      renames.fail = null;
      warn.mockRestore();
    }
    expect(fs.readFileSync(path.join(test.options.pluginsDir, parkedName, 'office.js'), 'utf8')).toBe('/* the 1.0.0 page */');

    await new UiPluginManager(test.options).initialize();
    expect(installedVersion(test)).toBe(shippedVersion());
    expect(fs.readdirSync(test.options.pluginsDir)).toEqual(['office']);
  });

  it('removes what interrupted installs, removals and refreshes left, and nothing else', async () => {
    const test = setup();
    const dir = test.options.pluginsDir;
    // foo's folder is there, so its parked copy is a leftover; office's is not, so its parked copy is kept.
    fs.mkdirSync(path.join(dir, 'foo'), { recursive: true });
    for (const name of ['.install-abc', '.removed-1234', '.retired@office@5678', '.retired@foo@9']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'manifest.json'), '{}');
    }
    fs.mkdirSync(path.join(dir, '.keep-me'));
    fs.writeFileSync(path.join(dir, '.install-note'), 'a file, not a leftover folder');
    await test.manager.initialize();
    expect(fs.readdirSync(dir).sort()).toEqual(['.install-note', '.keep-me', '.retired@office@5678', 'foo']);
  });

  it('never follows a link named like a leftover', async () => {
    const test = setup();
    const outside = path.join(test.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive');
    fs.mkdirSync(test.options.pluginsDir, { recursive: true });
    // A directory junction on Windows (no privilege needed), a directory symlink elsewhere.
    fs.symlinkSync(outside, path.join(test.options.pluginsDir, '.install-link'), 'junction');
    fs.symlinkSync(outside, path.join(test.options.pluginsDir, '.retired@office@link'), 'junction');
    fs.writeFileSync(test.options.statePath, JSON.stringify({ version: 1, disabled: [], managed: ['office'] }));
    await test.manager.initialize();
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('must survive');
    // Neither link is removed or restored as the office bundle.
    expect(fs.readdirSync(test.options.pluginsDir).sort()).toEqual(['.install-link', '.retired@office@link']);
  });
});

it('installs Commander with its reviewed filesystem permissions and removes its bundle', async () => {
  const test = setup();
  await test.manager.initialize();
  await test.manager.install('commander');
  const plugin = (await test.manager.inventory()).plugins.find((p) => p.name === 'commander');
  expect(plugin).toMatchObject({ managed: true, enabled: true, trustStatus: 'denied', capabilities: ['ui.rail-page', 'pane.read', 'fs.read', 'fs.write'] });
  for (const file of ['index.html', 'commander.js', 'README.md', 'LICENSE']) expect(test.loader.resolveBundlePath('commander', file)).not.toBeNull();
  await test.manager.remove('commander');
  expect(test.loader.resolveBundlePath('commander', 'index.html')).toBeNull();
});
