import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalCoreSettings } from '../../../shared/terminalCoreSettings';
import { useT } from '../../hooks/useT';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { SettingNote, SettingRow } from './SettingsLayout';

/** What the terminal host runs. Read-only: Rust is the only engine. A host
 *  whose Rust module does not load runs no terminals, and says why here. */
export function TerminalEngineSetting() {
  const t = useT();
  const [settings, setSettings] = useState<TerminalCoreSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
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
  const runtime = settings?.runtime ?? null;
  // An older daemon reports no `available`; it runs whatever it reports.
  const missing = runtime?.available === false;
  return <>
    <SettingRow id="terminal-engine" label={t('settings.terminalEngine')} description={t('settings.terminalEngineDesc')}>
      <Badge>{runtime ? (runtime.effective === 'rust' ? 'Rust' : 'Node') : t('settings.terminalEngineUnknown')}</Badge>
    </SettingRow>
    {missing && <SettingNote tone="danger" role="alert">
      {t('settings.terminalEngineMissing')}{runtime?.reason ? <><br /><code className="ui-code">{runtime.reason}</code></> : null}
    </SettingNote>}
    {failed && <SettingNote tone="danger" role="alert">{t('settings.terminalEngineError')}{' '}
      <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{t('settings.terminalEngineRetry')}</Button>
    </SettingNote>}
  </>;
}
