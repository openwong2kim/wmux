// ─── A bot's settings: its connections ──────────────────────────────────────
//
// Every enabled connection in the shared library, ticked where this bot's
// workers get it: an every-bot one unticked is turned off for this bot alone,
// one picked for some bots is ticked by adding this bot to its scope. A tick
// acts at once. Add connection opens the dialog with the scope set to this
// bot; the library itself is edited in Settings › Bots › Connections.
import { useState } from 'react';
import Checkbox from '../ui/Checkbox';
import Button from '../ui/Button';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { useFactoryBots } from '../Room/useFactoryBots';
import { getBotConnectorPort, useBotConnectors, type BotConnectorPort } from '../Room/botConnectors';
import type { ConnectorView } from '../../../shared/botConnector';
import { ConnectionDialog } from '../Settings/ConnectionDialog';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The library's enabled connections, in library order, each with whether
 *  it applies to `botId`: an every-bot one unless switched off for it, a
 *  picked one when its scope names it. Pure. */
export function profileConnections(lib: readonly ConnectorView[], botId: string): Array<{ c: ConnectorView; source: 'all' | 'bot'; on: boolean }> {
  const out: Array<{ c: ConnectorView; source: 'all' | 'bot'; on: boolean }> = [];
  for (const c of lib) {
    if (!c.enabled) continue;
    if (c.scope.kind === 'all') out.push({ c, source: 'all', on: !c.offFor.includes(botId) });
    else out.push({ c, source: 'bot', on: c.scope.botIds.includes(botId) });
  }
  return out;
}

export function BotConnections({ row, t, port = getBotConnectorPort() }: { row: FactoryBotRow; t: T; port?: BotConnectorPort }): React.ReactElement | null {
  const { connectors } = useBotConnectors(port);
  const bots = useFactoryBots(null);
  const [adding, setAdding] = useState(false);
  if (!port.available) return null;
  const botId = row.bot.id;
  const list = profileConnections(connectors, botId);
  // A picked connection gains or loses this bot in its scope (the library
  // keeps it either way).
  const setPicked = (c: ConnectorView, on: boolean) => {
    if (c.scope.kind !== 'bots') return;
    const { createdAt: _c, updatedAt: _u, offFor: _o, missingKeys: _m, ...draft } = c;
    const others = c.scope.botIds.filter((id) => id !== botId);
    void port.save({ connector: { ...draft, scope: { kind: 'bots', botIds: on ? [...others, botId] : others } } });
  };
  return (
    <div className="flex flex-col gap-2 text-[12px]" data-bots-profile-connections>
      <p className="text-[var(--text-muted)]">{t('botsPage.profile.connectionsEmpty')}</p>
      <ul className="flex flex-col gap-1.5">
        {list.map(({ c, source, on }) => (
          <li key={c.id} data-bot-connection={c.name} className="flex items-center gap-2">
            <Checkbox
              checked={on}
              aria-label={t('botsPage.profile.connectionOnForBot', { name: c.name })}
              data-testid={`bot-connection-on-${c.name}`}
              onCheckedChange={(v) => (source === 'all' ? void port.setOffForBot({ id: c.id, botId, off: !v }) : setPicked(c, v))}
            />
            <span className={`min-w-0 flex-1 truncate ${on ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>
              {c.name}
              {c.purpose && <span className="text-[var(--text-muted)]">{` · ${c.purpose}`}</span>}
              {source === 'all' && <span className="text-[var(--text-muted)]">{` · ${t('botsPage.profile.connectionAllBots')}`}</span>}
            </span>
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" variant="secondary" data-testid="bot-connection-add" onClick={() => setAdding(true)}>{t('settings.factory.connections.add')}</Button>
      </div>
      {adding && <ConnectionDialog t={t} bots={bots} presetBotId={botId} onClose={() => setAdding(false)} port={port} />}
    </div>
  );
}
