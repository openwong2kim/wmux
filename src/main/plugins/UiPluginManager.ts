import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { PLUGIN_NAME_REGEX } from '../../shared/pluginHost';
import { UI_PLUGIN_CATALOG, type UiPluginInventory } from '../../shared/pluginManagement';
import type { ApprovalQueue } from '../mcp/ApprovalQueue';
import type { PluginTrustStore } from '../mcp/PluginTrustStore';
import type { PluginHostLoader } from './PluginHostLoader';
import { copyCatalogBundle } from './copyCatalogBundle';

type SavedState = { version: 1; disabled: string[]; managed: string[] };

/** Owner UI lifecycle for a finite catalog of shipped, original bundles. */
export class UiPluginManager {
  private state: SavedState = { version: 1, disabled: [], managed: [] };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    loader: PluginHostLoader;
    trust: PluginTrustStore;
    approval: () => ApprovalQueue | null;
    pluginsDir: string;
    statePath: string;
    catalogDir: string;
    changed: (name: string) => void;
  }) {}

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) as SavedState;
      if (raw.version !== 1 || !Array.isArray(raw.disabled) || !Array.isArray(raw.managed)
        || [...raw.disabled, ...raw.managed].some((name) => typeof name !== 'string' || !PLUGIN_NAME_REGEX.test(name))) {
        throw new Error('Invalid UI plugin settings');
      }
      this.state = { version: 1, disabled: [...new Set(raw.disabled)], managed: [...new Set(raw.managed)] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.options.loader.setDisabled(this.state.disabled);
    await this.options.loader.loadAll();
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.then(action);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** The catalog installed `name` (its install ledger, not the name, says so). */
  isManaged(name: string): boolean {
    return this.state.managed.includes(name);
  }

  async inventory(): Promise<UiPluginInventory> {
    await this.chain;
    const plugins = (await this.options.loader.summaries(true)).map((plugin) => ({
      ...plugin, enabled: !this.state.disabled.includes(plugin.name), managed: this.state.managed.includes(plugin.name),
    }));
    const inventory: UiPluginInventory = { plugins, failures: this.options.loader.listFailures() };
    // A corrupt or missing managed bundle must still be removable from Settings.
    for (const name of this.state.managed) {
      if (plugins.some((plugin) => plugin.name === name)) continue;
      inventory.plugins.push({ name, version: '', capabilities: [], activationEvents: [], contributes: {},
        trustStatus: 'denied', enabled: false, managed: true, invalid: true });
    }
    return inventory;
  }

  private notify(name: string): void {
    try { this.options.changed(name); } catch { /* A closing window does not undo persistence. */ }
  }

  private async persist(): Promise<void> {
    await atomicWriteJSON(this.options.statePath, this.state);
  }

  private disableNow(name: string): void {
    this.state.disabled = [...new Set([...this.state.disabled, name])];
    this.options.loader.setDisabled(this.state.disabled);
    this.options.approval()?.cancelPluginApprovals(name, 'UI plugin stopped');
    this.notify(name);
  }

  private async assertInstalled(name: unknown): Promise<string> {
    if (typeof name !== 'string' || !PLUGIN_NAME_REGEX.test(name)
      || !(await this.options.loader.summaries(true)).some((plugin) => plugin.name === name)) {
      throw new Error('Unknown UI plugin');
    }
    return name;
  }

  setEnabled(name: unknown, enabled: unknown): Promise<void> {
    return this.serialize(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid plugin state');
      const id = await this.assertInstalled(name);
      if (!enabled) {
        this.disableNow(id);
        await this.persist();
      } else {
        const previous = this.state.disabled;
        this.state.disabled = previous.filter((item) => item !== id);
        try { await this.persist(); } catch (error) { this.state.disabled = previous; throw error; }
        this.options.loader.setDisabled(this.state.disabled);
        this.notify(id);
      }
    });
  }

  /** Never follow a plugin-directory symlink for installation or removal. */
  private root(): string {
    fs.mkdirSync(this.options.pluginsDir, { recursive: true });
    if (fs.lstatSync(this.options.pluginsDir).isSymbolicLink()) throw new Error('Plugin directory must not be a symlink');
    return fs.realpathSync(this.options.pluginsDir);
  }

  install(catalogId: unknown): Promise<void> {
    return this.serialize(async () => {
      const entry = UI_PLUGIN_CATALOG.find((item) => item.id === catalogId);
      if (!entry) throw new Error('Unknown catalog entry');
      const root = this.root();
      const destination = path.join(root, entry.id);
      // lstat also catches dangling symlinks. Existing user bundles are never overwritten.
      try { fs.lstatSync(destination); throw new Error('Plugin is already installed'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const staging = fs.mkdtempSync(path.join(root, '.install-'));
      let installed = false;
      this.disableNow(entry.id);
      try {
        const sourceDirectory = path.join(this.options.catalogDir, entry.id);
        copyCatalogBundle(sourceDirectory, staging, entry.files);
        // A new installation always asks for its own approval, even after removal.
        await this.options.trust.setUserDecision(entry.id, 'denied');
        // Record ownership while disabled before publishing the bundle. If the
        // process exits mid-install, Settings can still remove the interrupted install.
        this.state.managed = [...new Set([...this.state.managed, entry.id])];
        await this.persist();
        fs.renameSync(staging, destination);
        installed = true;
        await this.options.loader.loadAll();
        if (!(await this.options.loader.summaries(true)).some((plugin) => plugin.name === entry.id)) {
          throw new Error('Catalog bundle could not be loaded');
        }
        this.state.disabled = this.state.disabled.filter((name) => name !== entry.id);
        await this.persist();
        this.options.loader.setDisabled(this.state.disabled);
        this.notify(entry.id);
      } catch (error) {
        this.disableNow(entry.id);
        if (installed) fs.rmSync(destination, { recursive: true, force: true });
        this.state.managed = this.state.managed.filter((name) => name !== entry.id);
        await this.options.loader.loadAll();
        throw error;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    });
  }

  remove(name: unknown): Promise<void> {
    return this.serialize(async () => {
      if (typeof name !== 'string' || !PLUGIN_NAME_REGEX.test(name)) throw new Error('Unknown UI plugin');
      const id = name;
      if (!this.state.managed.includes(id)) throw new Error('Only catalog-installed bundles can be removed here');
      const destination = path.join(this.root(), id);
      let present = true;
      try {
        const stat = fs.lstatSync(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid installed bundle');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        present = false;
      }
      this.disableNow(id);
      await this.persist();
      await this.options.trust.setUserDecision(id, 'denied');
      // Rename first: serving is already disabled and later scans cannot see a partial bundle.
      const retired = path.join(path.dirname(destination), `.removed-${randomUUID()}`);
      if (present) fs.renameSync(destination, retired);
      this.state.managed = this.state.managed.filter((item) => item !== id);
      try {
        await this.options.loader.loadAll();
        await this.persist();
        this.notify(id);
      } finally { fs.rmSync(retired, { recursive: true, force: true }); }
    });
  }
}
