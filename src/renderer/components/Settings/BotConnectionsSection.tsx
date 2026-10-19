// ─── Settings › Bots › Connections — the shared connection library ─────────
//
// One row per connection: its name, the owner's purpose, who gets it (every
// bot, every bot but some, or the bots picked), "Key missing" when a key is
// not stored, the library on/off switch, Edit and Remove (asked in place,
// with "Also delete its keys"). Add connection opens the dialog. Re-read on
// every bot event (main pushes `connectors-changed` there).
import { useState } from 'react';
import { SettingsSection, SettingNote } from './SettingsLayout';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Checkbox from '../ui/Checkbox';
import { InlineConfirm } from '../Bots/InlineConfirm';
import { useFactoryBots } from '../Room/useFactoryBots';
import type { FactoryBotRow } from '../Room/factoryPorts';
import { getBotConnectorPort, useBotConnectors, type BotConnectorPort } from '../Room/botConnectors';
import { otherConnectorsUsing, type ConnectorView } from '../../../shared/botConnector';
import { ConnectionDialog } from './ConnectionDialog';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Who gets a connection, in words. Pure. */
export function connectionScopeText(c: ConnectorView, bots: readonly FactoryBotRow[], t: T): string {
  if (c.scope.kind === 'all') {
    return c.offFor.length > 0 ? t('settings.factory.connections.scopeAllOff', { count: c.offFor.length }) : t('settings.factory.connections.scopeAll');
  }
  const names = c.scope.botIds.map((id) => bots.find((b) => b.bot.id === id)?.bot.name).filter((n): n is string => !!n);
  return names.length > 0 ? names.join(', ') : t('settings.factory.connections.noBots');
}

/** Remove, asked in place: whether to delete its keys too, naming the
 *  connections that still use a key (those keys are kept). */
export function RemoveConnection({ c, all, t, port, onDone }: { c: ConnectorView; all: readonly ConnectorView[]; t: T; port: BotConnectorPort; onDone: () => void }): React.ReactElement {
  const [deleteKeys, setDeleteKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const shared = c.secrets
    .map((s) => ({ name: s.secret, users: otherConnectorsUsing(all, s.secret, c.id).map((o) => o.name) }))
    .filter((s) => s.users.length > 0);
  const remove = async () => {
    setBusy(true);
    try {
      await port.remove({ id: c.id, deleteKeys });
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid={`connection-remove-${c.name}`}>
      {c.secrets.length > 0 && (
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-main)] cursor-pointer">
          <Checkbox checked={deleteKeys} onCheckedChange={setDeleteKeys} aria-label={t('settings.factory.connections.alsoDeleteKeys')} data-testid={`connection-delete-keys-${c.name}`} />
          {t('settings.factory.connections.alsoDeleteKeys')}
        </label>
      )}
      {deleteKeys && shared.map((s) => (
        <p key={s.name} className="text-[11px] text-[var(--text-sub)]" data-connection-key-shared={s.name}>
          {t('settings.factory.connections.keyAlsoUsed', { key: s.name, names: s.users.join(', ') })}
        </p>
      ))}
      <InlineConfirm
        text={t('settings.factory.connections.removeConfirm', { name: c.name })}
        confirmLabel={t('settings.factory.connections.remove')}
        cancelLabel={t('settings.factory.cancel')}
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={onDone}
        testId={`connection-${c.name}`}
      />
    </div>
  );
}

export function BotConnectionsSection({ t, port = getBotConnectorPort() }: { t: T; port?: BotConnectorPort }): React.ReactElement | null {
  const bots = useFactoryBots(null);
  const { connectors } = useBotConnectors(port);
  const [dialog, setDialog] = useState<{ editing?: ConnectorView } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!port.available) return null;
  return (
    <SettingsSection id="factoryconnections" title={t('settings.factory.connections.section')} description={t('settings.factory.connections.sectionDesc')} data-testid="factory-connections">
      {connectors.length === 0 && <SettingNote>{t('settings.factory.connections.empty')}</SettingNote>}
      {connectors.map((c) => (
        <div key={c.id} className="settings-row gap-2" data-connection={c.name}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] text-[var(--text-main)]">
                {c.name}
                {c.purpose && <span className="text-[var(--text-muted)]">{` · ${c.purpose}`}</span>}
              </span>
              <span className="truncate text-[11px] text-[var(--text-sub)]">
                <span data-connection-scope>{connectionScopeText(c, bots, t)}</span>
                {c.missingKeys.length > 0 && <span data-connection-key-missing className="text-[var(--attention-text)]">{` · ${t('settings.factory.connections.keyMissing')}`}</span>}
              </span>
            </div>
            <Switch
              checked={c.enabled}
              aria-label={t('settings.factory.connections.enabled', { name: c.name })}
              data-testid={`connection-enabled-${c.name}`}
              onCheckedChange={(v) => void port.setEnabled({ id: c.id, enabled: v })}
            />
            <Button size="sm" variant="secondary" data-testid={`connection-edit-${c.name}`} onClick={() => { setRemoving(null); setDialog({ editing: c }); }}>
              {t('settings.factory.connections.edit')}
            </Button>
            {removing !== c.id && (
              <Button size="sm" variant="destructive" data-testid={`connection-remove-open-${c.name}`} onClick={() => setRemoving(c.id)}>
                {t('settings.factory.connections.remove')}
              </Button>
            )}
          </div>
          {removing === c.id && <RemoveConnection c={c} all={connectors} t={t} port={port} onDone={() => setRemoving(null)} />}
        </div>
      ))}
      <div className="flex justify-end px-3 py-2">
        <Button size="sm" variant="secondary" data-testid="connection-add" onClick={() => setDialog({})}>{t('settings.factory.connections.add')}</Button>
      </div>
      {dialog && <ConnectionDialog t={t} bots={bots} editing={dialog.editing} onClose={() => setDialog(null)} port={port} />}
    </SettingsSection>
  );
}
