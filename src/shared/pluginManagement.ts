import type { PluginHostPluginSummary } from './pluginHost';

export const PLUGIN_MANAGEMENT_IPC = {
  list: 'plugins:manage-list',
  install: 'plugins:install',
  enabled: 'plugins:set-enabled',
  remove: 'plugins:remove',
  changed: 'plugins:changed',
} as const;

/**
 * Capabilities that reach what terminal programs wrote: screen text, search
 * over it, notifications carrying it, or screenshots. A plugin declaring none
 * of them cannot read terminal content.
 */
export const TERMINAL_CONTENT_CAPABILITIES: readonly string[] = ['terminal.read', 'pane.search', 'notifications.read', 'computer.observe'];

/** Glyphs a catalog entry may name for its rail item and Plugins page tile. */
export type UiPluginGlyph = 'office' | 'pulse' | 'files';

/**
 * Curated, shipped originals only. IDs never resolve arbitrary paths or URLs.
 * `signature` entries head the Plugins page; `capabilities` mirror each
 * bundle's manifest (pinned by a test) so an entry not yet installed can say
 * what it would be allowed to do.
 */
export const UI_PLUGIN_CATALOG = [{
  id: 'agent-state-page',
  name: 'Agent status',
  titleKey: 'plugins.settings.agentStatus',
  hintKey: 'plugins.settings.agentStatusHint',
  taglineKey: 'plugins.page.agentStatusTagline',
  signature: false,
  glyph: 'pulse',
  preview: 'agent-state-page',
  capabilities: ['ui.rail-page', 'agent.state.read', 'pane.read'],
  readme: 'https://github.com/openwong2kim/wmux/blob/main/examples/plugins/agent-state-page/README.md',
  publisher: 'wmux',
  license: 'MIT',
  version: '1.0.0',
  files: ['manifest.json', 'page.html', 'README.md', 'LICENSE'],
}, {
  id: 'office',
  name: 'Office',
  titleKey: 'plugins.settings.office',
  hintKey: 'plugins.settings.officeHint',
  taglineKey: 'plugins.page.officeTagline',
  signature: true,
  glyph: 'office',
  preview: 'office',
  capabilities: ['ui.rail-page', 'agent.state.read', 'agent.state.read.all', 'pane.read'],
  readme: 'https://github.com/openwong2kim/wmux/blob/main/examples/plugins/office/README.md',
  publisher: 'bluemas',
  license: 'MIT',
  version: '1.1.0',
  files: ['manifest.json', 'index.html', 'office.js', 'layout.js', 'sprites.js', 'characters.png', 'furniture.png', 'README.md', 'LICENSE'],
}, {
  id: 'commander',
  name: 'Files',
  titleKey: 'plugins.settings.commander',
  hintKey: 'plugins.settings.commanderHint',
  taglineKey: 'plugins.page.commanderTagline',
  signature: false,
  glyph: 'files',
  preview: undefined,
  capabilities: ['ui.rail-page', 'pane.read', 'fs.read', 'fs.write'],
  readme: 'https://github.com/openwong2kim/wmux/blob/main/examples/plugins/commander/README.md',
  publisher: 'wmux',
  license: 'MIT',
  version: '1.0.0',
  files: ['manifest.json', 'index.html', 'commander.js', 'README.md', 'LICENSE'],
}] as const;

export type UiPluginCatalogEntry = typeof UI_PLUGIN_CATALOG[number];

export interface InstalledUiPlugin extends PluginHostPluginSummary {
  enabled: boolean;
  managed: boolean;
  invalid?: boolean;
}

export interface UiPluginInventory {
  plugins: InstalledUiPlugin[];
  failures: Array<{ name: string; errors: string[] }>;
}
