import ConnectorTerminal from './ConnectorTerminal';
import ConnectorAuthorization from './ConnectorAuthorization';
// Catalog behavior adapted from LibreChat (MIT), revision e081b566a42d3a83b8102157bd7806cf4ff63b17.
// Reference: client/src/components/SidePanel/MCPBuilder/MCPBuilderPanel.tsx.
// Copyright (c) 2026 LibreChat. See LICENSE.LibreChat and THIRD_PARTY_NOTICES.
// Adapted to wmux navigation, state, IPC and i18n; no upstream auth stack imported.
import RegistryCatalog from './RegistryCatalog';
import type { ConnectorCheckResult } from '../../../shared/connectorCheck';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import SegmentedControl from '../ui/SegmentedControl';
import { ConnectionDialog } from '../Settings/ConnectionDialog';
import { getBotConnectorPort, type BotConnectorPort } from '../Room/botConnectors';
import { getFactoryBotPort } from '../Room/factoryPorts';
import { useFactoryBots } from '../Room/useFactoryBots';
import { CONNECTOR_PRESETS } from '../../../shared/botConnectorPresets';
import ServiceCatalog from './ServiceCatalog';
import ConnectorToolPicker from './ConnectorToolPicker';
import type { ConnectorDraft, ConnectorView } from '../../../shared/botConnector';

/** Catalog/search behavior adapted from LibreChat MCPBuilderPanel (MIT).
 * See LICENSE.LibreChat and docs/design/connector-adoption.md for provenance.
 * Stored configuration is deliberately not presented as verified connectivity.
 */
