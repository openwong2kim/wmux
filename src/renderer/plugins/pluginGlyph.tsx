import type { ComponentType } from 'react';
import { UI_PLUGIN_CATALOG, type UiPluginGlyph } from '../../shared/pluginManagement';
import { IconOffice, IconPackage, IconPulse } from '../components/icons';

const GLYPHS: Record<UiPluginGlyph, ComponentType<{ size?: number }>> = {
  office: IconOffice,
  pulse: IconPulse,
};

/**
 * The glyph the catalog names for a bundle the catalog installed. A bundle
 * placed by hand under a catalog id is not that entry and gets none.
 */
export function catalogGlyph(plugin: { name: string; managed?: boolean }): UiPluginGlyph | undefined {
  if (!plugin.managed) return undefined;
  return UI_PLUGIN_CATALOG.find((entry) => entry.id === plugin.name)?.glyph;
}

/** A catalog entry's glyph; a bundle outside the catalog gets the package. */
export function PluginGlyph({ glyph, size = 16 }: { glyph: UiPluginGlyph | undefined; size?: number }) {
  const Glyph = glyph ? GLYPHS[glyph] : IconPackage;
  return <Glyph size={size} />;
}
