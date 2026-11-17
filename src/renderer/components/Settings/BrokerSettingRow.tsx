import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import SegmentedControl from '../ui/SegmentedControl';
import { SettingNote, SettingRow } from './SettingsLayout';
import type { BrokerSetting, BrokerSettingPayload } from '../../../shared/mcpBroker';

interface BrokerSettingApi {
  brokerSetting?: () => Promise<BrokerSettingPayload>;
  setBrokerSetting?: (setting: BrokerSetting) => Promise<BrokerSettingPayload>;
}

/**
 * Settings › Claude Code › MCP servers: the shared MCP process (broker).
 * Default follows the platform, On and Off decide it; WMUX_MCP_BROKER in the
 * app's environment still wins and the row says so. A change applies from the
 * next wmux start, and the row says that too while the two differ.
 */
export function BrokerSettingRow({ api }: { api?: BrokerSettingApi }) {
  const t = useT();
  const [state, setState] = useState<BrokerSettingPayload | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api?.brokerSetting?.().then(
      (s) => { if (live) setState(s); },
      () => { if (live) setLoadFailed(true); },
    );
    return () => { live = false; };
  }, [api]);

  if (!api?.brokerSetting || !api.setBrokerSetting) return null;
  if (!state) {
    return loadFailed ? (
      <SettingRow id="mcpbroker" label={t('settings.mcpBroker')} description={t('settings.mcpBrokerUnavailable')} data-testid="settings-mcp-broker" />
    ) : null;
  }

  const change = async (setting: BrokerSetting) => {
    setError(null);
    try {
      setState(await api.setBrokerSetting!(setting));
    } catch {
      setError(t('settings.mcpBrokerSaveFailed'));
    }
  };

  const options: { value: BrokerSetting; label: string }[] = [
    { value: 'default', label: t(state.platformDefaultOn ? 'settings.mcpBrokerDefaultOn' : 'settings.mcpBrokerDefaultOff') },
    { value: 'on', label: t('settings.mcpBrokerOn') },
    { value: 'off', label: t('settings.mcpBrokerOff') },
  ];

  return (
    <>
      <SettingRow id="mcpbroker" label={t('settings.mcpBroker')} description={t('settings.mcpBrokerDesc')} data-testid="settings-mcp-broker">
        <SegmentedControl value={state.saved} options={options} onValueChange={(v) => void change(v)} ariaLabel={t('settings.mcpBroker')} />
      </SettingRow>
      {state.env !== 'unset' ? (
        <SettingNote data-testid="settings-mcp-broker-env">
          {t(state.env === 'on' ? 'settings.mcpBrokerEnvOn' : 'settings.mcpBrokerEnvOff')}
        </SettingNote>
      ) : state.next.on !== state.running.on ? (
        <SettingNote data-testid="settings-mcp-broker-restart">
          {t(state.next.on ? 'settings.mcpBrokerRestartOn' : 'settings.mcpBrokerRestartOff')}
        </SettingNote>
      ) : null}
      {state.problem && <SettingNote tone="warning">{t('settings.mcpBrokerFileProblem')}</SettingNote>}
      {error && <SettingNote tone="danger" role="alert">{error}</SettingNote>}
    </>
  );
}
