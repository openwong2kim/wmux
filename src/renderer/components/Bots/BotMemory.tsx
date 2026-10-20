// ─── A bot's profile: what it remembers ─────────────────────────────────────
//
// The bot's own notes and the owner's profile (shared/botMemory.ts), through
// the preload bridge `electronAPI.factory.memory` (main-window IPC). Each
// store lists its entries one line each with how much of its limit is used;
// every entry has Remove, which acts at once, and a store with entries has
// Clear, which asks in place (the owner's profile is every bot's, and the
// confirm says so). The bot writes them with memory_update; the profile
// only reads, removes and clears.
import { useCallback, useEffect, useRef, useState } from 'react';
import { FOCUS_RING } from '../focusRing';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { getFactoryBotPort } from '../Room/factoryPorts';
import { InlineConfirm } from './InlineConfirm';
import type { MemoryClearRequest, MemoryReadResult, MemoryRemoveRequest, MemorySimpleResult, MemoryTarget, MemoryView } from '../../../shared/botMemory';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface BotMemoryPort {
  readonly available: boolean;
  read(botId: string): Promise<MemoryReadResult>;
  remove(req: MemoryRemoveRequest): Promise<MemorySimpleResult>;
  clear(req: MemoryClearRequest): Promise<MemorySimpleResult>;
}

const UNAVAILABLE = { ok: false as const, error: 'Memory is not available in this build.' };

function bridgePort(): BotMemoryPort {
  const api = (globalThis as { electronAPI?: { factory?: { memory?: Partial<BotMemoryPort> } } }).electronAPI;
  const b = api?.factory?.memory;
  return {
    available: !!b?.read && !!b.remove && !!b.clear,
    read: (botId) => b?.read?.(botId) ?? Promise.resolve(UNAVAILABLE),
    remove: (req) => b?.remove?.(req) ?? Promise.resolve(UNAVAILABLE),
    clear: (req) => b?.clear?.(req) ?? Promise.resolve(UNAVAILABLE),
  };
}

let port: BotMemoryPort | null = null;

export function getBotMemoryPort(): BotMemoryPort {
  port ??= bridgePort();
  return port;
}

/** Tests, or a host that wires it another way. */
export function setBotMemoryPort(next: BotMemoryPort | null): void {
  port = next;
}

/** One bot's two stores, re-read on every bot event (main pushes
 *  `memory-changed` there). */
export function useBotMemory(botId: string, p: BotMemoryPort = getBotMemoryPort()): { memory: MemoryView; user: MemoryView } | null {
  const [state, setState] = useState<{ memory: MemoryView; user: MemoryView } | null>(null);
  const reload = useCallback(() => {
    if (!p.available) return;
    p.read(botId).then((r) => {
      if (r?.ok) setState({ memory: r.memory, user: r.user });
    }, () => undefined);
  }, [p, botId]);
  useEffect(() => {
    reload();
    return getFactoryBotPort().subscribe(reload);
  }, [reload]);
  return state;
}

function MemoryStore({ store, title, clearText, t, busy, onRemove, onClear }: {
  store: MemoryView;
  title: string;
  clearText: string;
  t: T;
  busy: boolean;
  onRemove: (index: number, text: string) => void;
  onClear: () => Promise<boolean>;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  return (
    <div data-bot-memory-store={store.target}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
          {`${title} · ${t('bots.memory.usage', { used: store.used, limit: store.limit })}`}
        </span>
        {store.entries.length > 0 && !confirming && (
          <button type="button" data-testid={`bot-memory-clear-${store.target}`} disabled={busy} onClick={() => setConfirming(true)} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}>
            {t('bots.memory.clear')}
          </button>
        )}
      </div>
      {confirming && (
        <InlineConfirm
          text={clearText}
          confirmLabel={t('bots.memory.clear')}
          cancelLabel={t('room.hq.cancel')}
          busy={busy}
          onConfirm={() => { void onClear().then((done) => { if (done) setConfirming(false); }); }}
          onCancel={() => setConfirming(false)}
          testId={`bot-memory-clear-${store.target}`}
        />
      )}
      {store.entries.length === 0 && <p className="text-[var(--text-muted)]">{t(store.target === 'user' ? 'bots.memory.userEmpty' : 'bots.memory.empty')}</p>}
      <ul className="space-y-0.5">
        {store.entries.map((entry, i) => (
          <li key={`${i}:${entry}`} data-bot-memory-entry={i} className="flex items-start gap-2">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--text-main)]">{entry}</span>
            <button type="button" data-testid={`bot-memory-remove-${store.target}-${i}`} disabled={busy} onClick={() => onRemove(i, entry)} className={`shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-50 ${FOCUS_RING}`}>
              {t('bots.memory.remove')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BotMemory({ row, t, port: p = getBotMemoryPort() }: { row: FactoryBotRow; t: T; port?: BotMemoryPort }): React.ReactElement | null {
  const botId = row.bot.id;
  const stores = useBotMemory(botId, p);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One request at a time (the ref holds it between a click and the next render).
  const inFlight = useRef(false);
  if (!p.available || !stores) return null;
  const act = (run: () => Promise<MemorySimpleResult>, failed: string): Promise<boolean> => {
    if (inFlight.current) return Promise.resolve(false);
    inFlight.current = true;
    setError(null);
    setBusy(true);
    return run().then((r) => {
      if (!r.ok) setError(r.error);
      return r.ok;
    }, () => {
      setError(failed);
      return false;
    }).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };
  const remove = (target: MemoryTarget) => (index: number, text: string) => {
    void act(() => p.remove({ botId, target, index, text }), t('bots.memory.removeFailed'));
  };
  const clear = (target: MemoryTarget) => () => act(() => p.clear({ botId, target }), t('bots.memory.clearFailed'));
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-memory>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('bots.memory.label')}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <MemoryStore store={stores.memory} title={t('bots.memory.notes')} clearText={t('bots.memory.clearConfirm', { name: row.bot.name })} t={t} busy={busy} onRemove={remove('memory')} onClear={clear('memory')} />
        <MemoryStore store={stores.user} title={t('bots.memory.user')} clearText={t('bots.memory.userClearConfirm')} t={t} busy={busy} onRemove={remove('user')} onClear={clear('user')} />
        <p className="text-[11px] text-[var(--text-muted)]">{t('bots.memory.hint')}</p>
        {error && <p role="alert" className="text-[var(--accent-red)]">{error}</p>}
      </div>
    </div>
  );
}
