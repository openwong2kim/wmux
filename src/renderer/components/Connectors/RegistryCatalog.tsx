import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { catalogConnectorDraft, type ConnectorCatalogEntry, type ConnectorCatalogResult } from '../../../shared/connectorCatalog';
import type { ConnectorDraft } from '../../../shared/botConnector';

type Load = (search: string, cursor?: string) => Promise<ConnectorCatalogResult>;
const defaultLoad: Load = (search, cursor) => window.electronAPI?.connectorCatalog?.list(search, cursor) ?? Promise.resolve({ ok: false });
export default function RegistryCatalog({ onConfigure, canConfigure, load = defaultLoad }: { onConfigure: (draft: ConnectorDraft) => void; canConfigure: boolean; load?: Load }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [entries, setEntries] = useState<ConnectorCatalogEntry[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const request = async (search: string, next?: string) => {
    const attempt = ++generation.current;
    setLoading(true); setError(false);
    if (!next) { setEntries([]); setCursor(undefined); setSearched(search); }
    try {
      const result = await load(search, next);
      if (generation.current !== attempt) return;
      if (!result.ok) { setError(true); return; }
      setEntries((prior) => [...new Map([...(next ? prior : []), ...result.entries].map((entry) => [entry.id, entry])).values()]);
      setCursor(result.nextCursor === next ? undefined : result.nextCursor);
    } catch { if (generation.current === attempt) setError(true); }
    finally { if (generation.current === attempt) setLoading(false); }
  };
  // Discovery starts only when this component is mounted by the Discover view.
  useEffect(() => { void request(''); return () => { generation.current++; }; }, [load]);
  return <section className="flex flex-col gap-4" aria-label={t('connectors.registry')}>
    <h2 className="text-[14px] font-semibold">{t('connectors.registry')}</h2>
    <p className="text-[13px] text-[var(--text-sub)]">{t('connectors.registryHint')}</p>
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void request(query.trim()); }}>
      <Input value={query} maxLength={128} aria-label={t('connectors.registrySearch')} placeholder={t('connectors.registrySearch')} onChange={(e) => setQuery(e.target.value)} />
      <Button type="submit">{t('connectors.searchAction')}</Button>
    </form>
    {error && <div role="alert" className="flex items-center gap-2"><span>{t('connectors.registryError')}</span><Button onClick={() => void request(searched, cursor)}>{t('connectors.retry')}</Button></div>}
    {loading && <p role="status">{t('connectors.loading')}</p>}
    {!loading && !error && entries.length === 0 && <p>{t('connectors.registryEmpty')}</p>}
    <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {entries.map((entry) => <li key={entry.id} className="min-w-0 rounded-[var(--chip-radius)] bg-[var(--hover-fill)] p-4">
        <h3 className="text-[14px] font-medium">{entry.title}</h3>
        <p className="break-all text-[11px] text-[var(--text-muted)]">{entry.id} · {entry.version}</p>
        <p className="my-3 text-[13px] text-[var(--text-sub)]">{entry.description}</p>
        {entry.repository && <Button onClick={() => { if (entry.repository) void window.electronAPI?.shell?.openExternal(entry.repository).catch(() => setError(true)); }}>{t('connectors.source')}</Button>}
        {entry.remotes.length === 0 && <p className="text-[13px] text-[var(--text-sub)]">{t('connectors.manualSetup')}</p>}
        {entry.remotes.map((remote, index) => <div key={`${remote.url}-${index}`} className="mt-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{remote.url}</span>
          <Button disabled={!canConfigure} onClick={() => { const draft = catalogConnectorDraft(entry, index); if (draft) onConfigure(draft); }}>{t('connectors.reviewSetup')}</Button>
        </div>)}
      </li>)}
    </ul>
    {cursor && <Button disabled={loading} onClick={() => void request(searched, cursor)}>{t('connectors.loadMore')}</Button>}
  </section>;
}
