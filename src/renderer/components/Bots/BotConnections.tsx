// ─── A bot's profile: its connections ───────────────────────────────────────
//
// The connections from the shared library that apply to this bot: every-bot
// ones (with a switch that turns one off for this bot alone) and ones picked
// for it (Edit, Remove from this bot). Add connection opens the dialog with
// the scope set to this bot; Manage opens Settings › Bots › Connections.
import { useState } from 'react';
import Switch from '../ui/Switch';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { useFactoryBots } from '../Room/useFactoryBots';
import { getBotConnectorPort, useBotConnectors, type BotConnectorPort } from '../Room/botConnectors';
import type { ConnectorView } from '../../../shared/botConnector';
import { ConnectionDialog } from '../Settings/ConnectionDialog';
import { openFactorySettings } from './botsAddBot';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The library's connections that apply to `botId`, in library order:
 *  enabled ones scoped to every bot (switched off or not) and the ones
 *  picked for it. Pure. */
export function profileConnections(lib: readonly ConnectorView[], botId: string): Array<{ c: ConnectorView; source: 'all' | 'bot'; on: boolean }> {
  const out: Array<{ c: ConnectorView; source: 'all' | 'bot'; on: boolean }> = [];
  for (const c of lib) {
    if (!c.enabled) continue;
    if (c.scope.kind === 'all') out.push({ c, source: 'all', on: !c.offFor.includes(botId) });
    else if (c.scope.botIds.includes(botId)) out.push({ c, source: 'bot', on: true });
  }
  return out;
}

function openConnectionsSettings(): void {
  openFactorySettings();
  setTimeout(() => document.querySelector('[data-setting-id="factoryconnections"]')?.scrollIntoView({ block: 'start' }), 0);
}

export function BotConnections({ row, t, port = getBotConnectorPort() }: { row: FactoryBotRow; t: T; port?: BotConnectorPort }): React.ReactElement | null {
  const { connectors } = useBotConnectors(port);
  const bots = useFactoryBots(null);
  const [dialog, setDialog] = useState<{ editing?: ConnectorView } | null>(null);
  if (!port.available) return null;
  const botId = row.bot.id;
  const list = profileConnections(connectors, botId);
  // A picked connection loses this bot from its scope (the library keeps it).
  const removeFromBot = (c: ConnectorView) => {
    if (c.scope.kind !== 'bots') return;
    const { createdAt: _c, updatedAt: _u, offFor: _o, missingKeys: _m, ...draft } = c;
    void port.save({ connector: { ...draft, scope: { kind: 'bots', botIds: c.scope.botIds.filter((id) => id !== botId) } } });
  };
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-connections>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.connections')}</span>
      <div className="min-w-0 flex-1">
        {list.length === 0 && <p className="text-[var(--text-muted)]">{t('botsPage.profile.connectionsEmpty')}</p>}
        <ul className="space-y-0.5">
          {list.map(({ c, source, on }) => (
            <li key={c.id} data-bot-connection={c.name} className="flex items-center gap-2">
              <span className={`min-w-0 flex-1 truncate ${on ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>
                {c.name}
                {c.purpose && <span className="text-[var(--text-muted)]">{` · ${c.purpose}`}</span>}
                <span className="text-[var(--text-muted)]">{` · ${t(source === 'all' ? 'botsPage.profile.connectionAllBots' : 'botsPage.profile.connectionThisBot')}`}</span>
              </span>
              {source === 'all' ? (
                <Switch
                  checked={on}
                  aria-label={t('botsPage.profile.connectionOnForBot', { name: c.name })}
                  data-testid={`bot-connection-on-${c.name}`}
                  onCheckedChange={(v) => void port.setOffForBot({ id: c.id, botId, off: !v })}
                />
              ) : (
                <>
                  <button type="button" onClick={() => setDialog({ editing: c })} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>{t('settings.factory.connections.edit')}</button>
                  <button type="button" data-testid={`bot-connection-remove-${c.name}`} onClick={() => removeFromBot(c)} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>{t('botsPage.profile.connectionRemoveFromBot')}</button>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-1 flex items-center gap-3">
          <Button size="sm" variant="ghost" data-testid="bot-connection-add" onClick={() => setDialog({})}>{t('settings.factory.connections.add')}</Button>
          <button type="button" data-testid="bot-connection-manage" onClick={openConnectionsSettings} className={`text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}>{t('botsPage.profile.connectionsManage')}</button>
        </div>
      </div>
      {dialog && <ConnectionDialog t={t} bots={bots} editing={dialog.editing} presetBotId={dialog.editing ? undefined : botId} onClose={() => setDialog(null)} port={port} />}
    </div>
  );
}
