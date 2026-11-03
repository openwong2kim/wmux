// Settings > Git safety: whether panes wmux or an agent opens are kept from
// inheriting credential-named environment variables (default on). Shells the
// user opens always inherit them; exec, supervised, bot and fan-out panes are
// always withheld (main/pty/credentialEnvPrefs.ts, shared/spawnKind.ts).
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import Switch from '../ui/Switch';
import { SettingRow, SettingNote } from './SettingsLayout';

export function CredentialEnvSetting() {
  const t = useT();
  const api = window.electronAPI?.github;
  const [on, setOn] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void api?.credentialEnvGet?.().then((r) => { if (live) { setOn(r?.withholdFromAgents ?? true); setLoaded(true); } }, () => undefined);
    return () => { live = false; };
  }, [api]);

  const change = async (v: boolean) => {
    setOn(v);
    setFailed(false);
    try {
      const r = await api.credentialEnvSet(v);
      setOn(r.withholdFromAgents);
    } catch {
      setOn(!v);
      setFailed(true);
    }
  };

  return (
    <>
      <SettingRow id="credentialenv" label={t('settings.credentialEnv')} description={t('settings.credentialEnvDesc')}>
        <Switch
          checked={on}
          onCheckedChange={(v) => { void change(v); }}
          aria-label={t('settings.credentialEnv')}
          disabled={!loaded}
          data-testid="credential-env-switch"
        />
      </SettingRow>
      {failed && (
        <SettingNote tone="danger" role="alert" data-testid="credential-env-error">
          {t('settings.credentialEnvFailed')}
        </SettingNote>
      )}
    </>
  );
}