export default function ConnectorsPage({ port = getBotConnectorPort(), headingLevel = 1 }: { port?: BotConnectorPort; /** 2 inside a page that already has its h1. */ headingLevel?: 1 | 2 }) {
  const t = useT();
  const bots = useFactoryBots(null);
  const [view, setView] = useState<'mine' | 'discover'>('mine');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [checks, setChecks] = useState<Record<string, { fingerprint: string; result?: ConnectorCheckResult }>>({});
  const check = async (c: ConnectorView) => {
    const fingerprint = JSON.stringify(c);
    setChecks((prev) => ({ ...prev, [c.id]: { fingerprint } }));
    let result: ConnectorCheckResult;
    try { result = await window.electronAPI.connectorChecks.check(c.id); }
    catch { result = { status: 'failed' }; }
    if (mounted.current) setChecks((prev) => ({ ...prev, [c.id]: { fingerprint, result } }));
  };
  const [removing, setRemoving] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing?: ConnectorView; initialDraft?: ConnectorDraft } | null>(null);
  const reload = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(() => getFactoryBotPort().subscribe(reload), [reload]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    setStorageUnavailable(false);
    if (!port.available) { setLoading(false); setError(true); return; }
    void port.list().then((r) => {
      if (!alive) return;
      if (!r.ok || r.cannotStore) { setStorageUnavailable(r.ok && !!r.cannotStore); setError(true); setItems([]); }
      else setItems(r.connectors);
    }, () => { if (alive) { setError(true); setItems([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [port, revision]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((c) => `${c.name} ${c.purpose ?? ''}`.toLowerCase().includes(q));
  }, [items, query]);
  const mutate = async (action: () => Promise<{ ok: boolean }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await action();
      if (!r.ok) setError(true);
      else { setRemoving(null); reload(); }
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return (
    <section className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-7 text-[var(--text-main)]" aria-label={t('connectors.title')}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        {headingLevel === 2 ? <h2 className="text-[20px] font-semibold">{t('connectors.title')}</h2> : <h1 className="text-[20px] font-semibold">{t('connectors.title')}</h1>}
        <Button disabled={!port.available || busy || loading || error} onClick={() => setDialog({})}>{t('connectors.add')}</Button>
      </header>
      <p className="text-[13px] text-[var(--text-sub)]">{t('connectors.quick.scope')}</p>
      {window.electronAPI?.platform === 'win32' && <p className="text-[12px] text-[var(--text-sub)]">{t('connectors.access.platform')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl value={view} onValueChange={setView} ariaLabel={t('connectors.title')} options={[
          { value: 'mine', label: t('connectors.mine') }, { value: 'discover', label: t('connectors.discover') },
        ]} />
        {view === 'mine' && <Input aria-label={t('connectors.search')} placeholder={t('connectors.search')} value={query} onChange={(e) => setQuery(e.target.value)} />}
      </div>
      {error && <div role="alert" className="flex items-center gap-3 text-[var(--attention-text)]"><span>{t(storageUnavailable ? 'connectors.quick.storage' : 'connectors.error')}</span><Button onClick={reload}>{t('connectors.retry')}</Button></div>}
      {loading && <p role="status">{t('connectors.loading')}</p>}
      {!loading && view === 'mine' && !error && <ul className="flex flex-col gap-2">
        {filtered.length === 0 && <li className="text-[var(--text-muted)]">{t('connectors.empty')}</li>}
        {filtered.map((c) => {
          const checked = checks[c.id]?.fingerprint === JSON.stringify(c) ? checks[c.id] : undefined;
          return <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-[var(--chip-radius)] bg-[var(--hover-fill)] p-4">
          {/* A real basis: in this wrapping row the actions move to the next
              line before the name column gives up its width (a 0 basis let
              them squeeze it to a few px in the narrower Plugins detail). */}
          <div className="min-w-0 flex-[1_1_16rem]"><h2 className="text-[14px] font-medium">{c.name}</h2><p className="text-[12px] text-[var(--text-sub)]">{c.purpose}</p><p className="text-[11px] text-[var(--text-muted)]">{t(c.missingKeys.length ? 'connectors.missing' : c.enabled ? 'connectors.configured' : 'connectors.disabled')}</p></div>
          {c.transport === 'http' && window.electronAPI?.connectorTerminal && window.electronAPI.platform !== 'win32' && <ConnectorTerminal id={c.id} enabled={c.enabled && !!c.terminalAccess && c.terminalAccess.mode !== 'none' && (c.tools.mode === 'all' || c.tools.allowed.length > 0)} />}
          {c.transport === 'http' && <ConnectorAuthorization key={`${c.id}-${JSON.stringify(c)}`} id={c.id} endpoint={c.remote?.url} fingerprint={JSON.stringify(c)} onChange={() => setChecks((prev) => { const next = { ...prev }; delete next[c.id]; return next; })} />}
          <div role="status" className="text-[12px] text-[var(--text-sub)]">{checked && (checked.result ? checked.result.status === 'ready' ? t('connectors.checkReady', { count: checked.result.toolCount }) : t(`connectors.check.${checked.result.status}`) : t('connectors.checking'))}</div>
          <Button disabled={busy || !c.enabled || c.transport !== 'http' || (!!checked && !checked.result) || !window.electronAPI?.connectorChecks} onClick={() => void check(c)}>{t('connectors.check')}</Button>
          <Button disabled={busy} onClick={() => void mutate(() => port.setEnabled({ id: c.id, enabled: !c.enabled }))}>{t(c.enabled ? 'connectors.disable' : 'connectors.enable')}</Button>
          <Button disabled={busy} onClick={() => setDialog({ editing: c })}>{t('connectors.edit')}</Button>
          {checked?.result?.status === 'ready' && checked.result.toolNames && <ConnectorToolPicker key={`${c.id}-${checked.result.checkedAt}`} names={checked.result.toolNames} policy={c.tools} disabled={busy} onReview={(tools) => setDialog({ editing: { ...c, tools } })} />}
          {removing !== c.id ? <Button disabled={busy} onClick={() => setRemoving(c.id)}>{t('connectors.remove')}</Button> : <div className="flex items-center gap-2"><span className="text-[12px]">{t('connectors.removeHint')}</span><Button disabled={busy} onClick={() => setRemoving(null)}>{t('connectors.cancel')}</Button><Button disabled={busy} onClick={() => void mutate(() => port.remove({ id: c.id, deleteKeys: false }))}>{t('connectors.confirm')}</Button></div>}
        </li>; })}
      </ul>}
      {view === 'discover' && <><ServiceCatalog port={port} canConfigure={port.available && !loading && !error} onConfigure={(initialDraft) => setDialog({ initialDraft })} /><details><summary>{t('connectors.quick.details')}</summary><ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {CONNECTOR_PRESETS.map((p) => <li key={p.id} className="rounded-[var(--chip-radius)] bg-[var(--hover-fill)] p-4">
          <h2 className="text-[14px] font-medium">{t(p.labelKey)}</h2><p className="my-3 text-[12px] text-[var(--text-sub)]">{t(p.hintKey)}</p>
          <Button disabled={!port.available || loading || error} onClick={() => setDialog({ initialDraft: p.draft })}>{t('connectors.configure')}</Button>
        </li>)}
      </ul><RegistryCatalog canConfigure={port.available && !loading && !error} onConfigure={(initialDraft) => setDialog({ initialDraft })} /></details></>}
      {dialog && <ConnectionDialog t={t} bots={bots} editing={dialog.editing} initialDraft={dialog.initialDraft} port={port} onClose={() => { setDialog(null); reload(); }} />}
    </section>
  );
}
