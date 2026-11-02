import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalCoreSettings, TerminalEngine } from '../../../shared/terminalCoreSettings';
import { useT } from '../../hooks/useT';
import Select from '../ui/Select';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { SettingNote, SettingRow } from './SettingsLayout';

export function TerminalEngineSetting() {
  const t = useT();
  const [settings, setSettings] = useState<TerminalCoreSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const saving = useRef(false);
  const refreshAfterSave = useRef(false);
  const refresh = useCallback(async () => {
    if (saving.current) { refreshAfterSave.current = true; return; }
    const request = ++generation.current;
    setBusy(true);
    try {
      const result = await window.electronAPI.settings.getTerminalCore();
      if (request === generation.current) { setSettings(result); setFailed(false); }
    } catch {
      if (request === generation.current) setFailed(true);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const off = window.electronAPI.daemon?.onConnected?.(() => void refresh());
    return () => { generation.current++; off?.(); };
  }, [refresh]);
  const save = async (engine: TerminalEngine) => {
    if (saving.current) return;
    saving.current = true;
    const request = ++generation.current;
    setBusy(true);
    try {
      const result = await window.electronAPI.settings.setTerminalCore(engine);
      if (request === generation.current) { setSettings(result); setFailed(false); }
    } catch {
      if (request === generation.current) setFailed(true);
    } finally {
      saving.current = false;
      if (request === generation.current) {
        setBusy(false);
        if (refreshAfterSave.current) { refreshAfterSave.current = false; void refresh(); }
      }
    }
  };
  return <>
    <SettingRow id="terminal-engine" label={t('settings.terminalEngine')} description={t('settings.terminalEngineDesc')}>
      <Select value={settings?.selected ?? 'node'} disabled={!settings || busy || settings.environmentOverride}
        onChange={(event) => void save(event.target.value as TerminalEngine)}>
        <option value="node">Node</option>
        <option value="rust" disabled={!settings?.rustAvailable}>
          {t(['win32', 'darwin', 'linux'].includes(window.electronAPI?.platform ?? '') ? 'settings.terminalEngineRustDefault' : 'settings.terminalEngineRust')}
        </option>
      </Select>
    </SettingRow>
    <SettingNote role="status" aria-live="polite">
      {t('settings.terminalEngineCurrent')}{' '}
      <Badge>{settings?.runtime ? (settings.runtime.effective === 'rust' ? 'Rust' : 'Node') : t('settings.terminalEngineUnknown')}</Badge>
    </SettingNote>
    {settings?.environmentOverride && <SettingNote>{t('settings.terminalEngineOverride')}</SettingNote>}
    {settings && !settings.rustAvailable && <SettingNote>{t('settings.terminalEngineUnavailable')}</SettingNote>}
    {settings?.runtime?.requested === 'rust' && settings.runtime.effective === 'node' &&
      <SettingNote tone="warning">{t('settings.terminalEngineFallback')}</SettingNote>}
    {settings?.restartRequired && !settings.environmentOverride && <SettingNote>
      {t(settings.host === 'daemon' ? 'settings.terminalEngineRestartDaemon' : 'settings.terminalEngineRestartApp')}
      {settings.host === 'daemon' && <><br /><code className="ui-code">{settings.stopCommand}</code></>}
    </SettingNote>}
    {failed && <SettingNote tone="danger" role="alert">{t('settings.terminalEngineError')}{' '}
      <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{t('settings.terminalEngineRetry')}</Button>
    </SettingNote>}
  </>;
}
