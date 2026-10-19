// ─── Settings › Bots: keys, and the bot the phone talks to ─────────────────
//
// Keys: the secrets bots asked for — the name, which bot's worker used it
// last and when, Delete (asked in place). Never a value: main sends names
// and use only (Room/botSecrets.ts). Re-read on every bot event (main pushes
// `secrets-changed` there).
//
// The phone's bot: a pin (factory settings `phoneBotId`), or Automatic —
// the oldest Coordinator, else the HQ room's first bot (main/factory/
// phoneBot.ts).
import { useCallback, useEffect, useState } from 'react';
import { SettingsSection, SettingNote } from './SettingsLayout';
import Button from '../ui/Button';
import Select from '../ui/Select';
import { InlineConfirm } from '../Bots/InlineConfirm';
import { useFactoryBots } from '../Room/useFactoryBots';
import { getFactoryBotPort } from '../Room/factoryPorts';
import { formatCardTime } from '../Room/roomFormat';
import { getBotSecretPort, type BotSecretPort, type SecretRow } from '../Room/botSecrets';

type T = (key: string, vars?: Record<string, string | number>) => string;

export function PhoneBotSelect({ t, value, disabled, onChange }: {
  t: T;
  value: string | undefined;
  disabled: boolean;
  onChange: (botId: string | null) => void;
}): React.ReactElement {
  const bots = useFactoryBots(null);
  return (
    <Select
      disabled={disabled}
      data-testid="factory-phone-bot"
      aria-label={t('settings.factory.phoneBot')}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{t('settings.factory.phoneBotAuto')}</option>
      {bots.map((row) => <option key={row.bot.id} value={row.bot.id}>{row.bot.name}</option>)}
    </Select>
  );
}

export function BotSecretsSection({ t, port = getBotSecretPort(), now }: { t: T; port?: BotSecretPort; now?: number }): React.ReactElement | null {
  const bots = useFactoryBots(null);
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [cannotStore, setCannotStore] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!port.available) return;
    port.list().then((r) => {
      if (!r?.ok) return;
      setRows(r.secrets);
      setCannotStore(r.cannotStore ? (r.cannotStore.code === 'basic_text' ? t('botSecret.noKeyring') : t('botSecret.noEncryption')) : null);
    }, () => undefined);
  }, [port, t]);

  useEffect(() => {
    load();
    return getFactoryBotPort().subscribe(load);
  }, [load]);

  if (!port.available) return null;
  const botName = (id: string): string => bots.find((b) => b.bot.id === id)?.bot.name || t('botSecret.unknownBot');

  const remove = async (name: string) => {
    setBusy(true);
    try {
      await port.delete(name);
    } finally {
      setBusy(false);
      setConfirming(null);
      load();
    }
  };

  return (
    <SettingsSection id="factorykeys" title={t('settings.factory.keys')} description={t('settings.factory.keysDesc')} data-testid="factory-keys">
      {cannotStore && <SettingNote tone="warning">{cannotStore}</SettingNote>}
      {rows.length === 0 && <SettingNote>{t('settings.factory.keysEmpty')}</SettingNote>}
      {rows.map((row) => (
        <div key={row.name} className="settings-row" data-factory-key={row.name}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-mono text-[13px] text-[var(--text-main)]">{row.name}</span>
            <span className="text-[11px] text-[var(--text-sub)]">
              {row.connections && row.connections.length > 0 && `${t('settings.factory.keyConnection', { names: row.connections.join(', ') })} · `}
              {!row.usable
                ? t('settings.factory.keyUnusable')
                : row.lastUsed
                  ? t('settings.factory.keyUsed', { bot: botName(row.lastUsed.botId), when: formatCardTime(row.lastUsed.at, now) })
                  : t('settings.factory.keyNeverUsed')}
            </span>
          </div>
          {confirming === row.name ? (
            <InlineConfirm
              text={t('settings.factory.keyDeleteConfirm', { name: row.name })}
              confirmLabel={t('settings.factory.keyDelete')}
              cancelLabel={t('botSecret.cancel')}
              busy={busy}
              onConfirm={() => void remove(row.name)}
              onCancel={() => setConfirming(null)}
              testId={`factory-key-${row.name}`}
            />
          ) : (
            <Button size="sm" variant="destructive" data-testid={`factory-key-delete-${row.name}`} aria-label={t('settings.factory.keyDeleteNamed', { name: row.name })} onClick={() => setConfirming(row.name)}>
              {t('settings.factory.keyDelete')}
            </Button>
          )}
        </div>
      ))}
    </SettingsSection>
  );
}
