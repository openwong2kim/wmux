// Settings → General: whether wmux installs its pre-commit secret check in
// repositories it opens (default on). Turning it off also removes the check
// and puts back any pre-commit hook the user had (main/git/secretHook.ts).
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import Switch from '../ui/Switch';
import { SettingRow, SettingNote } from './SettingsLayout';

export function SecretHookSetting() {
  const t = useT();
  const api = window.electronAPI?.github;
  const [on, setOn] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void api?.secretHookGet?.().then((r) => { if (live) { setOn(r?.autoInstall ?? true); setLoaded(true); } }, () => undefined);
    return () => { live = false; };
  }, [api]);

  const change = async (v: boolean) => {
    setOn(v);
    setFailed(false);
    try {
      const r = await api.secretHookSet(v);
      setOn(r.autoInstall);
      setFailed(r.failed.length > 0);
    } catch {
      setOn(!v);
      setFailed(true);
    }
  };

  return (
    <>
      <SettingRow id="secrethook" label={t('settings.secretHook')} description={t('settings.secretHookDesc')}>
        <Switch
          checked={on}
          onCheckedChange={(v) => { void change(v); }}
          aria-label={t('settings.secretHook')}
          disabled={!loaded}
          data-testid="secret-hook-switch"
        />
      </SettingRow>
      {failed && (
        <SettingNote tone="danger" role="alert" data-testid="secret-hook-error">
          {t('settings.secretHookFailed')}
        </SettingNote>
      )}
    </>
  );
}
