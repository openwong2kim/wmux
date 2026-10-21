import { useEffect, useState } from 'react';
import { usePlugins, refreshPlugins } from './usePlugins';
import PluginFrame from './PluginFrame';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import { catalogGlyph, PluginGlyph } from './pluginGlyph';
import { FOCUS_RING } from '../components/focusRing';

export function PluginRailNavigation({ compact }: { compact: boolean }) {
  const { plugins } = usePlugins();
  const route = useStore((s) => s.appRoute);
  const pages = plugins.filter((p) => p.contributes.railPage && p.trustStatus !== 'denied');
  if (pages.length === 0) return null;
  // Under the built-in pages, set apart by one short hairline; each carries
  // its catalog glyph (a package for a bundle the catalog did not install).
  return <><span className="wmux-nav-plugin-divider" aria-hidden="true" />{pages.map((p) => (
    <button key={p.name} type="button" className={`wmux-nav-button ${FOCUS_RING}`}
      data-sidebar-nav={`plugin:${p.name}`} title={p.contributes.railPage?.title}
      aria-label={p.contributes.railPage?.title} aria-current={route === `plugin:${p.name}` ? 'page' : undefined}
      onClick={() => useStore.getState().setAppRoute(`plugin:${p.name}`)}>
      <span className="wmux-nav-icon" aria-hidden="true"><PluginGlyph glyph={catalogGlyph(p)} size={16} /></span>
      {!compact && <span className="wmux-nav-label min-w-0 flex-1 truncate text-left">{p.contributes.railPage?.title}</span>}
    </button>
  ))}</>;
}

/** Only the selected rail page owns a frame. Trust is checked before mounting. */
export default function PluginRailPage({ name }: { name: string }) {
  const { plugins, loaded } = usePlugins();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const plugin = plugins.find((p) => p.name === name);
  const page = plugin?.contributes.railPage;
  const permitted = !!plugin?.capabilities.includes('ui.rail-page');
  useEffect(() => {
    if (!loaded || (page && permitted && plugin?.trustStatus !== 'denied')) return;
    if (useStore.getState().appRoute === `plugin:${name}`) useStore.getState().setAppRoute('workspaces');
  }, [loaded, page, permitted, plugin?.trustStatus, name]);
  if (!page || !plugin || !permitted || plugin.trustStatus === 'denied') return null;
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={page.title}>
    <header className="flex items-center justify-between px-5 py-3">
      <h1 className="text-[14px] font-medium text-[var(--text-main)]">{page.title}</h1>
      <span className="text-[11px] text-[var(--text-muted)]">{t('plugins.page.extension')}</span>
    </header>
    {plugin.trustStatus === 'trusted' ? <PluginFrame key={`${name}:${plugin.version}:${page.entry}`} pluginName={name} entry={page.entry} railPage agentStateEvents={page.agentStateEvents && plugin.capabilities.includes('agent.state.read')} className="min-h-0 flex-1" /> : (
      <div className="px-5 py-3 text-[12px] text-[var(--text-sub)]">
        <button type="button" className={`underline ${FOCUS_RING}`} disabled={busy} onClick={() => {
          setBusy(true); setFailed(false);
          void window.electronAPI.plugins.requestApproval(name).then(() => refreshPlugins())
            .catch(() => setFailed(true)).finally(() => setBusy(false));
        }}>{t('plugins.page.approve')}</button>
        {failed && <p role="alert">{t('plugins.page.approvalFailed')}</p>}
      </div>
    )}
  </section>;
}
